import { env, runInDurableObject } from "cloudflare:test";
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
});

async function boot(s: ReturnType<typeof stub>, jobId: number, sandboxId: string) {
  await s.recordSandboxCreated(jobId, sandboxId, runnerName(jobId));
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

    const res = await s.onCompleted(1, runnerName(1));
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

  it("a job queued at the cap dequeues with its label intact", async () => {
    const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));

    // MAX_CONCURRENT is 2 in vitest.config.ts — fill both slots.
    await co.onQueued({ jobId: 901, runId: 1, repoFullName: "o/r", label: "createos" }, "d-901");
    await co.onQueued({ jobId: 902, runId: 1, repoFullName: "o/r", label: "createos" }, "d-902");

    const third = await co.onQueued(
      { jobId: 903, runId: 1, repoFullName: "o/r", label: "createos-8vcpu-16gb" },
      "d-903",
    );
    expect(third.action).toBe("queued");

    // Free a slot; the promoted job must still carry its shaped label.
    const { nextPending } = await co.onCompleted(901);
    expect(nextPending?.jobId).toBe(903);
    expect(nextPending?.label).toBe("createos-8vcpu-16gb");
  });

  it("a pre-migration row (label=NULL) dequeues with the default RUNNER_LABEL", async () => {
    const s = stub("null-label-" + Math.random());

    // Fill both slots so the seeded row must wait as pending.
    expect((await s.onQueued(job(51), "n1")).action).toBe("provision");
    await boot(s, 51, "sb51");
    expect((await s.onQueued(job(52), "n2")).action).toBe("provision");
    await boot(s, 52, "sb52");

    // Seed a row the way it would exist pre-migration: written straight to
    // SQLite (not through onQueued, which always supplies a label) with a
    // literal NULL label, as every production row will have on next deploy.
    await runInDurableObject(s, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO jobs (job_id, run_id, repo, sandbox_id, runner_name, label, state, created_at, booted_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, 'pending', ?, NULL)`,
        53,
        53,
        "nodeops-app/api",
        Date.now(),
      );
    });

    // Free a slot; the seeded row must be the one promoted (oldest pending).
    const res = await s.onCompleted(51, runnerName(51));
    expect(res.nextPending?.jobId).toBe(53);
    expect(res.nextPending?.label).toBe("createos"); // coalesced from RUNNER_LABEL
    expect(res.nextPending?.label).not.toBeNull();
    expect(res.nextPending?.label).not.toBeUndefined();
  });
});
