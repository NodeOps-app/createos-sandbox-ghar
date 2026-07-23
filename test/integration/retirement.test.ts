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
  await stub.recordSandboxCreated(jobId, sandboxId, runnerName(jobId));
  return stub;
}

async function expectDestroyingRetry(stub: Stub, jobId: number, sandboxId: string): Promise<void> {
  expect(await stub.activeCount()).toBe(0);
  expect(await stub.liveJobIds()).toContain(jobId);
  const retry = await stub.sweep(Date.now(), 3_600_000);
  expect(retry.toDestroy).toContainEqual({ jobId, sandboxId });
  await stub.markDestroyed(jobId);
  expect(await stub.liveJobIds()).not.toContain(jobId);
}

describe("canonical Coordinator row retirement", () => {
  it("retires completion through runner identity", async () => {
    const stub = await seeded(960, "sb-960");
    await stub.markRunning(960);

    const result = await stub.onCompleted(960, runnerName(960));

    expect(result.toDestroy).toEqual({ jobId: 960, sandboxId: "sb-960" });
    await expectDestroyingRetry(stub, 960, "sb-960");
  });

  it("retires a provision failure with a recorded VM", async () => {
    const stub = await seeded(961, "sb-961");

    const result = await stub.markProvisionFailed(961);

    expect(result.toDestroy).toEqual({ jobId: 961, sandboxId: "sb-961" });
    await expectDestroyingRetry(stub, 961, "sb-961");
  });

  it("retires an unregistered Runner after grace", async () => {
    const stub = await seeded(962, "sb-962");
    await stub.markRunning(962);

    const result = await stub.reapUnregistered(Date.now() + 1, [], 0);

    expect(result.toDestroy).toContainEqual({ jobId: 962, sandboxId: "sb-962" });
    await expectDestroyingRetry(stub, 962, "sb-962");
  });

  it("retires an active row after maximum age", async () => {
    const stub = await seeded(963, "sb-963");
    await stub.markRunning(963);

    const result = await stub.sweep(Date.now() + 1, 0);

    expect(result.toDestroy).toContainEqual({ jobId: 963, sandboxId: "sb-963" });
    await expectDestroyingRetry(stub, 963, "sb-963");
  });

  it("deletes a VM-less row without inventing teardown", async () => {
    const stub = env.COORDINATOR.get(
      env.COORDINATOR.idFromName(`retirement-empty-${Math.random()}`),
    );
    await stub.onQueued(job(964), "delivery-964");

    const result = await stub.markProvisionFailed(964);

    expect(result.toDestroy).toBeNull();
    expect(await stub.liveJobIds()).not.toContain(964);
  });
});
