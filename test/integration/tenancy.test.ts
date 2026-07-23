import { env } from "cloudflare:test";
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

describe("shouldNotifyRefusal", () => {
  it("first call per (repo, day) true, repeats false, new day true again", async () => {
    const s = stub("ref-" + Math.random());
    expect(await s.shouldNotifyRefusal(1, "o/r", "2026-07-23")).toBe(true);
    expect(await s.shouldNotifyRefusal(1, "o/r", "2026-07-23")).toBe(false);
    expect(await s.shouldNotifyRefusal(1, "o/r", "2026-07-24")).toBe(true);
  });
});
