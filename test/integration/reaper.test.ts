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
