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
      { jobId: 1, runId: 1, repoFullName: "acme/x", label: "createos" },
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
    expect(got?.projects.map((p) => p.repoFullName)).toEqual(["acme/api", "acme/web"]);

    await s.adminRemoveProject(77, "acme/api");
    got = await s.adminGetTenant(77);
    expect(got?.projects.map((p) => p.repoFullName)).toEqual(["acme/web"]);
  });

  it("backfill claims only NULL tenant_id rows and reports the count", async () => {
    const s = stub("reg-bf-" + Math.random());
    await s.onQueued({ jobId: 1, runId: 1, repoFullName: "acme/x", label: "createos" }, "d1");
    await s.onQueued({ jobId: 2, runId: 1, repoFullName: "acme/y", label: "createos" }, "d2");
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
});
