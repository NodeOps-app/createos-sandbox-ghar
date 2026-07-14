import { env } from "cloudflare:test";
import { runnerName } from "../helpers/mocks";
import { describe, it, expect, vi } from "vitest";
import { runReaper } from "../../src/handler";

type Stub = ReturnType<typeof env.COORDINATOR.get>;
async function boot(s: Stub, jobId: number, sandboxId: string) {
  await s.recordSandboxCreated(jobId, sandboxId, runnerName(jobId));
  await s.markRunning(jobId);
}
const ids = (r: { toDestroy: { sandboxId: string }[] }) => r.toDestroy.map((t) => t.sandboxId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reaper", () => {
  it("sweep returns VMs of jobs older than the cutoff", async () => {
    const s = env.COORDINATOR.get(env.COORDINATOR.idFromName("reap-" + Math.random()));
    await s.onQueued(
      { jobId: 900, runId: 900, repoFullName: "nodeops-app/api", label: "createos" },
      "d1",
    );
    await boot(s, 900, "sb_orphan");

    // maxAge 0 → every existing row is immediately stale.
    const res = await s.sweep(Date.now() + 1, 0);
    expect(ids(res)).toContain("sb_orphan");
    // row flipped to destroying → no longer counts against the cap
    expect(await s.activeCount()).toBe(0);
  });

  it("sweep leaves fresh rows alone", async () => {
    const s = env.COORDINATOR.get(env.COORDINATOR.idFromName("reap2-" + Math.random()));
    await s.onQueued(
      { jobId: 901, runId: 901, repoFullName: "nodeops-app/api", label: "createos" },
      "d2",
    );
    await boot(s, 901, "sb_fresh");
    const res = await s.sweep(Date.now(), 3_600_000); // 1h cutoff, row is fresh
    expect(ids(res)).not.toContain("sb_fresh");
    expect(await s.activeCount()).toBe(1);
  });

  it("sweep retries unconfirmed teardowns (destroying rows)", async () => {
    const s = env.COORDINATOR.get(env.COORDINATOR.idFromName("reap3-" + Math.random()));
    await s.onQueued(
      { jobId: 903, runId: 903, repoFullName: "nodeops-app/api", label: "createos" },
      "d4",
    );
    await boot(s, 903, "sb_903");
    await s.onCompleted(903, runnerName(903)); // → destroying, but teardown NOT confirmed
    // Even a fresh cutoff must re-surface the un-torn-down VM for retry.
    const res = await s.sweep(Date.now(), 3_600_000);
    expect(ids(res)).toContain("sb_903");
  });

  it("runReaper tears down swept VMs and confirms them (singleton DO)", async () => {
    const singleton = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
    await singleton.onQueued(
      { jobId: 902, runId: 902, repoFullName: "nodeops-app/api", label: "createos" },
      "d3",
    );
    await boot(singleton, 902, "sb_902");
    // Force staleness: park it in destroying so runReaper (default 1h cutoff) still acts.
    await singleton.onCompleted(902, runnerName(902));

    const destroy = vi.fn().mockResolvedValue({ id: "sb_902", status: "destroying" });
    const getSandbox = vi.fn().mockResolvedValue({ destroy });
    // runReaper unconditionally threads deps through provisionAndRecord too,
    // for any pending job a freed slot promotes — none here, so this never
    // fires, but the type still requires createSandbox/listShapes present.
    const createSandbox = vi.fn();
    const deps = { makeClient: () => ({ getSandbox, createSandbox, listShapes: vi.fn() }) };

    await expect(runReaper(env as any, deps)).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalled();
    // Confirmed teardown clears the row; a second sweep finds nothing.
    expect(ids(await singleton.sweep(Date.now(), 3_600_000))).not.toContain("sb_902");
  });
});

/**
 * Age is measured from the moment a row is committed to boot, NOT from when its
 * job was queued. A job that waits out the cap accrues queue age it must not be
 * punished for: it would be reaped before its VM could finish booting, the
 * reconciler would re-drive it off GitHub's still-`queued` view, and it would be
 * reaped again — a livelock that only appears under the backlog the queue exists
 * to absorb. Every test here parks a job behind the cap (MAX_CONCURRENT=2) for
 * longer than the cutoff it is later judged against, so it FAILS if the age test
 * reads `created_at`.
 */
describe("age is measured from provisioning, not from queueing", () => {
  /** Fills the cap, queues `jobId` behind it, waits `waitMs`, then frees a slot. */
  async function promoteAfterWaiting(s: Stub, jobId: number, waitMs: number) {
    for (const filler of [jobId + 100, jobId + 200]) {
      await s.onQueued(
        { jobId: filler, runId: filler, repoFullName: "nodeops-app/api", label: "createos" },
        `fill-${filler}`,
      );
      await boot(s, filler, `sb_fill_${filler}`);
    }
    await s.onQueued(
      { jobId, runId: jobId, repoFullName: "nodeops-app/api", label: "createos" },
      `d-${jobId}`,
    );
    expect(await s.activeCount()).toBe(2); // the job is pending, not active

    await sleep(waitMs);

    // Completing a filler frees the slot the pending job is promoted into.
    const { nextPending } = await s.onCompleted(jobId + 100, runnerName(jobId + 100));
    expect(nextPending?.jobId).toBe(jobId);
  }

  it("reapUnregistered spares a just-promoted job that waited out the grace window", async () => {
    const s = env.COORDINATOR.get(env.COORDINATOR.idFromName("age1-" + Math.random()));
    await promoteAfterWaiting(s, 910, 300);
    // Mid-boot: the VM exists, its runner has not registered yet.
    await s.recordSandboxCreated(910, "sb_910", runnerName(910));

    // Grace 200ms: the job queued 300ms ago but has been provisioning for ~0ms.
    const res = await s.reapUnregistered(Date.now(), [], 200);
    expect(ids(res)).not.toContain("sb_910");
  });

  it("sweep spares a just-promoted job that waited out the max-age window", async () => {
    const s = env.COORDINATOR.get(env.COORDINATOR.idFromName("age2-" + Math.random()));
    await promoteAfterWaiting(s, 920, 300);
    await boot(s, 920, "sb_920");

    const res = await s.sweep(Date.now(), 200);
    expect(ids(res)).not.toContain("sb_920");
  });

  it("still reaps a promoted job once it is genuinely stale", async () => {
    const s = env.COORDINATOR.get(env.COORDINATOR.idFromName("age3-" + Math.random()));
    await promoteAfterWaiting(s, 930, 10);
    await boot(s, 930, "sb_930");

    // The clock reset must not make a promoted row immortal, only younger.
    const res = await s.sweep(Date.now() + 1, 0);
    expect(ids(res)).toContain("sb_930");
  });
});
