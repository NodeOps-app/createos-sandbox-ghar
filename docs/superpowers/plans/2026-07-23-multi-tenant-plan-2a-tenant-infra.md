# Multi-Tenant Plan 2a: Tenant Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every multi-tenant building block that is **inert in single mode** — the reconcile.ts extraction, the `TENANCY_MODE` flag, the DO's tenant admission read + per-tenant cap + weight column, ledger billing at teardown, and per-tenant GitHub identity with the runner-group/check-run endpoints — so deploying this plan changes **nothing** in production. Plan 2b then wires them into the multi-mode webhook/reconciler runtime.

**Scope note:** This is the first half of the original Plan 2, split at the infra/runtime seam (file-size rule). Tasks 1–5 here; the multi-mode webhook path, per-tenant TTL sweep, approval orchestration, multi-tenant reconciler, and the deploy checkpoint are Plan 2b (`2026-07-23-multi-tenant-plan-2b-tenant-runtime.md`). The Architecture paragraph below describes the full 2a+2b picture — this plan builds the parts, 2b connects them.

**Architecture:** The webhook queued path in `multi` mode becomes: identify label (pure, filters ~all traffic free) → one DO read `admitTenantJob` (tenant status + project + quota balance in one RPC) → pure shape-ceiling check → cached catalog validate → `onQueued` carrying `{tenantId, weight, cap}`. Billing writes happen in the one place every teardown already confirms (`markDestroyed`), using a **weight persisted at admission time** (commit `11fb56c`) with the quota.ts label parse as fallback for old rows. Per-tenant GitHub identity rides the existing `credentialSession` registry (already keyed by installation id). The reconciler gains a tenant loop; the reaper reads per-tenant TTLs via SQL join. Refusal check runs are deduped to one per (repo, UTC day) via a DO insert-or-ignore.

**Tech Stack:** unchanged — CF Workers + DO SQLite, TypeScript, zod, vitest + pool-workers, bun.

**Spec:** `docs/superpowers/specs/2026-07-22-multi-tenant-community-runners-design.md`
**Builds on (shipped, verified 2026-07-23):** Plan 1 — `quota.ts` (fractional-vCPU, last-token, prefix-strip parse), `registry.ts` (writes throw on unknown tenant; `removeProject` returns count), `admin.ts` (full-record upsert stamps `approved_at/by` only on transition into approved; status route refuses `approved`), Coordinator `admin*` RPC, tables `tenants`/`projects`/`usage`, `jobs.tenant_id`.

## Global Constraints

- **Performance and cost are priorities.** Hot-path budget in `multi` mode, enforced by design here: queued webhook = **2 DO calls** (`admitTenantJob` + `onQueued`; label identify runs first so non-createos jobs cost **0** DO calls); `completed`/`in_progress` stay **1**; provisioning gains **0** RPC (tenant fields ride `PendingJob`); teardown gains **+1 CreateOS subrequest** (bandwidth read) **only** for tenant-billed VMs that still exist (self-deleted VMs skip it); check runs cost **≤1 GitHub call + 1 DO row-write per repo per UTC day**. Any deviation from these numbers in implementation is a defect.
- **`TENANCY_MODE=single` (default) must be byte-for-byte today's behavior.** Every task's tests must keep the entire pre-existing suite green untouched (except explicitly listed import-path updates). The flag is read from config, never sniffed from data.
- **Additive-only DO migration** (columns `jobs.weight`, table `refusal_notices`). Old code rolling back ignores both.
- **A push to `main` is a production deploy.** Full gate (`bun run lint && bun run typecheck && bun run test`) before every push; capture the active version id first.
- **bun only**; no new deps in this plan. **No TDD** — implement, then test. **Never hit the network in tests** — mock at the `fetch` boundary; CreateOS via `SandboxDeps.makeClient`.
- **Do NOT touch the pins:** `@cloudflare/vitest-pool-workers@0.8.71`, `vitest@3.2.4`.
- **The Coordinator stays passive** — no network, imports only `./types`, `./registry`, `./quota` (all import-free/types-only). It must NEVER import `shapes.ts`.
- **Known harness trap (from Plan 1):** an exception crossing a real DO stub corrupts vitest-pool-workers isolated storage. Never let a DO method throw across a stub in tests — pre-check (as `admin.ts` does) or use `runInDurableObject`.
- **Files < 1100 lines**; `handler.ts` must END this plan smaller than it starts (Task 1 extracts ~270 lines to `reconcile.ts`).
- **Everything in this plan must be inert under `TENANCY_MODE=single`:** the flag parses but nothing branches on it yet (Plan 2b adds the branches); `admitTenantJob`/`shouldNotifyRefusal` exist but have no production caller; billing fires only on rows with a non-NULL `tenant_id`, which single mode never writes; the bandwidth read fires only on `TeardownTask.tenantId !== null`, likewise never in single mode; the `GitHubClient` tenant parameter has no production caller. Deploying 2a alone is a no-op by construction — the tests must prove the old suite green untouched.
- **No silent bounds** — every new cap/skip/fallback `console.warn`s with identifiers and counts.
- **Conventional Commits**, imperative ≤ 50 chars, atomic per task. Comment the why.
- Tests that stub `listShapes` call `resetShapeCacheForTests()` in `beforeEach`; tests that inject fetch into GitHub clients call `resetCredentialSessionsForTests()`.

---

### Task 1: Extract `src/reconcile.ts` (pure move, no behavior change)

**Files:**
- Create: `src/reconcile.ts`
- Modify: `src/handler.ts` (remove moved code; `export` shared helpers), `src/index.ts` (import from `./reconcile`)
- Modify: any test importing `runReconciler`/`runReaper` from `../../src/handler` (find with the rg below)

**Interfaces:**
- Consumes: `provisionAndRecord`, `destroyAndConfirm`, `failProvision` — these STAY in `handler.ts` and become `export`ed (they are the webhook path's provisioning core; reconcile shares them).
- Produces: `runReconciler(env: Bindings, deps?: SandboxDeps): Promise<void>` and `runReaper(env: Bindings, deps?: SandboxDeps): Promise<void>` exported from `src/reconcile.ts` with signatures identical to today's.

- [ ] **Step 1: Locate the move set and the import sites**

Run: `rg -n 'runReconciler|runReaper|sweepOrphaned|MAX_RUNNER_DELETES|MAX_SANDBOX_DESTROYS' src test`
The move set is everything in `handler.ts` from the `MAX_RUNNER_DELETES_PER_TICK` constant through the end of `runReaper` (reconciler steps A–D, both orphan sweeps, their doc comments). The webhook path, `provisionAndRecord`, `failProvision`, `destroyUnrecorded`, `destroyAndConfirm`, `logSpawnTimeline`, `logProvisionBreakdown`, `warnAdmission`, and the `coordinator()` helper stay.

- [ ] **Step 2: Create `src/reconcile.ts` and move the code verbatim**

Header comment for the new file:

```typescript
/**
 * Cron-side self-healing: the Reconciler (re-drive lost jobs, reap runner-less
 * VMs, delete orphaned registrations, sweep unowned sandboxes) and the age-only
 * Reaper backstop. Extracted from handler.ts so the webhook hot path and the
 * cron path evolve separately; both share the provisioning/teardown core that
 * stays in handler.ts (provisionAndRecord, destroyAndConfirm).
 */
```

Move the code without editing it. Add `export` to `provisionAndRecord`, `destroyAndConfirm`, and `failProvision` in `handler.ts`; import them plus `coordinator`-equivalent via a small exported `coordinator(env)` (export it too). Fix imports in both files (`reconcile.ts` needs: `loadConfig`, `GitHubClient`, `discoverQueuedJobs`, `createJobAdmission`/`identifyJob`, `fetchCatalog`, `jobIdFromRunnerName`, `jobIdFromSandboxName`, `sandboxNamesAreSweepable`, `teardownSandbox`, `makeSandboxClient`, `notify`, types).

- [ ] **Step 3: Update `src/index.ts` and test imports**

`src/index.ts`: `import { runReaper, runReconciler } from "./reconcile";` (drop them from the `./handler` import). Update any test found in Step 1 the same way.

- [ ] **Step 4: Gate**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: green, zero test-body changes — imports only.

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts src/handler.ts src/index.ts test
git commit -m "refactor: extract cron reconcile/reap into reconcile.ts"
```

---

### Task 2: Tenancy flag + webhook `installation.id`/`head_sha`

**Files:**
- Modify: `src/types.ts` (`Config`, `WorkflowJob`), `src/config.ts`, `src/webhook.ts`
- Test: `test/unit/config.test.ts`, `test/unit/webhook.test.ts` (extend)

**Interfaces:**
- Produces:
  - `Config.tenancyMode: "single" | "multi"` (env `TENANCY_MODE`, default `"single"`, anything else throws)
  - `Config.communityBandwidthBytes: number` (env `COMMUNITY_VM_BANDWIDTH_BYTES`, default `107_374_182_400` = 100 GB, spec D15)
  - `Config.applyFormUrl: string` (env `APPLY_FORM_URL`, default `""`; check-run copy says "contact the operators" when empty)
  - `WorkflowJob.installationId?: number`, `WorkflowJob.headSha?: string`

- [ ] **Step 1: Types**

`src/types.ts` — in `Config` after `adminToken`:

```typescript
  // Multi-tenancy master switch. "single" = the pre-tenant behavior, verbatim.
  tenancyMode: "single" | "multi";
  communityBandwidthBytes: number; // per-VM egress quota for community tenants (D15)
  applyFormUrl: string; // onboarding form link used in refusal check runs ("" = generic copy)
```

In `WorkflowJob` after `runnerName`:

```typescript
  installationId?: number; // installation.id — the Tenant key in multi mode
  headSha?: string; // workflow_job.head_sha — anchor for refusal check runs
```

- [ ] **Step 2: Config parsing**

`src/config.ts`, in the returned object:

```typescript
    tenancyMode: mode(env),
    communityBandwidthBytes: num(env, "COMMUNITY_VM_BANDWIDTH_BYTES", 107_374_182_400),
    applyFormUrl: (env.APPLY_FORM_URL as string) || "",
```

And above `loadConfig`:

```typescript
// The tenancy switch is a trust boundary like PROVISION_POLICY: an unknown
// value must fail startup, not silently mean "single".
function mode(env: Record<string, unknown>): "single" | "multi" {
  const v = (env.TENANCY_MODE as string) || "single";
  if (v !== "single" && v !== "multi") throw new Error(`invalid TENANCY_MODE: ${v}`);
  return v;
}
```

- [ ] **Step 3: Webhook parse**

`src/webhook.ts`, in `parseWorkflowJob` before the `return`:

```typescript
  const installation = isObject(p.installation) && isPosInt(p.installation.id)
    ? p.installation.id
    : undefined;
  const headSha = isNonEmptyString(wj.head_sha) ? wj.head_sha : undefined;
```

Add `installationId: installation, headSha,` to the returned object.

- [ ] **Step 4: Tests**

`test/unit/config.test.ts` — append:

```typescript
it("tenancyMode defaults single, accepts multi, rejects junk", () => {
  expect(loadConfig(base()).tenancyMode).toBe("single");
  expect(loadConfig({ ...base(), TENANCY_MODE: "multi" }).tenancyMode).toBe("multi");
  expect(() => loadConfig({ ...base(), TENANCY_MODE: "dual" })).toThrow(/TENANCY_MODE/);
});
```

(`base()` = the file's existing valid-env helper; reuse its actual name.)

`test/unit/webhook.test.ts` — append:

```typescript
it("extracts installation.id and head_sha when present, omits when malformed", () => {
  const body = JSON.stringify({
    action: "queued",
    workflow_job: { id: 1, run_id: 2, labels: ["createos"], head_sha: "abc123" },
    repository: { full_name: "o/r" },
    installation: { id: 555 },
  });
  const job = parseWorkflowJob(body)!;
  expect(job.installationId).toBe(555);
  expect(job.headSha).toBe("abc123");

  const noInstall = JSON.stringify({
    action: "queued",
    workflow_job: { id: 1, run_id: 2, labels: [] },
    repository: { full_name: "o/r" },
    installation: { id: "nope" },
  });
  expect(parseWorkflowJob(noInstall)?.installationId).toBeUndefined();
});
```

- [ ] **Step 5: Gate, commit**

Run: `bun run lint && bun run typecheck && bun run test` → green.

```bash
git add src/types.ts src/config.ts src/webhook.ts test/unit/config.test.ts test/unit/webhook.test.ts
git commit -m "feat: add tenancy flag and webhook tenant fields"
```

---

### Task 3: Coordinator — `admitTenantJob`, tenant-aware `onQueued`, schema

**Files:**
- Modify: `src/types.ts` (new DO contract types; `PendingJob` gains `tenant`), `src/coordinator.ts`
- Test: `test/integration/tenancy.test.ts` (new)

**Interfaces:**
- Produces (Plan 2b consumes):

```typescript
/** Tenant fields a provision needs — joined onto every PendingJob the DO returns. */
export interface PendingTenant {
  installationId: number;
  orgLogin: string;
  runnerGroupId: number | null;
  allowAllRepos: boolean;
}

/** DO → Worker: one-read tenant admission (gates 1, 2, and the quota balance). */
export type TenantAdmission =
  | { kind: "unknown-tenant" }
  | { kind: "not-approved"; status: TenantStatus }
  | { kind: "repo-not-approved"; orgLogin: string }
  | {
      kind: "ok";
      tenant: PendingTenant;
      concurrencyCap: number;
      maxShape: string;
      minuteGrant: number;
      usedMinutes: number;
      jobTtlMs: number;
    };

/** Worker → DO alongside onQueued in multi mode. */
export interface TenantCtx {
  tenantId: number;
  weight: number; // billing weight persisted on the row (11fb56c)
  cap: number; // the tenant's concurrency cap, pre-read by admitTenantJob
}
```

- `PendingJob` gains `tenant: PendingTenant | null` (null = single-mode/pre-migration row).
- Coordinator: `admitTenantJob(installationId: number, repoFullName: string, month: string): TenantAdmission`; `onQueued(job, deliveryId, tenantCtx?: TenantCtx)`; `shouldNotifyRefusal(installationId: number, repoFullName: string, day: string): boolean`.
- Schema: `jobs.weight REAL` column; `refusal_notices` table.

- [ ] **Step 1: Types** — add the three types above to `src/types.ts`; change `PendingJob`:

```typescript
  /** Tenant owning this job (multi mode); null for single-mode rows. */
  tenant: PendingTenant | null;
```

- [ ] **Step 2: Schema** — constructor DDL gains:

```sql
      CREATE TABLE IF NOT EXISTS refusal_notices (
        installation_id INTEGER NOT NULL,
        repo_full_name  TEXT NOT NULL,
        day             TEXT NOT NULL,
        PRIMARY KEY (installation_id, repo_full_name, day)
      );
```

Column-guard block gains:

```typescript
    if (!has("weight")) this.#sql.exec(`ALTER TABLE jobs ADD COLUMN weight REAL`);
```

`Row` gains `weight: number | null;`. Extend the migration comment: a NULL `weight` bills via the quota.ts label parse at teardown (the pre-persisted-weight behavior).

- [ ] **Step 3: `admitTenantJob`** — new method (reads only; 3 row reads max):

```typescript
  /**
   * Gates 1+2 and the quota balance in ONE hot-path read. Runs before onQueued
   * so an unapproved org/repo costs exactly one RPC and no row insert. Passive:
   * pure SELECTs, no clock, no writes.
   */
  admitTenantJob(installationId: number, repoFullName: string, month: string): TenantAdmission {
    const t = getTenant(this.#sql, installationId);
    if (!t) return { kind: "unknown-tenant" };
    if (t.status !== "approved") return { kind: "not-approved", status: t.status };
    if (!t.allowAllRepos) {
      const ok = this.#sql
        .exec(
          `SELECT 1 FROM projects WHERE installation_id = ? AND repo_full_name = ?`,
          installationId,
          repoFullName,
        )
        .toArray();
      if (ok.length === 0) return { kind: "repo-not-approved", orgLogin: t.orgLogin };
    }
    const used = this.#sql
      .exec(
        `SELECT weighted_minutes FROM usage
          WHERE installation_id = ? AND month = ? AND repo_full_name = ''`,
        installationId,
        month,
      )
      .toArray() as { weighted_minutes: number }[];
    return {
      kind: "ok",
      tenant: {
        installationId: t.installationId,
        orgLogin: t.orgLogin,
        runnerGroupId: t.runnerGroupId,
        allowAllRepos: t.allowAllRepos,
      },
      concurrencyCap: t.concurrencyCap,
      maxShape: t.maxShape,
      minuteGrant: t.minuteGrant,
      usedMinutes: used[0]?.weighted_minutes ?? 0,
      jobTtlMs: t.jobTtlMs,
    };
  }

  /**
   * One refusal notice per (tenant, repo, UTC day): INSERT OR IGNORE, and the
   * caller posts a check run only when this returns true. Bounds check-run spam
   * and its GitHub-call cost by construction.
   */
  shouldNotifyRefusal(installationId: number, repoFullName: string, day: string): boolean {
    this.#sql.exec(
      `INSERT OR IGNORE INTO refusal_notices (installation_id, repo_full_name, day)
       VALUES (?, ?, ?)`,
      installationId,
      repoFullName,
      day,
    );
    const row = this.#sql.exec(`SELECT changes() AS n`).one() as { n: number };
    return row.n === 1;
  }
```

- [ ] **Step 4: Tenant-aware `onQueued`** — add the optional third parameter. Changes inside the existing method:

1. Signature: `async onQueued(job: PendingJob, deliveryId: string, tenantCtx?: TenantCtx): Promise<QueuedDecision>`.
2. The INSERT stamps `tenant_id` and `weight` from `tenantCtx` (NULL when absent).
3. Cap check: the existing global `MAX_CONCURRENT` test stays (operator backstop, gate 10); when `tenantCtx` is present ALSO count `WHERE state IN ('provisioning','running') AND tenant_id = ?` against `tenantCtx.cap` — whichever binds first queues the job. Comment: per-tenant cap is gate 6; the global cap remains as the plan-capacity backstop.

- [ ] **Step 5: Join `tenant` onto every returned `PendingJob`** — every site that builds a `PendingJob` from a row (the pending-promotion helper used by `onCompleted`, `markProvisionFailed`, `sweep`, `reapUnregistered`, and `pendingSnapshot` if present) gains a LEFT JOIN:

```sql
LEFT JOIN tenants ON tenants.installation_id = jobs.tenant_id
```

and maps `tenant: row.installation_id ? { installationId, orgLogin, runnerGroupId, allowAllRepos: allow_all_repos === 1 } : null`. Single query change per site; do them all in this task so the type change compiles everywhere at once (webhook-path construction sites in `handler.ts`/`admission.ts` set `tenant: null` for now — Plan 2b wires the real value).

- [ ] **Step 6: Tests** — `test/integration/tenancy.test.ts`:

```typescript
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

describe("shouldNotifyRefusal", () => {
  it("first call per (repo, day) true, repeats false, new day true again", async () => {
    const s = stub("ref-" + Math.random());
    expect(await s.shouldNotifyRefusal(1, "o/r", "2026-07-23")).toBe(true);
    expect(await s.shouldNotifyRefusal(1, "o/r", "2026-07-23")).toBe(false);
    expect(await s.shouldNotifyRefusal(1, "o/r", "2026-07-24")).toBe(true);
  });
});
```

- [ ] **Step 7: Gate, commit**

Run: `bun run lint && bun run typecheck && bun run test` → green (typecheck forces every `PendingJob` construction site to declare `tenant` — the compiler is the checklist).

```bash
git add src/types.ts src/coordinator.ts src/handler.ts src/admission.ts test/integration/tenancy.test.ts
git commit -m "feat: tenant admission read and per-tenant cap in DO"
```

---

### Task 4: Ledger — bill at `markDestroyed`, egress best-effort

**Files:**
- Modify: `src/quota.ts` (add `dayKey`), `src/coordinator.ts` (`markDestroyed`), `src/createos.ts` (`SandboxHandle` gains `getBandwidth`), `src/sandbox.ts` (`teardownSandbox` returns egress), `src/handler.ts` (`destroyAndConfirm` forwards), `src/types.ts` (`TeardownTask` gains `tenantId`)
- Test: `test/integration/tenancy.test.ts` (extend), `test/unit/quota.test.ts` (extend), plus update `test/helpers/mocks.ts` sandbox double with a `getBandwidth` stub

**Interfaces:**
- Produces:
  - `quota.dayKey(nowMs: number): string` → `"2026-07-23"` (UTC; Plan 2b's refusal dedup key)
  - `TeardownTask.tenantId: number | null` — bandwidth is read at teardown **only** when non-null (cost gate)
  - `teardownSandbox(config, sandboxId, deps): Promise<number | null>` — egress `used_bytes`, null when unavailable/self-deleted
  - `markDestroyed(jobId: number, egressBytes?: number): Promise<void>` — writes the ledger before deleting the row

- [ ] **Step 1: `dayKey` in `src/quota.ts`**

```typescript
/** The UTC calendar-day bucket: "2026-07-23". Refusal-notice dedup key. */
export function dayKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${monthKey(nowMs)}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
```

Unit test: `expect(dayKey(Date.UTC(2026, 6, 23, 23, 59))).toBe("2026-07-23")` and the UTC rollover to `"2026-07-24"` at `Date.UTC(2026, 6, 23, 24, 0)`.

- [ ] **Step 2: `TeardownTask.tenantId`** — add `tenantId: number | null;` in `types.ts`; `#retireRow` populates it from `row.tenant_id ?? null`. Fix the handful of test fixtures that assert `toEqual({ jobId, sandboxId })` to include `tenantId: null`.

- [ ] **Step 3: Bill in `markDestroyed`** — at the top of the existing method, before the row is deleted:

```typescript
  async markDestroyed(jobId: number, egressBytes?: number): Promise<void> {
    const rows = this.#sql
      .exec(`SELECT * FROM jobs WHERE job_id = ?`, jobId)
      .toArray() as Row[];
    const row = rows[0];
    // Bill exactly here: every teardown path (webhook, reaper, reconciler,
    // provision-failure) confirms through this one method, and D9 bills VM
    // lifetime booted_at → destroy confirmation. A row that never booted ran
    // no VM and bills nothing. Weight was persisted at admission (11fb56c);
    // a NULL weight is a pre-migration row — fall back to the label parse.
    if (row?.tenant_id && row.booted_at) {
      const weight =
        row.weight ??
        weightForLabel(
          row.label ?? this.env.RUNNER_LABEL,
          this.env.RUNNER_LABEL,
          this.env.RUNNER_SHAPE,
        );
      const minutes = (Math.max(0, Date.now() - row.booted_at) / 60_000) * weight;
      const month = monthKey(Date.now());
      const bill = (repo: string, egress: number) =>
        this.#sql.exec(
          `INSERT INTO usage (installation_id, month, repo_full_name, weighted_minutes, egress_bytes)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(installation_id, month, repo_full_name) DO UPDATE SET
             weighted_minutes = weighted_minutes + excluded.weighted_minutes,
             egress_bytes = egress_bytes + excluded.egress_bytes`,
          row.tenant_id,
          month,
          repo,
          minutes,
          egress,
        );
      bill("", egressBytes ?? 0); // tenant total — the enforcement row
      bill(row.repo, egressBytes ?? 0); // per-Project attribution (D3)
    }
    // ...existing deletion logic unchanged...
  }
```

Env interface in `coordinator.ts` gains `RUNNER_SHAPE: string;` (the binding already exists in wrangler.toml/vitest). Import `monthKey, weightForLabel` from `./quota`.

- [ ] **Step 4: Egress read at teardown**

`src/createos.ts` — `SandboxHandle` gains:

```typescript
  getBandwidth(): Promise<{ used_bytes: number }>;
```

`src/sandbox.ts`:

```typescript
export async function teardownSandbox(
  config: Config,
  sandboxId: string,
  deps: SandboxDeps = {},
  readEgress = false,
): Promise<number | null> {
  const c = makeSandboxClient(config, deps);
  try {
    const handle = await c.getSandbox(sandboxId);
    let egress: number | null = null;
    if (readEgress) {
      // Best-effort and alert-only (D15): a bandwidth read must never block a
      // destroy, and it is skipped entirely for un-billed VMs (cost gate).
      try {
        egress = (await handle.getBandwidth()).used_bytes;
      } catch (err) {
        console.warn(`bandwidth read failed sandbox=${sandboxId}: ${String(err)}`);
      }
    }
    await handle.destroy();
    return egress;
  } catch (err) {
    if (err instanceof CreateosSandboxNotFoundError) return null;
    throw err;
  }
}
```

`src/handler.ts` `destroyAndConfirm`:

```typescript
    const egress = await teardownSandbox(config, task.sandboxId, deps, task.tenantId !== null);
    await coordinator(env).markDestroyed(task.jobId, egress ?? undefined);
```

Update the sandbox client double in `test/helpers/mocks.ts` (and any inline doubles) so handles expose `getBandwidth: async () => ({ used_bytes: 0 })`.

- [ ] **Step 5: Tests** — extend `test/integration/tenancy.test.ts`:

```typescript
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
        .exec(`SELECT repo_full_name, weighted_minutes, egress_bytes FROM usage ORDER BY repo_full_name`)
        .toArray();
      expect(rows).toHaveLength(2); // "" total + org1/app — nothing from job 12
      expect(rows[0].repo_full_name).toBe("");
      expect(rows[0].egress_bytes).toBe(5_000);
      expect(rows[0].weighted_minutes as number).toBeGreaterThanOrEqual(0);
      expect(rows[1].repo_full_name).toBe("org1/app");
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
```

- [ ] **Step 6: Gate, commit**

```bash
git add src/quota.ts src/coordinator.ts src/createos.ts src/sandbox.ts src/handler.ts src/types.ts test
git commit -m "feat: bill VM lifetime to the ledger at teardown"
```

---

### Task 5: Per-tenant GitHub identity + runner-group/check-run endpoints

**Files:**
- Modify: `src/github/auth.ts` (`credentialSession` installation override), `src/github/client.ts` (tenant identity + 3 endpoints)
- Test: `test/unit/auth.test.ts`, `test/unit/client.test.ts` (extend)

**Interfaces:**
- Produces:
  - `credentialSession(config, fetchImpl?, installationId?)` — session keyed on the **effective** installation id
  - `GitHubClient` constructor: `(config, fetchImpl?, tenant?: GitHubTenant)` where `GitHubTenant = { orgLogin: string; installationId: number; runnerGroupId?: number | null }`; all org-scoped paths use `tenant?.orgLogin ?? config.githubOrg`; `generateJitConfig` uses `tenant?.runnerGroupId ?? config.runnerGroupId`
  - `createRunnerGroup(name: string, repoIds: number[]): Promise<number>` — `POST /orgs/{org}/actions/runner-groups` `{name, visibility: "selected", selected_repository_ids}`; on 409/422 name-exists, resolves the existing group by name via `GET .../runner-groups?per_page=100`, calls `setRunnerGroupRepos`, returns its id (idempotent approval retries)
  - `setRunnerGroupRepos(groupId: number, repoIds: number[]): Promise<void>` — `PUT /orgs/{org}/actions/runner-groups/{id}/repositories` `{selected_repository_ids}`
  - `createCheckRun(repoFullName: string, headSha: string, title: string, summary: string): Promise<void>` — `POST /repos/{repo}/check-runs` with `name: "createos-runners"`, `status: "completed"`, **`conclusion: "neutral"`** (a refusal must inform, never fail their CI)

- [ ] **Step 1: `auth.ts`** — add the third parameter; the only changes:

```typescript
export function credentialSession(
  config: Config,
  fetchImpl: FetchLike = fetch.bind(globalThis),
  installationId?: string,
): TokenCache {
  const effective = installationId ?? config.githubInstallationId;
  const key = `${config.githubAppId}|${effective}|${config.githubApiUrl}`;
  // ...unchanged except TokenCache receives `effective`...
}
```

- [ ] **Step 2: `client.ts`** — constructor gains `private tenant?: GitHubTenant` (exported interface); `this.#tokens = credentialSession(config, fetchImpl, tenant ? String(tenant.installationId) : undefined);` add `get #org() { return this.tenant?.orgLogin ?? this.config.githubOrg; }` and replace `this.config.githubOrg` with `this.#org` in every org-scoped URL (`generate-jitconfig`, `listRunners`, `deleteRunner`); `runner_group_id: this.tenant?.runnerGroupId ?? this.config.runnerGroupId`. Then the three new methods, each following the file's existing fetch/error pattern and counting `#subrequests` like the others:

```typescript
  /** Creates (or idempotently adopts) the org's selected-visibility runner
   * group. Gate 3: the GitHub-side execution boundary. */
  async createRunnerGroup(name: string, repoIds: number[]): Promise<number> {
    const res = await this.fetchImpl(
      `${this.config.githubApiUrl}/orgs/${this.#org}/actions/runner-groups`,
      {
        method: "POST",
        headers: await this.#headers(),
        body: JSON.stringify({
          name,
          visibility: "selected",
          selected_repository_ids: repoIds,
        }),
      },
    );
    this.#subrequests++;
    if (res.ok) return ((await res.json()) as { id: number }).id;
    if (res.status === 409 || res.status === 422) {
      // Name already exists (an earlier approval attempt died mid-way):
      // adopt it and converge its repo list instead of failing the approval.
      const existing = await this.#findRunnerGroup(name);
      if (existing !== null) {
        await this.setRunnerGroupRepos(existing, repoIds);
        return existing;
      }
    }
    throw new Error(`create runner group failed: ${res.status} ${await res.text()}`);
  }

  async #findRunnerGroup(name: string): Promise<number | null> {
    const res = await this.fetchImpl(
      `${this.config.githubApiUrl}/orgs/${this.#org}/actions/runner-groups?per_page=100`,
      { method: "GET", headers: await this.#headers() },
    );
    this.#subrequests++;
    if (!res.ok) return null;
    const body = (await res.json()) as { runner_groups?: { id?: number; name?: string }[] };
    return body.runner_groups?.find((g) => g.name === name)?.id ?? null;
  }

  async setRunnerGroupRepos(groupId: number, repoIds: number[]): Promise<void> {
    const res = await this.fetchImpl(
      `${this.config.githubApiUrl}/orgs/${this.#org}/actions/runner-groups/${groupId}/repositories`,
      {
        method: "PUT",
        headers: await this.#headers(),
        body: JSON.stringify({ selected_repository_ids: repoIds }),
      },
    );
    this.#subrequests++;
    if (!res.ok) throw new Error(`set runner group repos failed: ${res.status} ${await res.text()}`);
  }

  /** Refusal notice on the tenant's commit. conclusion=neutral on purpose:
   * inform without failing their CI. */
  async createCheckRun(
    repoFullName: string,
    headSha: string,
    title: string,
    summary: string,
  ): Promise<void> {
    const res = await this.fetchImpl(
      `${this.config.githubApiUrl}/repos/${repoFullName}/check-runs`,
      {
        method: "POST",
        headers: await this.#headers(),
        body: JSON.stringify({
          name: "createos-runners",
          head_sha: headSha,
          status: "completed",
          conclusion: "neutral",
          output: { title, summary },
        }),
      },
    );
    this.#subrequests++;
    if (!res.ok) throw new Error(`check run failed: ${res.status} ${await res.text()}`);
  }
```

(If the file counts subrequests inside a shared request helper instead, follow that pattern and drop the manual increments.)

- [ ] **Step 3: Tests** — `test/unit/auth.test.ts`: two sessions for two installation ids are distinct objects; same id returns the same instance. `test/unit/client.test.ts` with the existing `mockFetch` helper (remember `resetCredentialSessionsForTests()` in `beforeEach`):

```typescript
it("tenant identity routes org paths and jit runner group", async () => {
  const calls: string[] = [];
  const f = mockFetch({
    "POST /app/installations/777/access_tokens": () =>
      new Response(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString() })),
    "POST /orgs/acme/actions/runners/generate-jitconfig": (req) => {
      calls.push(req.url);
      return new Response(JSON.stringify({ encoded_jit_config: "jit" }));
    },
  });
  const c = new GitHubClient(cfg(), f, { orgLogin: "acme", installationId: 777, runnerGroupId: 42 });
  await c.generateJitConfig("cos-1-aa", "createos");
  expect(calls[0]).toContain("/orgs/acme/");
});

it("createRunnerGroup adopts an existing group on 409", async () => {
  const put: string[] = [];
  const f = mockFetch({
    "POST /app/installations": () =>
      new Response(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString() })),
    "POST /orgs/acme/actions/runner-groups": () => new Response("exists", { status: 409 }),
    "GET /orgs/acme/actions/runner-groups?per_page=100": () =>
      new Response(JSON.stringify({ runner_groups: [{ id: 42, name: "createos" }] })),
    "PUT /orgs/acme/actions/runner-groups/42/repositories": (req) => {
      put.push(req.url);
      return new Response(null, { status: 204 });
    },
  });
  const c = new GitHubClient(cfg(), f, { orgLogin: "acme", installationId: 777 });
  expect(await c.createRunnerGroup("createos", [1, 2])).toBe(42);
  expect(put).toHaveLength(1);
});
```

(`cfg()` = the file's existing config fixture; reuse its actual name. Route-key strings must match the mockFetch substring convention already used in the file.)

- [ ] **Step 4: Gate, commit**

```bash
git add src/github/auth.ts src/github/client.ts test/unit/auth.test.ts test/unit/client.test.ts
git commit -m "feat: per-tenant github identity and org endpoints"
```

---


## Self-review checklist (run before handing off to Plan 2b)

- Every `PendingJob` literal in src AND tests now has `tenant` — the compiler enforces; grep `test/helpers/fixtures.ts` too.
- `admitTenantJob` numbers: unknown org costs 1 DO read; approved+ok costs ≤3 row reads. No writes on any path except the notice insert.
- Full pre-existing suite green with zero test-body changes beyond the listed ones: import paths (Task 1), `TeardownTask.tenantId` fixture additions (Task 4), `PendingJob.tenant` additions (Task 3).
- No production code path reaches any new function while `TENANCY_MODE=single` (rg for callers of `admitTenantJob`, `shouldNotifyRefusal`, `createRunnerGroup`, `createCheckRun` — test files only).

## Continues in Plan 2b

`2026-07-23-multi-tenant-plan-2b-tenant-runtime.md` — multi-mode webhook admission + provisioning + check runs, per-tenant TTL sweep, admin approval orchestration (runner group fail-closed), multi-tenant reconciler, docs + the flag-off deploy checkpoint.
