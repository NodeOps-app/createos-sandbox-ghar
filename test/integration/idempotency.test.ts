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
