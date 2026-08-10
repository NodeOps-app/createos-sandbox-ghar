import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runnerName } from "../helpers/mocks";

type Stub = ReturnType<typeof env.COORDINATOR.get>;

const job = (jobId: number) => ({
  jobId,
  runId: jobId,
  repoFullName: "nodeops-app/api",
  label: "createos",
  tenant: null,
});

async function seeded(jobId: number, sandboxId: string): Promise<Stub> {
  const stub = env.COORDINATOR.get(
    env.COORDINATOR.idFromName(`retirement-${jobId}-${Math.random()}`),
  );
  await stub.onQueued(job(jobId), `delivery-${jobId}`);
  await stub.recordSandboxCreated(jobId, sandboxId, runnerName(jobId), "default");
  return stub;
}

async function expectDestroyingRetry(stub: Stub, jobId: number, sandboxId: string): Promise<void> {
  expect(await stub.activeCount()).toBe(0);
  expect(await stub.liveJobIds()).toContain(jobId);
  const retry = await stub.sweep(Date.now(), 3_600_000);
  expect(retry.toDestroy).toContainEqual({ jobId, sandboxId, tenantId: null, region: "default" });
  await stub.markDestroyed(jobId);
  expect(await stub.liveJobIds()).not.toContain(jobId);
}

describe("canonical Coordinator row retirement", () => {
  it("retires completion through runner identity", async () => {
    const stub = await seeded(960, "sb-960");
    await stub.markRunning(960);

    const result = await stub.onCompleted(960, runnerName(960));

    expect(result.toDestroy).toEqual({
      jobId: 960,
      sandboxId: "sb-960",
      tenantId: null,
      region: "default",
    });
    await expectDestroyingRetry(stub, 960, "sb-960");
  });

  it("retires a provision failure with a recorded VM", async () => {
    const stub = await seeded(961, "sb-961");

    const result = await stub.markProvisionFailed(961);

    expect(result.toDestroy).toEqual({
      jobId: 961,
      sandboxId: "sb-961",
      tenantId: null,
      region: "default",
    });
    await expectDestroyingRetry(stub, 961, "sb-961");
  });

  it("retires an unregistered Runner after grace", async () => {
    const stub = await seeded(962, "sb-962");
    await stub.markRunning(962);

    const result = await stub.reapUnregistered(Date.now() + 1, [], 0);

    expect(result.toDestroy).toContainEqual({
      jobId: 962,
      sandboxId: "sb-962",
      tenantId: null,
      region: "default",
    });
    await expectDestroyingRetry(stub, 962, "sb-962");
  });

  it("retires an active row after maximum age", async () => {
    const stub = await seeded(963, "sb-963");
    await stub.markRunning(963);

    const result = await stub.sweep(Date.now() + 1, 0);

    expect(result.toDestroy).toContainEqual({
      jobId: 963,
      sandboxId: "sb-963",
      tenantId: null,
      region: "default",
    });
    await expectDestroyingRetry(stub, 963, "sb-963");
  });

  it("re-queues a VM-less row for retry without inventing teardown", async () => {
    const stub = env.COORDINATOR.get(
      env.COORDINATOR.idFromName(`retirement-empty-${Math.random()}`),
    );
    await stub.onQueued(job(964), "delivery-964");

    const result = await stub.markProvisionFailed(964);

    // Nothing to destroy (no VM was created), the slot is freed, and the row
    // SURVIVES as pending so the next tick's drain retries it — dropping it left
    // the budget-bound recovery scan as the only way back.
    expect(result.toDestroy).toBeNull();
    expect(result.nextPending).toBeNull(); // never re-promotes itself in the same call
    expect(await stub.activeCount()).toBe(0);
    expect(await stub.liveJobIds()).toContain(964);

    // The retry: a cron tick's drain pulls the parked row back into provisioning.
    const tick = await stub.sweep(Date.now(), 3_600_000);
    expect(tick.nextPending.map((j) => j.jobId)).toContain(964);
  });

  it("drops a VM-less row once its retry budget is spent", async () => {
    const stub = env.COORDINATOR.get(
      env.COORDINATOR.idFromName(`retirement-budget-${Math.random()}`),
    );
    await stub.onQueued(job(965), "delivery-965");

    // MAX_PROVISION_ATTEMPTS = 3: two failures re-queue, the third gives up. Each
    // retry is re-promoted by the drain the way a real cron tick would.
    await stub.markProvisionFailed(965);
    expect(await stub.liveJobIds()).toContain(965);
    await stub.sweep(Date.now(), 3_600_000);
    await stub.markProvisionFailed(965);
    expect(await stub.liveJobIds()).toContain(965);
    await stub.sweep(Date.now(), 3_600_000);
    await stub.markProvisionFailed(965);

    expect(await stub.liveJobIds()).not.toContain(965);
  });
});
