import { env } from "cloudflare:test";
import { runnerName } from "../helpers/mocks";
import { describe, it, expect } from "vitest";

function stub() {
  const id = env.COORDINATOR.idFromName("t-" + Math.random());
  return env.COORDINATOR.get(id);
}
const job = (jobId: number) => ({
  jobId,
  runId: jobId * 10,
  repoFullName: "nodeops-app/api",
  label: "createos",
  tenant: null,
});

/** Drives a provisioning row to `running`, the way the Worker does post-boot. */
async function boot(s: ReturnType<typeof stub>, jobId: number, sandboxId: string) {
  const dec = await s.recordSandboxCreated(jobId, sandboxId, runnerName(jobId));
  expect(dec.action).toBe("launch");
  await s.markRunning(jobId);
}

describe("Coordinator idempotency", () => {
  it("dedups a re-queued job id", async () => {
    const s = stub();
    expect((await s.onQueued(job(1), "d1")).action).toBe("provision");
    expect((await s.onQueued(job(1), "d2")).action).toBe("ignore");
    expect(await s.activeCount()).toBe(1);
  });

  it("completed destroys the booted VM and clears the row", async () => {
    const s = stub();
    await s.onQueued(job(2), "d1");
    await boot(s, 2, "sb_2");
    const res = await s.onCompleted(2, runnerName(2));
    expect(res.toDestroy).toEqual({ jobId: 2, sandboxId: "sb_2", tenantId: null });
    expect(await s.activeCount()).toBe(0); // slot freed even before teardown confirmed
    await s.markDestroyed(2);
  });

  it("completed on a never-booted job returns null sandbox", async () => {
    const s = stub();
    await s.onQueued(job(3), "d1");
    const res = await s.onCompleted(3);
    expect(res.toDestroy).toBeNull();
  });
});

describe("Coordinator sandbox ownership (create → record → launch)", () => {
  it("recordSandboxCreated says destroy when the job already completed", async () => {
    const s = stub();
    await s.onQueued(job(20), "d1"); // provisioning
    await s.onCompleted(20); // cancelled before the VM was recorded → row dropped
    // The in-flight createSandbox now reports its VM: nobody owns it → destroy.
    const dec = await s.recordSandboxCreated(20, "sb_orphan", runnerName(20));
    expect(dec.action).toBe("destroy");
    expect(await s.activeCount()).toBe(0);
  });

  it("completed after the VM is recorded tears it down (no leak)", async () => {
    const s = stub();
    await s.onQueued(job(21), "d1");
    const dec = await s.recordSandboxCreated(21, "sb_21", runnerName(21));
    expect(dec.action).toBe("launch");
    // completed arrives before markRunning — the recorded VM must still be destroyed.
    const res = await s.onCompleted(21, runnerName(21));
    expect(res.toDestroy).toEqual({ jobId: 21, sandboxId: "sb_21", tenantId: null });
    await s.markRunning(21); // late no-op: row is already destroying
    expect(await s.activeCount()).toBe(0);
  });
});

describe("Coordinator cancellation + redelivery", () => {
  const job = (jobId: number) => ({
    jobId,
    runId: jobId,
    repoFullName: "nodeops-app/api",
    label: "createos",
    tenant: null,
  });
  function stub() {
    return env.COORDINATOR.get(env.COORDINATOR.idFromName("cancel-" + Math.random()));
  }

  it("cancelled-before-boot: completed drops the pending row, no VM", async () => {
    const s = stub();
    await s.onQueued(job(10), "d1"); // provisioning (never booted)
    const res = await s.onCompleted(10); // cancelled arrives before boot
    expect(res.toDestroy).toBeNull();
    expect(await s.activeCount()).toBe(0);
  });

  it("redelivered completed is a safe no-op", async () => {
    const s = stub();
    await s.onQueued(job(11), "d1");
    const dec = await s.recordSandboxCreated(11, "sb11", runnerName(11));
    expect(dec.action).toBe("launch");
    await s.markRunning(11);
    const first = await s.onCompleted(11, runnerName(11));
    expect(first.toDestroy).toEqual({ jobId: 11, sandboxId: "sb11", tenantId: null });
    const second = await s.onCompleted(11, runnerName(11)); // redelivery (teardown still pending)
    expect(second.toDestroy).toBeNull(); // row already destroying
  });
});
