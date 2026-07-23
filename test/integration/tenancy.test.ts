import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { TenantRecord } from "../../src/types";

function stub(name: string) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(name));
}
const approved = (id: number, over: Partial<TenantRecord> = {}): TenantRecord => ({
  installationId: id,
  orgLogin: `org${id}`,
  status: "approved",
  allowAllRepos: false,
  minuteGrant: 1000,
  concurrencyCap: 1,
  maxShape: "s-4vcpu-8gb",
  jobTtlMs: 1_800_000,
  runnerGroupId: 9,
  contact: null,
  notes: null,
  approvedAt: 1,
  approvedBy: "op",
  ...over,
});
const job = (id: number, tenant: number) => ({
  jobId: id,
  runId: id,
  repoFullName: `org${tenant}/app`,
  label: "createos",
  tenant: null,
});
const ctx = (tenant: number, cap = 1) => ({ tenantId: tenant, weight: 2, cap });

describe("admitTenantJob", () => {
  it("walks the gate ladder: unknown → not-approved → repo → ok with balance", async () => {
    const s = stub("adm-" + Math.random());
    expect((await s.admitTenantJob(1, "o/r", "2026-07")).kind).toBe("unknown-tenant");

    await s.adminUpsertTenant(approved(1, { status: "pending" }));
    expect((await s.admitTenantJob(1, "org1/app", "2026-07")).kind).toBe("not-approved");

    await s.adminUpsertTenant(approved(1));
    expect((await s.admitTenantJob(1, "org1/app", "2026-07")).kind).toBe("repo-not-approved");

    await s.adminAddProjects(1, [{ repoFullName: "org1/app", repoId: 5 }]);
    const ok = await s.admitTenantJob(1, "org1/app", "2026-07");
    expect(ok.kind).toBe("ok");
    if (ok.kind === "ok") {
      expect(ok.usedMinutes).toBe(0);
      expect(ok.tenant.runnerGroupId).toBe(9);
    }
  });

  it("allow_all_repos skips the project gate", async () => {
    const s = stub("adm-all-" + Math.random());
    await s.adminUpsertTenant(approved(2, { allowAllRepos: true }));
    expect((await s.admitTenantJob(2, "org2/anything", "2026-07")).kind).toBe("ok");
  });
});

describe("per-tenant cap", () => {
  it("tenant A at cap queues; tenant B still provisions", async () => {
    const s = stub("cap-t-" + Math.random());
    await s.adminUpsertTenant(approved(1));
    await s.adminUpsertTenant(approved(2));
    expect((await s.onQueued(job(11, 1), "d1", ctx(1))).action).toBe("provision");
    expect((await s.onQueued(job(12, 1), "d2", ctx(1))).action).toBe("queued"); // A at cap 1
    expect((await s.onQueued(job(21, 2), "d3", ctx(2))).action).toBe("provision"); // B unaffected
  });

  it("promotion returns the tenant joined onto the PendingJob", async () => {
    const s = stub("cap-p-" + Math.random());
    await s.adminUpsertTenant(approved(1));
    await s.onQueued(job(11, 1), "d1", ctx(1));
    await s.recordSandboxCreated(11, "sb1", "cos-11-aa");
    await s.markRunning(11);
    await s.onQueued(job(12, 1), "d2", ctx(1)); // pending behind cap
    const res = await s.onCompleted(11, "cos-11-aa");
    expect(res.nextPending?.jobId).toBe(12);
    expect(res.nextPending?.tenant?.orgLogin).toBe("org1");
    expect(res.nextPending?.tenant?.runnerGroupId).toBe(9);
  });
});

describe("per-tenant cap at promotion", () => {
  // MAX_CONCURRENT is 2 in vitest.config.ts. A filler (tenant-less) job takes
  // the second global slot so BOTH tenants' jobs queue behind the global cap
  // — that keeps the global cap out of the way once it's freed, so the
  // per-tenant cap (gate 6) is what #dequeuePending actually has to enforce.
  it("skips a tenant at its cap for another with headroom, promotes once headroom opens", async () => {
    const s = stub("promo-" + Math.random());
    await s.adminUpsertTenant(approved(1, { concurrencyCap: 1 }));
    await s.adminUpsertTenant(approved(2, { concurrencyCap: 5 }));

    await s.onQueued(job(11, 1), "d1", ctx(1, 1)); // A's one running job
    await s.recordSandboxCreated(11, "sb11", "cos-11-aa");
    await s.markRunning(11);

    expect((await s.onQueued(job(99, 0), "d0")).action).toBe("provision"); // filler, fills global cap

    expect((await s.onQueued(job(12, 1), "d2", ctx(1, 1))).action).toBe("queued"); // A2, OLDER
    expect((await s.onQueued(job(21, 2), "d3", ctx(2, 5))).action).toBe("queued"); // B1, NEWER

    // Free the filler's slot: global cap no longer binds, so the choice is
    // decided by per-tenant headroom, not raw FIFO.
    const res = await s.onCompleted(99);
    expect(res.nextPending?.jobId).toBe(21); // B promoted despite being newer — A is still at cap

    await runInDurableObject(s, (_i, state) => {
      const row = state.storage.sql
        .exec<{ state: string }>(`SELECT state FROM jobs WHERE job_id = 12`)
        .one();
      expect(row.state).toBe("pending"); // A2 stays parked
    });

    const res2 = await s.onCompleted(11, "cos-11-aa"); // A's running job finishes — headroom opens
    expect(res2.nextPending?.jobId).toBe(12); // A2 now promoted
  });

  it("single-mode (NULL tenant_id) rows still promote strict oldest-first", async () => {
    const s = stub("promo-single-" + Math.random());
    const bare = (id: number) => job(id, 0);

    expect((await s.onQueued(bare(1), "s1")).action).toBe("provision");
    await s.recordSandboxCreated(1, "sb1", "cos-1-aa");
    await s.markRunning(1);
    expect((await s.onQueued(bare(2), "s2")).action).toBe("provision"); // fills global cap
    expect((await s.onQueued(bare(3), "s3")).action).toBe("queued"); // OLDER pending
    expect((await s.onQueued(bare(4), "s4")).action).toBe("queued"); // NEWER pending

    const res = await s.onCompleted(1, "cos-1-aa");
    expect(res.nextPending?.jobId).toBe(3); // strict FIFO, untouched by the tenant-headroom check
  });
});

describe("shouldNotifyRefusal", () => {
  it("first call per (repo, day) true, repeats false, new day true again", async () => {
    const s = stub("ref-" + Math.random());
    expect(await s.shouldNotifyRefusal(1, "o/r", "2026-07-23")).toBe(true);
    expect(await s.shouldNotifyRefusal(1, "o/r", "2026-07-23")).toBe(false);
    expect(await s.shouldNotifyRefusal(1, "o/r", "2026-07-24")).toBe(true);
  });
});

describe("ledger", () => {
  it("bills tenant total + repo attribution on destroy; no bill when never booted", async () => {
    const s = stub("led-" + Math.random());
    await s.adminUpsertTenant(approved(1, { concurrencyCap: 5 }));
    await s.onQueued(job(11, 1), "d1", ctx(1, 5));
    await s.recordSandboxCreated(11, "sb1", "cos-11-aa");
    await s.markRunning(11);
    await s.onCompleted(11, "cos-11-aa");
    await s.markDestroyed(11, 5_000);

    // never-booted row: queued then failed before createSandbox
    await s.onQueued(job(12, 1), "d2", ctx(1, 5));
    await s.markProvisionFailed(12);

    await runInDurableObject(s, async (_i, state) => {
      const rows = state.storage.sql
        .exec(
          `SELECT repo_full_name, weighted_minutes, egress_bytes FROM usage ORDER BY repo_full_name`,
        )
        .toArray();
      expect(rows).toHaveLength(2); // "" total + org1/app — nothing from job 12
      expect(rows[0]!.repo_full_name).toBe("");
      expect(rows[0]!.egress_bytes).toBe(5_000);
      expect(rows[0]!.weighted_minutes as number).toBeGreaterThanOrEqual(0);
      expect(rows[1]!.repo_full_name).toBe("org1/app");
    });
  });

  it("admitTenantJob sees the spent balance", async () => {
    const s = stub("led-bal-" + Math.random());
    await s.adminUpsertTenant(approved(1, { allowAllRepos: true }));
    await runInDurableObject(s, async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO usage (installation_id, month, repo_full_name, weighted_minutes, egress_bytes)
         VALUES (1, '2026-07', '', 999, 0)`,
      );
    });
    const ok = await s.admitTenantJob(1, "org1/x", "2026-07");
    expect(ok.kind === "ok" && ok.usedMinutes).toBe(999);
  });
});

describe("per-tenant TTL", () => {
  it("reaps a short-TTL tenant's row at its own bound, not the global one", async () => {
    const s = stub("ttl-" + Math.random());
    await s.adminUpsertTenant(approved(1, { jobTtlMs: 60_000, concurrencyCap: 5 }));
    await s.onQueued(job(11, 1), "d1", ctx(1, 5));
    await s.recordSandboxCreated(11, "sb1", "cos-11-aa");
    await s.markRunning(11);
    const t0 = Date.now();

    let res = await s.sweep(t0 + 30_000, 3_600_000);
    expect(res.toDestroy).toHaveLength(0); // under both bounds

    res = await s.sweep(t0 + 120_000, 3_600_000);
    expect(res.toDestroy.map((t) => t.jobId)).toEqual([11]); // over tenant TTL, under global
  });
});
