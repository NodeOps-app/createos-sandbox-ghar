import { env } from "cloudflare:test";
import { runnerName } from "../helpers/mocks";
import { describe, it, expect } from "vitest";

function stub(name: string) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(name));
}

const job = (id: number) => ({
  jobId: id,
  runId: id,
  repoFullName: "nodeops-app/api",
  label: "createos",
  tenant: null,
});

/**
 * ADR-0003 — teardown keys on runner identity, not the provisioning job id.
 *
 * An ephemeral runner takes the FIRST matching queued job, which under a
 * backlog need not be the job whose webhook provisioned that runner's VM. So
 * the `completed` payload can pair job B with the runner that job A booted.
 *
 * Every other suite boots each job with its own runner, which makes
 * #rowByRunner and #rowByJob resolve to the SAME row — the one condition under
 * which keying on the wrong one is invisible. These tests cross the wires so
 * the two lookups return DIFFERENT rows, which is the only way the invariant
 * can actually be observed.
 */
describe("teardown by runner identity (ADR-0003)", () => {
  it("destroys the VM whose runner ran the job, not the VM that job provisioned", async () => {
    const s = stub("backlog-" + Math.random());

    // Two jobs, two VMs: job 1's runner lives on sb-1, job 2's on sb-2.
    await s.onQueued(job(1), "d1");
    await s.recordSandboxCreated(1, "sb-1", runnerName(1));
    await s.markRunning(1);

    await s.onQueued(job(2), "d2");
    await s.recordSandboxCreated(2, "sb-2", runnerName(2));
    await s.markRunning(2);

    // Backlog reassignment: job 1's runner (on sb-1) picks up job 2's work, so
    // GitHub's completed payload pairs jobId 2 with job 1's runner.
    // #rowByRunner(runnerName(1)) → row 1; #rowByJob(2) → row 2. They diverge here.
    const res = await s.onCompleted(2, runnerName(1));

    // Must tear down sb-1 — the VM that actually ran job 2.
    expect(res.toDestroy).toEqual({ jobId: 1, sandboxId: "sb-1", tenantId: null });

    // Keying on job_id would destroy sb-2, which is still busy running job 1's
    // work. That is the wrong-VM teardown ADR-0003 exists to prevent.
    expect(res.toDestroy?.sandboxId).not.toBe("sb-2");
  });

  it("tears each crossed VM down exactly once, leaving no row behind", async () => {
    const s = stub("backlog-full-" + Math.random());

    await s.onQueued(job(1), "c1");
    await s.recordSandboxCreated(1, "sb-1", runnerName(1));
    await s.markRunning(1);

    await s.onQueued(job(2), "c2");
    await s.recordSandboxCreated(2, "sb-2", runnerName(2));
    await s.markRunning(2);

    // Wires crossed both ways: job 1's runner ran job 2, job 2's ran job 1.
    const first = await s.onCompleted(2, runnerName(1));
    expect(first.toDestroy).toEqual({ jobId: 1, sandboxId: "sb-1", tenantId: null });
    await s.markDestroyed(1);

    // sb-2 must still be tracked — completing job 2 must not have freed it.
    expect(await s.activeCount()).toBe(1);

    const second = await s.onCompleted(1, runnerName(2));
    expect(second.toDestroy).toEqual({ jobId: 2, sandboxId: "sb-2", tenantId: null });
    await s.markDestroyed(2);

    // Both VMs destroyed, both rows gone: no leak, no double-destroy.
    expect(await s.activeCount()).toBe(0);
  });

  it("falls back to job id when the payload carries no runner name", async () => {
    const s = stub("no-runner-" + Math.random());

    await s.onQueued(job(7), "n1");
    await s.recordSandboxCreated(7, "sb-7", runnerName(7));
    await s.markRunning(7);

    // Cancelled-before-pickup: GitHub sends no runner_name, so job id is the
    // only owner available and the fallback must still find the row.
    const res = await s.onCompleted(7);
    expect(res.toDestroy).toEqual({ jobId: 7, sandboxId: "sb-7", tenantId: null });
  });
});
