# Multi-Tenant Plan 1: Registry Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the tenant registry (schema, data access, admin API) and the weighted-minute quota math with **zero behaviour change** — deployable and rollback-safe on its own.

**Architecture:** Three new tables (`tenants`, `projects`, `usage`) plus a nullable `jobs.tenant_id` column inside the existing singleton Coordinator DO, added additively in the constructor's migration block. Pure quota math in `src/quota.ts` (importable by both Worker and DO). Registry persistence as plain functions over `SqlStorage` in `src/registry.ts`, exposed as admin-frequency RPC methods on the Coordinator. A bearer-authenticated `/admin/*` surface in `src/admin.ts` that 404s identically for missing and wrong tokens. Nothing on the webhook hot path reads any of it yet — that is Plan 2.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), TypeScript, zod, vitest + `@cloudflare/vitest-pool-workers`, bun.

**Spec:** `docs/superpowers/specs/2026-07-22-multi-tenant-community-runners-design.md`

**Roadmap context:** This is plan 1 of 3. Plan 2 = tenant-aware admission/ledger/runner-groups behind a flag. Plan 3 = App cutover. **Deviation from spec §10 step 2, on purpose:** the real NodeOps tenant is NOT seeded here — seeding now would key it on the old App's `installation_id`, which the Plan 3 credential swap invalidates. Plan 1 builds and verifies the seed tooling; the real seed runs at cutover with the new App's installation id.

## Global Constraints

- **Performance and cost are priorities.** This plan adds ZERO work to the webhook hot path — every new read/write is admin-frequency (a few per day). The DO constructor migration adds one `PRAGMA table_info` read (already paid) and guarded one-time DDL. No new cron work, no new subrequests, no new DO row-writes on any recurring path.
- **Additive-only DO migration.** New tables + nullable column. Old code rolling back must run unchanged against the migrated schema (Worker rollback never reverts DO SQLite).
- **A push to `main` is a production deploy.** Run `bun run lint && bun run typecheck && bun run test` green before every push. Capture the active deployment version id before pushing (rollback readiness).
- **bun only** — never npm/npx/node. New deps pinned exact: `bun add -E`.
- **No TDD** (repo rule overrides skill default): implement, then test, then verify.
- **Never hit the network in tests.** This plan needs no fetch mocks — all new code is DO/SQL/pure.
- **Do NOT touch the pins:** `@cloudflare/vitest-pool-workers@0.8.71`, `vitest@3.2.4`.
- **oxlint + oxfmt on every `.ts` change** (`bun run lint`; `bunx oxfmt` if formatting drifts).
- **Files < 1100 lines.** `coordinator.ts` is 485 and gains ~60 here — fine.
- **Conventional Commits**, imperative subject ≤ 50 chars, atomic per task.
- **Comment the why, not the what.** Match surrounding comment density.
- The Coordinator DO stays **passive**: no network I/O, no imports beyond `./types` + `./registry` (which itself imports only types). It must NEVER import `shapes.ts`.

---

### Task 1: Weighted-minute quota math (`src/quota.ts`)

**Files:**
- Create: `src/quota.ts`
- Test: `test/unit/quota.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, zero imports).
- Produces (Plan 2's ledger writes and admission checks call these):
  - `monthKey(nowMs: number): string` — UTC calendar-month bucket, `"2026-07"`.
  - `weightForLabel(label: string, runnerLabel: string, defaultShape: string): number` — shape weight = vCPU ÷ 2.
  - `weightedMinutes(label: string, runnerLabel: string, defaultShape: string, lifetimeMs: number): number`.

- [ ] **Step 1: Write `src/quota.ts`**

```typescript
/**
 * Weighted-minute quota math. Pure and import-free on purpose: the Coordinator
 * DO must bill VM lifetimes at teardown but is forbidden from importing
 * shapes.ts (it stays passive), so the label→weight parse lives here where
 * both Worker and DO can reach it.
 *
 * A weighted minute is one wall-clock minute of VM lifetime × (vCPU ÷ 2):
 * s-2vcpu-2gb burns 1×, s-4vcpu-8gb burns 2×, s-8vcpu-16gb burns 4×. Memory is
 * deliberately not a factor — vCPU tracks cost closely enough, and one axis
 * keeps the operator-facing unit an honest "minute" (spec D8).
 */

/** The UTC calendar-month bucket a timestamp falls in: "2026-07". The month is
 * part of the usage primary key, so a new month is a new row — no reset job. */
export function monthKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const VCPU_RE = /(\d+)vcpu/;

/**
 * The billing weight of the shape a runner label names. The bare label bills
 * at the default shape; a shaped label ("createos-4vcpu-8gb") bills by its own
 * vCPU. An unparseable label falls back to the default's weight — billing runs
 * inside the teardown path and must never block it — but warns, because a
 * silent fallback would misprice quietly (no-silent-bounds rule).
 */
export function weightForLabel(label: string, runnerLabel: string, defaultShape: string): number {
  const src = label === runnerLabel ? defaultShape : label;
  const m = VCPU_RE.exec(src);
  if (m) return Number(m[1]) / 2;
  console.warn(`quota: cannot parse vcpu from "${label}"; billing at default "${defaultShape}"`);
  const d = VCPU_RE.exec(defaultShape);
  return d ? Number(d[1]) / 2 : 1;
}

/** Weighted minutes one VM lifetime burned. Negative lifetimes clamp to 0. */
export function weightedMinutes(
  label: string,
  runnerLabel: string,
  defaultShape: string,
  lifetimeMs: number,
): number {
  return (Math.max(0, lifetimeMs) / 60_000) * weightForLabel(label, runnerLabel, defaultShape);
}
```

- [ ] **Step 2: Write `test/unit/quota.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { monthKey, weightForLabel, weightedMinutes } from "../../src/quota";

const BARE = "createos";
const DEF = "s-4vcpu-4gb";

describe("monthKey", () => {
  it("formats the UTC year-month zero-padded", () => {
    expect(monthKey(Date.UTC(2026, 6, 22, 12, 0, 0))).toBe("2026-07");
  });

  it("rolls at the UTC month boundary, not local time", () => {
    expect(monthKey(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe("2026-12");
    expect(monthKey(Date.UTC(2027, 0, 1, 0, 0, 0))).toBe("2027-01");
  });
});

describe("weightForLabel", () => {
  it("bills the bare label at the default shape", () => {
    expect(weightForLabel(BARE, BARE, DEF)).toBe(2);
  });

  it("bills shaped labels by their own vCPU", () => {
    expect(weightForLabel("createos-2vcpu-2gb", BARE, DEF)).toBe(1);
    expect(weightForLabel("createos-4vcpu-8gb", BARE, DEF)).toBe(2);
    expect(weightForLabel("createos-8vcpu-16gb", BARE, DEF)).toBe(4);
  });

  it("falls back to the default weight on an unparseable label, loudly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(weightForLabel("createos-huge", BARE, DEF)).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("weightedMinutes", () => {
  it("scales wall minutes by the shape weight", () => {
    expect(weightedMinutes("createos-2vcpu-2gb", BARE, DEF, 30 * 60_000)).toBe(30);
    expect(weightedMinutes(BARE, BARE, DEF, 30 * 60_000)).toBe(60);
  });

  it("clamps a negative lifetime to zero", () => {
    expect(weightedMinutes(BARE, BARE, DEF, -5)).toBe(0);
  });
});
```

- [ ] **Step 3: Run the gate**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green; `quota.test.ts` shows 7 passing tests.

- [ ] **Step 4: Commit**

```bash
git add src/quota.ts test/unit/quota.test.ts
git commit -m "feat: add weighted-minute quota math"
```

---

### Task 2: Tenant types + Coordinator schema migration

**Files:**
- Modify: `src/types.ts` (append after the `Config` interface block)
- Modify: `src/coordinator.ts:74-96` (constructor DDL block) and `:106-115` (column-guard block); `Row` type at `:18-30`
- Test: `test/integration/registry.test.ts` (new)

**Interfaces:**
- Consumes: existing constructor migration pattern (`PRAGMA table_info` + guarded `ALTER`).
- Produces (Tasks 3–4 and Plan 2 rely on these exact shapes):

```typescript
export type TenantStatus = "pending" | "approved" | "suspended" | "revoked";

export interface TenantRecord {
  installationId: number;
  orgLogin: string;
  status: TenantStatus;
  allowAllRepos: boolean;
  minuteGrant: number;      // weighted minutes per UTC calendar month
  concurrencyCap: number;
  maxShape: string;         // "s-4vcpu-8gb"
  jobTtlMs: number;
  runnerGroupId: number | null; // NULL until approval creates the group (Plan 2)
  contact: string | null;   // JSON blob from the onboarding form
  notes: string | null;
  approvedAt: number | null;
  approvedBy: string | null;
}

export interface ProjectRecord {
  installationId: number;
  repoFullName: string;
  repoId: number;           // runner-group scoping API takes repo ids
  addedAt: number;
}
```

- [ ] **Step 1: Append tenant types to `src/types.ts`**

Add the two interfaces + type alias above verbatim, with this leading comment:

```typescript
/**
 * A Tenant is an approved GitHub org, keyed by App installation id (spec D1).
 * It owns the quota grant, concurrency cap, shape ceiling, job TTL and runner
 * group. A Project is an approved repo inside a Tenant — the admission unit
 * (D2). Quota is enforced on the Tenant, attributed per Project (D3).
 */
```

- [ ] **Step 2: Add the three tables to the Coordinator constructor DDL**

In `src/coordinator.ts`, inside the existing `this.#sql.exec(\`...\`)` template literal (after the `meta` table's `);`), append:

```sql
      CREATE TABLE IF NOT EXISTS tenants (
        installation_id INTEGER PRIMARY KEY,
        org_login       TEXT NOT NULL,
        status          TEXT NOT NULL,
        allow_all_repos INTEGER NOT NULL DEFAULT 0,
        minute_grant    INTEGER NOT NULL,
        concurrency_cap INTEGER NOT NULL,
        max_shape       TEXT NOT NULL,
        job_ttl_ms      INTEGER NOT NULL,
        runner_group_id INTEGER,
        contact         TEXT,
        notes           TEXT,
        approved_at     INTEGER,
        approved_by     TEXT
      );
      CREATE TABLE IF NOT EXISTS projects (
        installation_id INTEGER NOT NULL,
        repo_full_name  TEXT NOT NULL,
        repo_id         INTEGER NOT NULL,
        added_at        INTEGER NOT NULL,
        PRIMARY KEY (installation_id, repo_full_name)
      );
      CREATE TABLE IF NOT EXISTS usage (
        installation_id  INTEGER NOT NULL,
        month            TEXT NOT NULL,
        repo_full_name   TEXT NOT NULL,
        weighted_minutes REAL NOT NULL DEFAULT 0,
        egress_bytes     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (installation_id, month, repo_full_name)
      );
```

- [ ] **Step 3: Add the `tenant_id` column guard**

In the existing column-guard block (after the `job_started_at` guard), add:

```typescript
    if (!has("tenant_id")) this.#sql.exec(`ALTER TABLE jobs ADD COLUMN tenant_id INTEGER`);
```

And extend the migration comment's list with one clause, matching its existing style: a NULL `tenant_id` is a row from before multi-tenancy, owned by the seeded first tenant once backfilled; until then no code reads it, so old and new code agree.

Add to the `Row` type: `tenant_id: number | null;`

- [ ] **Step 4: Write the schema test**

Create `test/integration/registry.test.ts`:

```typescript
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function stub(name: string) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(name));
}

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
```

- [ ] **Step 5: Run the gate**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green, including every pre-existing integration suite (the migration must not disturb them).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/coordinator.ts test/integration/registry.test.ts
git commit -m "feat: add tenant registry schema to Coordinator"
```

---

### Task 3: Registry persistence + Coordinator RPC (`src/registry.ts`)

**Files:**
- Create: `src/registry.ts`
- Modify: `src/coordinator.ts` (append RPC methods at the end of the class; add imports)
- Test: `test/integration/registry.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's tables and `TenantRecord`/`ProjectRecord`/`TenantStatus` types.
- Produces — Coordinator RPC methods Task 4's admin API and Plan 2's admission call:
  - `adminUpsertTenant(t: TenantRecord): void`
  - `adminGetTenant(installationId: number): { tenant: TenantRecord; projects: ProjectRecord[] } | null`
  - `adminListTenants(): TenantRecord[]`
  - `adminSetTenantStatus(installationId: number, status: TenantStatus): void`
  - `adminAddProjects(installationId: number, projects: { repoFullName: string; repoId: number }[]): void`
  - `adminRemoveProject(installationId: number, repoFullName: string): void`
  - `adminBackfillTenantIds(installationId: number): number` — claims only `tenant_id IS NULL` rows, returns count.

- [ ] **Step 1: Write `src/registry.ts`**

```typescript
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
    .toArray() as { installation_id: number; repo_full_name: string; repo_id: number; added_at: number }[];
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
```

- [ ] **Step 2: Add the RPC methods to `Coordinator`**

In `src/coordinator.ts`, add imports:

```typescript
import type { ProjectRecord, TenantRecord, TenantStatus } from "./types";
import {
  addProjects,
  backfillJobTenant,
  getTenant,
  listProjects,
  listTenants,
  removeProject,
  setTenantStatus,
  upsertTenant,
} from "./registry";
```

(Merge the type imports into the existing `import type` block.)

Append at the end of the class body:

```typescript
  // ── Tenant registry (admin-frequency; never on the webhook hot path) ──

  adminUpsertTenant(t: TenantRecord): void {
    upsertTenant(this.#sql, t);
  }

  adminGetTenant(
    installationId: number,
  ): { tenant: TenantRecord; projects: ProjectRecord[] } | null {
    const tenant = getTenant(this.#sql, installationId);
    if (!tenant) return null;
    return { tenant, projects: listProjects(this.#sql, installationId) };
  }

  adminListTenants(): TenantRecord[] {
    return listTenants(this.#sql);
  }

  adminSetTenantStatus(installationId: number, status: TenantStatus): void {
    setTenantStatus(this.#sql, installationId, status);
  }

  adminAddProjects(
    installationId: number,
    projects: { repoFullName: string; repoId: number }[],
  ): void {
    addProjects(this.#sql, installationId, projects, Date.now());
  }

  adminRemoveProject(installationId: number, repoFullName: string): void {
    removeProject(this.#sql, installationId, repoFullName);
  }

  adminBackfillTenantIds(installationId: number): number {
    return backfillJobTenant(this.#sql, installationId);
  }
```

- [ ] **Step 3: Extend `test/integration/registry.test.ts`**

Append:

```typescript
import type { TenantRecord } from "../../src/types";

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
```

- [ ] **Step 4: Run the gate**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green; registry suite 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts src/coordinator.ts test/integration/registry.test.ts
git commit -m "feat: add tenant registry operations"
```

---

### Task 4: Admin API (`src/admin.ts`) + config + routing

**Files:**
- Modify: `package.json` (add zod)
- Modify: `src/config.ts:72` area (add `adminToken`), `src/types.ts` (`Config` gains `adminToken?: string`)
- Modify: `src/webhook.ts:6` (`function timingSafeEqual` → `export function timingSafeEqual`)
- Create: `src/admin.ts`
- Modify: `src/index.ts` (route `/admin/*`)
- Modify: `vitest.config.ts` (add `ADMIN_TOKEN` binding — touch ONLY the bindings map, nothing else)
- Test: `test/integration/admin.test.ts` (new)

**Interfaces:**
- Consumes: Task 3's `admin*` RPC methods; `timingSafeEqual` from `webhook.ts`.
- Produces: `handleAdmin(req: Request, env: Bindings): Promise<Response>`; routes (all JSON, all bearer-authed, snake_case bodies matching the DB):
  - `GET  /admin/tenants` → `TenantRecord[]`
  - `POST /admin/tenants` → 201 `TenantRecord` (upsert)
  - `POST /admin/tenants/status` `{installation_id, status}` → `{ok}`
  - `POST /admin/projects` `{installation_id, projects:[{repo_full_name, repo_id}]}` → `{ok, added}`
  - `DELETE /admin/projects` `{installation_id, repo_full_name}` → `{ok}`
  - `POST /admin/backfill` `{installation_id}` → `{ok, claimed}`

- [ ] **Step 1: Add zod (exact-pinned)**

Run: `bun add -E zod`
Expected: `package.json` gains `"zod": "<latest>"` under dependencies. Zod tree-shakes small and the admin module is lazy-imported by route, so bundle impact on the hot path is nil; the repo convention (AGENTS.md "Use zod") applies.

- [ ] **Step 2: Config + webhook export**

`src/types.ts`, end of `Config`:

```typescript
  adminToken?: string; // bearer token for /admin/*; unset = admin surface disabled (404)
```

`src/config.ts`, in the returned object after `alertWebhookUrl`:

```typescript
    adminToken: (env.ADMIN_TOKEN as string) || undefined,
```

`src/webhook.ts:6`: change `function timingSafeEqual(` to `export function timingSafeEqual(`.

- [ ] **Step 3: Write `src/admin.ts`**

```typescript
import { z } from "zod";
import type { Bindings } from "./index";
import { loadConfig } from "./config";
import { timingSafeEqual } from "./webhook";
import type { TenantRecord } from "./types";

/**
 * Operator-only tenant registry API. Manual approval is the design (spec D16):
 * a Google-Form applicant is vetted by a human, then these endpoints record the
 * decision — approval must never require a deploy, because a push to main IS a
 * production deploy. Missing token and wrong token both 404, so an unconfigured
 * deployment exposes no probeable surface.
 */

const enc = new TextEncoder();

async function authorized(req: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  // Hash both sides to equal length so the constant-time compare never
  // short-circuits on length — the only thing it may leak is "wrong".
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(header.slice("Bearer ".length))),
    crypto.subtle.digest("SHA-256", enc.encode(token)),
  ]);
  return timingSafeEqual(a, b);
}

const Status = z.enum(["pending", "approved", "suspended", "revoked"]);

const TenantBody = z.object({
  installation_id: z.number().int().positive(),
  org_login: z.string().min(1),
  status: Status.default("pending"),
  allow_all_repos: z.boolean().default(false),
  minute_grant: z.number().int().positive(),
  concurrency_cap: z.number().int().positive(),
  max_shape: z.string().regex(/^s-\d+vcpu-\d+gb$/),
  job_ttl_ms: z.number().int().positive().default(1_800_000),
  runner_group_id: z.number().int().positive().nullable().default(null),
  contact: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  approved_by: z.string().nullable().default(null),
});

const StatusBody = z.object({ installation_id: z.number().int().positive(), status: Status });

const ProjectsBody = z.object({
  installation_id: z.number().int().positive(),
  projects: z
    .array(
      z.object({
        repo_full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
        repo_id: z.number().int().positive(),
      }),
    )
    .min(1),
});

const ProjectDeleteBody = z.object({
  installation_id: z.number().int().positive(),
  repo_full_name: z.string().min(3),
});

const BackfillBody = z.object({ installation_id: z.number().int().positive() });

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleAdmin(req: Request, env: Bindings): Promise<Response> {
  const config = loadConfig(env as Record<string, unknown>);
  if (!(await authorized(req, config.adminToken))) return new Response("not found", { status: 404 });

  const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
  const route = `${req.method} ${new URL(req.url).pathname}`;

  try {
    if (route === "GET /admin/tenants") return json(await co.adminListTenants());

    if (route === "POST /admin/tenants") {
      const b = TenantBody.parse(await req.json());
      const record: TenantRecord = {
        installationId: b.installation_id,
        orgLogin: b.org_login,
        status: b.status,
        allowAllRepos: b.allow_all_repos,
        minuteGrant: b.minute_grant,
        concurrencyCap: b.concurrency_cap,
        maxShape: b.max_shape,
        jobTtlMs: b.job_ttl_ms,
        runnerGroupId: b.runner_group_id,
        contact: b.contact,
        notes: b.notes,
        approvedAt: b.status === "approved" ? Date.now() : null,
        approvedBy: b.approved_by,
      };
      await co.adminUpsertTenant(record);
      return json(record, 201);
    }

    if (route === "POST /admin/tenants/status") {
      const b = StatusBody.parse(await req.json());
      await co.adminSetTenantStatus(b.installation_id, b.status);
      return json({ ok: true });
    }

    if (route === "POST /admin/projects") {
      const b = ProjectsBody.parse(await req.json());
      await co.adminAddProjects(
        b.installation_id,
        b.projects.map((p) => ({ repoFullName: p.repo_full_name, repoId: p.repo_id })),
      );
      return json({ ok: true, added: b.projects.length });
    }

    if (route === "DELETE /admin/projects") {
      const b = ProjectDeleteBody.parse(await req.json());
      await co.adminRemoveProject(b.installation_id, b.repo_full_name);
      return json({ ok: true });
    }

    if (route === "POST /admin/backfill") {
      const b = BackfillBody.parse(await req.json());
      return json({ ok: true, claimed: await co.adminBackfillTenantIds(b.installation_id) });
    }

    return new Response("not found", { status: 404 });
  } catch (err) {
    if (err instanceof z.ZodError) return json({ error: err.issues }, 400);
    throw err;
  }
}
```

- [ ] **Step 4: Route it in `src/index.ts`**

Add to the imports: `import { handleAdmin } from "./admin";`

In `fetch`, before the final 404:

```typescript
    if (url.pathname.startsWith("/admin/")) {
      return handleAdmin(req, env);
    }
```

- [ ] **Step 5: Add the test binding**

In `vitest.config.ts` `miniflare.bindings`, add one line (change nothing else in this file — the pool-workers pin is deliberate):

```typescript
            ADMIN_TOKEN: "test-admin-token",
```

- [ ] **Step 6: Write `test/integration/admin.test.ts`**

```typescript
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { handleAdmin } from "../../src/admin";
import type { Bindings } from "../../src/index";
import type { TenantRecord } from "../../src/types";

const B = env as unknown as Bindings;

function req(method: string, path: string, body?: unknown, token = "test-admin-token") {
  return new Request(`https://ghar.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const tenantBody = (over: Record<string, unknown> = {}) => ({
  installation_id: 501,
  org_login: "acme",
  minute_grant: 5000,
  concurrency_cap: 5,
  max_shape: "s-4vcpu-8gb",
  ...over,
});

describe("admin auth", () => {
  it("404s a wrong token — no probeable surface", async () => {
    expect((await handleAdmin(req("GET", "/admin/tenants", undefined, "wrong"), B)).status).toBe(404);
  });

  it("404s a missing Authorization header", async () => {
    expect((await handleAdmin(new Request("https://ghar.test/admin/tenants"), B)).status).toBe(404);
  });
});

describe("admin API", () => {
  it("creates, lists, and status-flips a tenant", async () => {
    const create = await handleAdmin(req("POST", "/admin/tenants", tenantBody()), B);
    expect(create.status).toBe(201);

    const list = await handleAdmin(req("GET", "/admin/tenants"), B);
    const tenants = (await list.json()) as TenantRecord[];
    expect(tenants.some((t) => t.installationId === 501 && t.status === "pending")).toBe(true);

    const flip = await handleAdmin(
      req("POST", "/admin/tenants/status", { installation_id: 501, status: "approved" }),
      B,
    );
    expect(flip.status).toBe(200);
  });

  it("400s an invalid body with zod issues", async () => {
    const res = await handleAdmin(
      req("POST", "/admin/tenants", { org_login: "", installation_id: -1 }),
      B,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });

  it("adds and removes projects", async () => {
    await handleAdmin(req("POST", "/admin/tenants", tenantBody({ installation_id: 502 })), B);
    const add = await handleAdmin(
      req("POST", "/admin/projects", {
        installation_id: 502,
        projects: [{ repo_full_name: "acme/api", repo_id: 11 }],
      }),
      B,
    );
    expect((await add.json() as { added: number }).added).toBe(1);

    const del = await handleAdmin(
      req("DELETE", "/admin/projects", { installation_id: 502, repo_full_name: "acme/api" }),
      B,
    );
    expect(del.status).toBe(200);
  });

  it("backfill endpoint reports claimed rows", async () => {
    const res = await handleAdmin(req("POST", "/admin/backfill", { installation_id: 501 }), B);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("claimed");
  });
});
```

- [ ] **Step 7: Run the gate**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green; admin suite 6 tests passing.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock src/admin.ts src/index.ts src/config.ts src/types.ts src/webhook.ts vitest.config.ts test/integration/admin.test.ts
git commit -m "feat: add bearer-authed tenant admin API"
```

---

### Task 5: Docs, deploy checkpoint, prod verification

**Files:**
- Modify: `CONTEXT.md` (glossary), `AGENTS.md` (file table), `README.md` (operator surface)
- No source changes.

**Interfaces:**
- Consumes: everything above, deployed.
- Produces: a verified production deployment Plan 2 builds on, and the documented operator surface.

- [ ] **Step 1: Update docs**

- `CONTEXT.md` — add glossary entries (terms only, no implementation, matching house style): **Tenant** (an approved GitHub org, keyed by App installation id; owns the Grant, concurrency cap, shape ceiling, job TTL and runner group), **Project** (an approved repo inside a Tenant; the admission unit — usage is attributed to it, never enforced at it), **Grant** (a Tenant's weighted minutes per UTC calendar month), **Weighted minute** (one wall-clock minute of Sandbox lifetime × shape vCPU ÷ 2), **Ledger** (per-Tenant, per-month usage rows; the month is part of the key, so a new month is a new row and there is no reset step).
- `AGENTS.md` — file-responsibilities table: add rows for `src/quota.ts` (pure weighted-minute math; import-free so the DO may use it), `src/registry.ts` (Tenant/Project persistence over the DO's SQLite; admin-frequency only), `src/admin.ts` (bearer-authed operator API; 404s when `ADMIN_TOKEN` unset). Note in the Coordinator row that it now also holds the tenant registry tables.
- `README.md` — operator section: `ADMIN_TOKEN` secret, the six admin routes with one-line curl examples, and the note that approval is manual by design.

- [ ] **Step 2: Full gate + rollback point**

```bash
bun run lint && bun run typecheck && bun run test
bunx wrangler@latest deployments list   # note the active version id — rollback target
```

- [ ] **Step 3: Set the admin secret in prod**

```bash
openssl rand -hex 32   # save this value in the team vault
bunx wrangler@latest secret put ADMIN_TOKEN   # paste it
```

- [ ] **Step 4: Commit docs, push, deploy**

```bash
git add CONTEXT.md AGENTS.md README.md
git commit -m "docs: document tenant registry operator surface"
git push origin main   # THIS IS THE PRODUCTION DEPLOY (Workers Builds)
```

Watch the build in the Cloudflare dashboard until it goes live.

- [ ] **Step 5: Verify prod**

```bash
curl -s https://<worker-url>/health                                   # → ok
curl -s https://<worker-url>/admin/tenants -H "Authorization: Bearer <ADMIN_TOKEN>"   # → []
curl -s -o /dev/null -w '%{http_code}' https://<worker-url>/admin/tenants             # → 404 (no token)
```

Then the smoke: **Actions → `ghar-test` → Run workflow** — the DO constructor changed, so prove the provisioning path end-to-end: a `ghar-<jobId>` microVM must boot, run green, and disappear.

- [ ] **Step 6: Rollback readiness (only if the smoke fails)**

`bunx wrangler@latest rollback <version-id from Step 2>` — safe: the schema change is additive, old code never reads the new tables or column.

---

## Not in this plan (→ Plan 2 / Plan 3)

Tenant-aware admission, per-Tenant caps and TTLs, ledger writes, check runs, runner-group creation, GitHub client changes, `installation.id` parsing, `reconcile.ts` extraction, config removals (`GITHUB_ORG` etc. stay until the flag flips), Workers Paid upgrade, App creation/cutover, real NodeOps seed + backfill (runs at cutover with the new App's installation id — see Roadmap context).
