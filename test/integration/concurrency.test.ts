import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function stub(name: string) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(name));
}
const job = (id: number) => ({ jobId: id, runId: id, repoFullName: "nodeops-app/api" });

async function boot(s: ReturnType<typeof stub>, jobId: number, sandboxId: string) {
  await s.recordSandboxCreated(jobId, sandboxId, `ghar-${jobId}`);
  await s.markRunning(jobId);
}

describe("concurrency cap (MAX_CONCURRENT=2)", () => {
  it("queues past the cap, dequeues on completion", async () => {
    const s = stub("cap-" + Math.random());
    expect((await s.onQueued(job(1), "d1")).action).toBe("provision");
    await boot(s, 1, "sb1");
    expect((await s.onQueued(job(2), "d2")).action).toBe("provision");
    await boot(s, 2, "sb2");
    expect((await s.onQueued(job(3), "d3")).action).toBe("queued"); // at cap
    expect(await s.activeCount()).toBe(2);

    const res = await s.onCompleted(1, "ghar-1");
    expect(res.toDestroy).toEqual({ jobId: 1, sandboxId: "sb1" });
    expect(res.nextPending?.jobId).toBe(3); // slot freed → dequeue pending
  });

  it("under cap: second job still provisions", async () => {
    const s = stub("cap2-" + Math.random());
    expect((await s.onQueued(job(10), "e1")).action).toBe("provision");
    await boot(s, 10, "sbA");
    expect((await s.onQueued(job(11), "e2")).action).toBe("provision");
  });

  it("provision failure frees the slot and pulls the next pending job forward", async () => {
    const s = stub("fail-" + Math.random());
    await s.onQueued(job(20), "f1");
    await boot(s, 20, "sb20"); // running
    await s.onQueued(job(21), "f2"); // provisioning — boot still in flight
    expect((await s.onQueued(job(22), "f3")).action).toBe("queued"); // at cap (20 + 21)

    const res = await s.markProvisionFailed(21); // job 21 boot threw mid-provision
    expect(res.nextPending?.jobId).toBe(22); // slot freed → 22 promoted
    expect(await s.activeCount()).toBe(2); // 20 running + 22 provisioning
  });
});
