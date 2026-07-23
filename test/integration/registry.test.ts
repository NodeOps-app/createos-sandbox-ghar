import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { TenantRecord } from "../../src/types";

function stub(name: string) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(name));
}

const tenant = (over: Partial<TenantRecord> = {}): TenantRecord => ({
  installationId: 77,
  orgLogin: "acme",
  status: "pending",
  allowAllRepos: false,
  minuteGrant: 5000,
  concurrencyCap: 5,
  maxShape: "s-4vcpu-8gb",
  jobTtlMs: 1_800_000,
  runnerGroupId: null,
  contact: null,
  notes: null,
  approvedAt: null,
  approvedBy: null,
  ...over,
});

describe("tenant schema migration", () => {
  it("creates the tenant tables and the jobs.tenant_id column", async () => {
    const s = stub("schema-" + Math.random());
    await runInDurableObject(s, async (_instance, state) => {
      const tables = state.storage.sql
        .exec(`SELECT name FROM sqlite_master WHERE type='table'`)
        .toArray()
        .map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(["tenants", "projects", "usage"]));

      const cols = state.storage.sql
        .exec(`PRAGMA table_info(jobs)`)
        .toArray()
        .map((r) => r.name);
      expect(cols).toContain("tenant_id");
    });
  });

  it("existing job flow is untouched by the new schema", async () => {
    const s = stub("schema-flow-" + Math.random());
    const d = await s.onQueued(
      { jobId: 1, runId: 1, repoFullName: "acme/x", label: "createos", tenant: null },
      "d1",
    );
    expect(d.action).toBe("provision");
  });
});

describe("tenant registry", () => {
  it("upsert → get roundtrips every field", async () => {
    const s = stub("reg-rt-" + Math.random());
    const t = tenant({ contact: '{"email":"a@b.c"}', notes: "watch this one" });
    await s.adminUpsertTenant(t);
    const got = await s.adminGetTenant(77);
    expect(got?.tenant).toEqual(t);
    expect(got?.projects).toEqual([]);
  });

  it("upsert updates in place (no duplicate rows)", async () => {
    const s = stub("reg-up-" + Math.random());
    await s.adminUpsertTenant(tenant());
    await s.adminUpsertTenant(tenant({ minuteGrant: 9000, status: "approved" }));
    const all = await s.adminListTenants();
    expect(all).toHaveLength(1);
    expect(all[0]?.minuteGrant).toBe(9000);
    expect(all[0]?.status).toBe("approved");
  });

  it("status transitions persist", async () => {
    const s = stub("reg-st-" + Math.random());
    await s.adminUpsertTenant(tenant());
    await s.adminSetTenantStatus(77, "suspended");
    expect((await s.adminGetTenant(77))?.tenant.status).toBe("suspended");
  });

  it("projects add / list / remove", async () => {
    const s = stub("reg-pr-" + Math.random());
    await s.adminUpsertTenant(tenant());
    await s.adminAddProjects(77, [
      { repoFullName: "acme/api", repoId: 11 },
      { repoFullName: "acme/web", repoId: 12 },
    ]);
    let got = await s.adminGetTenant(77);
    // Full-shape assertion (not just repoFullName): catches a wrong field
    // mapping in listProjects (e.g. repoId/installationId swapped) that a
    // repoFullName-only check would miss.
    expect(got?.projects).toEqual([
      { installationId: 77, repoFullName: "acme/api", repoId: 11, addedAt: expect.any(Number) },
      { installationId: 77, repoFullName: "acme/web", repoId: 12, addedAt: expect.any(Number) },
    ]);

    await s.adminRemoveProject(77, "acme/api");
    got = await s.adminGetTenant(77);
    expect(got?.projects.map((p) => p.repoFullName)).toEqual(["acme/web"]);
  });

  it("re-adding an existing project updates repo_id but not added_at", async () => {
    const s = stub("reg-pr-update-" + Math.random());
    await s.adminUpsertTenant(tenant());
    await s.adminAddProjects(77, [{ repoFullName: "acme/api", repoId: 11 }]);

    // Backdate added_at so the assertion below is robust even if two
    // Date.now() calls in the same test tick land on the same millisecond.
    const ORIGINAL_ADDED_AT = 1_000_000;
    await runInDurableObject(s, async (_i, state) => {
      state.storage.sql.exec(
        `UPDATE projects SET added_at = ? WHERE installation_id = ? AND repo_full_name = ?`,
        ORIGINAL_ADDED_AT,
        77,
        "acme/api",
      );
    });

    // Re-add the same (installation_id, repo_full_name) with a changed repo_id.
    await s.adminAddProjects(77, [{ repoFullName: "acme/api", repoId: 99 }]);

    const got = await s.adminGetTenant(77);
    expect(got?.projects).toHaveLength(1); // no duplicate row
    expect(got?.projects[0]).toEqual({
      installationId: 77,
      repoFullName: "acme/api",
      repoId: 99, // updated
      addedAt: ORIGINAL_ADDED_AT, // NOT clobbered by the re-add
    });
  });

  it("addProjects refuses a batch for a nonexistent tenant and inserts nothing", async () => {
    const s = stub("reg-pr-missing-" + Math.random());
    // Thrown via the instance directly, not the external stub: the vitest
    // pool's isolated-storage bookkeeping corrupts itself when an exception
    // crosses the actual DO RPC boundary (a harness quirk, not our code —
    // confirmed by reproducing it with a throw-only probe method too).
    await runInDurableObject(s, (instance) => {
      expect(() =>
        instance.adminAddProjects(404, [{ repoFullName: "acme/api", repoId: 11 }]),
      ).toThrow(/404/);
    });

    await runInDurableObject(s, async (_i, state) => {
      const rows = state.storage.sql
        .exec(`SELECT * FROM projects WHERE installation_id = ?`, 404)
        .toArray();
      expect(rows).toEqual([]); // no partial insert
    });
  });

  it("backfill claims only NULL tenant_id rows and reports the count", async () => {
    const s = stub("reg-bf-" + Math.random());
    await s.adminUpsertTenant(tenant());
    await s.onQueued(
      { jobId: 1, runId: 1, repoFullName: "acme/x", label: "createos", tenant: null },
      "d1",
    );
    await s.onQueued(
      { jobId: 2, runId: 1, repoFullName: "acme/y", label: "createos", tenant: null },
      "d2",
    );
    // Simulate a row already owned by another tenant — backfill must not touch it.
    await runInDurableObject(s, async (_i, state) => {
      state.storage.sql.exec(`UPDATE jobs SET tenant_id = 99 WHERE job_id = 1`);
    });

    expect(await s.adminBackfillTenantIds(77)).toBe(1); // only job 2 claimed
    expect(await s.adminBackfillTenantIds(77)).toBe(0); // idempotent

    await runInDurableObject(s, async (_i, state) => {
      const rows = state.storage.sql
        .exec(`SELECT job_id, tenant_id FROM jobs ORDER BY job_id`)
        .toArray();
      expect(rows).toEqual([
        { job_id: 1, tenant_id: 99 },
        { job_id: 2, tenant_id: 77 },
      ]);
    });
  });

  it("backfill refuses to claim rows for a nonexistent tenant", async () => {
    const s = stub("reg-bf-missing-" + Math.random());
    await s.onQueued(
      { jobId: 1, runId: 1, repoFullName: "acme/x", label: "createos", tenant: null },
      "d1",
    );

    // See the addProjects test above for why this goes through the instance,
    // not the external stub.
    await runInDurableObject(s, (instance) => {
      expect(() => instance.adminBackfillTenantIds(404)).toThrow(/404/);
    });

    await runInDurableObject(s, async (_i, state) => {
      const rows = state.storage.sql.exec(`SELECT tenant_id FROM jobs WHERE job_id = 1`).toArray();
      expect(rows).toEqual([{ tenant_id: null }]); // untouched, not claimed by 404
    });
  });
});
