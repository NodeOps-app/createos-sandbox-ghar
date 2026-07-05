import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function stub() {
  const id = env.COORDINATOR.idFromName("t-" + Math.random());
  return env.COORDINATOR.get(id);
}
const job = (jobId: number) => ({ jobId, runId: jobId * 10, repoFullName: "nodeops-app/api" });

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
    await s.markRunning(2, "sb_2");
    const res = await s.onCompleted(2);
    expect(res.sandboxIdToDestroy).toBe("sb_2");
    expect(await s.activeCount()).toBe(0);
  });

  it("completed on a never-booted job returns null sandbox", async () => {
    const s = stub();
    await s.onQueued(job(3), "d1");
    const res = await s.onCompleted(3);
    expect(res.sandboxIdToDestroy).toBeNull();
  });
});

describe("Coordinator cancellation + redelivery", () => {
  const job = (jobId: number) => ({ jobId, runId: jobId, repoFullName: "nodeops-app/api" });
  function stub() {
    return env.COORDINATOR.get(env.COORDINATOR.idFromName("cancel-" + Math.random()));
  }

  it("cancelled-before-boot: completed drops the pending row, no VM", async () => {
    const s = stub();
    await s.onQueued(job(10), "d1"); // provisioning (never booted)
    const res = await s.onCompleted(10); // cancelled arrives before markRunning
    expect(res.sandboxIdToDestroy).toBeNull();
    expect(await s.activeCount()).toBe(0);
  });

  it("redelivered completed is a safe no-op", async () => {
    const s = stub();
    await s.onQueued(job(11), "d1");
    await s.markRunning(11, "sb11");
    const first = await s.onCompleted(11);
    expect(first.sandboxIdToDestroy).toBe("sb11");
    const second = await s.onCompleted(11); // redelivery
    expect(second.sandboxIdToDestroy).toBeNull(); // row already gone
  });
});
