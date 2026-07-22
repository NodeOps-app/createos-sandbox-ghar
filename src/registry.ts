import type { ProjectRecord, TenantRecord, TenantStatus } from "./types";

/**
 * Tenant/Project persistence over the Coordinator's SQLite. Plain functions on
 * SqlStorage so coordinator.ts stays thin and the DO stays passive — no
 * network, no imports beyond types. Every caller is admin-frequency (a few
 * requests a day); nothing here runs on the webhook hot path.
 */

type TenantRow = {
  installation_id: number;
  org_login: string;
  status: string;
  allow_all_repos: number;
  minute_grant: number;
  concurrency_cap: number;
  max_shape: string;
  job_ttl_ms: number;
  runner_group_id: number | null;
  contact: string | null;
  notes: string | null;
  approved_at: number | null;
  approved_by: string | null;
};

function toRecord(r: TenantRow): TenantRecord {
  return {
    installationId: r.installation_id,
    orgLogin: r.org_login,
    status: r.status as TenantStatus,
    allowAllRepos: r.allow_all_repos === 1,
    minuteGrant: r.minute_grant,
    concurrencyCap: r.concurrency_cap,
    maxShape: r.max_shape,
    jobTtlMs: r.job_ttl_ms,
    runnerGroupId: r.runner_group_id,
    contact: r.contact,
    notes: r.notes,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
  };
}

export function upsertTenant(sql: SqlStorage, t: TenantRecord): void {
  sql.exec(
    `INSERT INTO tenants (installation_id, org_login, status, allow_all_repos, minute_grant,
       concurrency_cap, max_shape, job_ttl_ms, runner_group_id, contact, notes,
       approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(installation_id) DO UPDATE SET
       org_login = excluded.org_login, status = excluded.status,
       allow_all_repos = excluded.allow_all_repos, minute_grant = excluded.minute_grant,
       concurrency_cap = excluded.concurrency_cap, max_shape = excluded.max_shape,
       job_ttl_ms = excluded.job_ttl_ms, runner_group_id = excluded.runner_group_id,
       contact = excluded.contact, notes = excluded.notes,
       approved_at = excluded.approved_at, approved_by = excluded.approved_by`,
    t.installationId,
    t.orgLogin,
    t.status,
    t.allowAllRepos ? 1 : 0,
    t.minuteGrant,
    t.concurrencyCap,
    t.maxShape,
    t.jobTtlMs,
    t.runnerGroupId,
    t.contact,
    t.notes,
    t.approvedAt,
    t.approvedBy,
  );
}

export function getTenant(sql: SqlStorage, installationId: number): TenantRecord | null {
  const rows = sql
    .exec(`SELECT * FROM tenants WHERE installation_id = ?`, installationId)
    .toArray() as TenantRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export function listTenants(sql: SqlStorage): TenantRecord[] {
  const rows = sql.exec(`SELECT * FROM tenants ORDER BY installation_id`).toArray() as TenantRow[];
  return rows.map(toRecord);
}

export function setTenantStatus(
  sql: SqlStorage,
  installationId: number,
  status: TenantStatus,
): void {
  sql.exec(`UPDATE tenants SET status = ? WHERE installation_id = ?`, status, installationId);
}

export function addProjects(
  sql: SqlStorage,
  installationId: number,
  projects: { repoFullName: string; repoId: number }[],
  now: number,
): void {
  for (const p of projects) {
    sql.exec(
      `INSERT INTO projects (installation_id, repo_full_name, repo_id, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(installation_id, repo_full_name) DO UPDATE SET repo_id = excluded.repo_id`,
      installationId,
      p.repoFullName,
      p.repoId,
      now,
    );
  }
}

export function removeProject(sql: SqlStorage, installationId: number, repoFullName: string): void {
  sql.exec(
    `DELETE FROM projects WHERE installation_id = ? AND repo_full_name = ?`,
    installationId,
    repoFullName,
  );
}

export function listProjects(sql: SqlStorage, installationId: number): ProjectRecord[] {
  const rows = sql
    .exec(
      `SELECT * FROM projects WHERE installation_id = ? ORDER BY repo_full_name`,
      installationId,
    )
    .toArray() as {
    installation_id: number;
    repo_full_name: string;
    repo_id: number;
    added_at: number;
  }[];
  return rows.map((r) => ({
    installationId: r.installation_id,
    repoFullName: r.repo_full_name,
    repoId: r.repo_id,
    addedAt: r.added_at,
  }));
}

/**
 * Claims every pre-multi-tenancy job row (tenant_id IS NULL) for one tenant.
 * NULL-only on purpose: re-running is a no-op, and rows already owned by a
 * tenant are never re-assigned — the backfill cannot rewrite history.
 */
export function backfillJobTenant(sql: SqlStorage, installationId: number): number {
  sql.exec(`UPDATE jobs SET tenant_id = ? WHERE tenant_id IS NULL`, installationId);
  const row = sql.exec(`SELECT changes() AS n`).one() as { n: number };
  return row.n;
}
