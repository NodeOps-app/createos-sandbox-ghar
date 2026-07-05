import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function stub(name: string) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(name));
}
const job = (id: number) => ({ jobId: id, runId: id, repoFullName: "nodeops-app/api" });

describe("concurrency cap (MAX_CONCURRENT=2)", () => {
  it("queues past the cap, dequeues on completion", async () => {
    const s = stub("cap-" + Math.random());
    expect((await s.onQueued(job(1), "d1")).action).toBe("provision");
    await s.markRunning(1, "sb1");
    expect((await s.onQueued(job(2), "d2")).action).toBe("provision");
    await s.markRunning(2, "sb2");
    expect((await s.onQueued(job(3), "d3")).action).toBe("queued"); // at cap
    expect(await s.activeCount()).toBe(2);

    const res = await s.onCompleted(1);
    expect(res.sandboxIdToDestroy).toBe("sb1");
    expect(res.nextPending?.jobId).toBe(3); // slot freed → dequeue pending
  });

  it("under cap: second job still provisions", async () => {
    const s = stub("cap2-" + Math.random());
    expect((await s.onQueued(job(10), "e1")).action).toBe("provision");
    await s.markRunning(10, "sbA");
    expect((await s.onQueued(job(11), "e2")).action).toBe("provision");
  });
});
