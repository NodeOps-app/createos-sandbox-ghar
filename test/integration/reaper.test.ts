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
    const deps = {
      makeClient: () => ({
        getSandbox,
        createSandbox,
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    };

    await expect(runReaper(env as any, deps)).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalled();
    // Confirmed teardown clears the row; a second sweep finds nothing.
    expect(ids(await singleton.sweep(Date.now(), 3_600_000))).not.toContain("sb_902");
  });
});

/**
 * A provision that fails AFTER its VM exists must leave a durable teardown
 * record. Deleting the row instead — as this used to — threw away the only trace
 * of a live VM, and since its runner never launched it never self-deletes: the
 * VM would burn capacity forever, invisibly. `destroying` is the retry state the
 * reaper already knows how to drain.
 */
async function queued(s: Stub, jobId: number) {
  await s.onQueued(
    { jobId, runId: jobId, repoFullName: "nodeops-app/api", label: "createos" },
    `pf-${jobId}`,
  );
}

describe("markProvisionFailed disposes of the VM it left behind", () => {
  it("parks a row that owns a VM in destroying, and frees its slot", async () => {
    const s = env.COORDINATOR.get(env.COORDINATOR.idFromName("pf1-" + Math.random()));
    await queued(s, 940);
    await s.recordSandboxCreated(940, "sb_940", runnerName(940));

    const { toDestroy } = await s.markProvisionFailed(940, "sb_940");

    expect(toDestroy).toEqual({ jobId: 940, sandboxId: "sb_940" });
    expect(await s.activeCount()).toBe(0); // destroying does not hold a slot
    // The row survives, so an unconfirmed teardown is retried rather than lost.
    expect(ids(await s.sweep(Date.now(), 3_600_000))).toContain("sb_940");
  });

  it("persists a VM the DO never learned about (recordSandboxCreated is what failed)", async () => {
    const s = env.COORDINATOR.get(env.COORDINATOR.idFromName("pf2-" + Math.random()));
    await queued(s, 941); // row exists, but sandbox_id was never recorded

    const { toDestroy } = await s.markProvisionFailed(941, "sb_941");

    expect(toDestroy).toEqual({ jobId: 941, sandboxId: "sb_941" });
    expect(ids(await s.sweep(Date.now(), 3_600_000))).toContain("sb_941");
  });

  it("still drops a row that never got a VM", async () => {
    const s = env.COORDINATOR.get(env.COORDINATOR.idFromName("pf3-" + Math.random()));
    await queued(s, 942);

    const { toDestroy } = await s.markProvisionFailed(942);

    expect(toDestroy).toBeNull();
    expect(await s.activeCount()).toBe(0);
    expect(await s.liveJobIds()).not.toContain(942);
  });

  it("hands back a VM whose row a raced completed already dropped", async () => {
    const s = env.COORDINATOR.get(env.COORDINATOR.idFromName("pf4-" + Math.random()));
    await queued(s, 943);
    await s.onCompleted(943); // cancelled mid-create → row gone, no VM known

    // The Worker still holds a live VM. Nothing to persist against, but it must
    // come back to be destroyed rather than be silently forgotten.
    const { toDestroy } = await s.markProvisionFailed(943, "sb_943");
    expect(toDestroy).toEqual({ jobId: 943, sandboxId: "sb_943" });
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
