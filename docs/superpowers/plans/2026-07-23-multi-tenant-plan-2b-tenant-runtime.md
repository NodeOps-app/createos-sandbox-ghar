# Multi-Tenant Plan 2b: Tenant Runtime (Flag-Gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Plan 2a's tenant infrastructure into the running system — multi-mode webhook admission + provisioning + refusal check runs, per-tenant job TTL, fail-closed runner-group approval, and the multi-tenant reconciler — all behind `TENANCY_MODE` still defaulting to `single`, ending in a production deploy that changes **nothing** until Plan 3 flips the flag.

**Architecture:** The `multi` queued path: identify label (pure, filters ~all traffic at zero cost) → `admitTenantJob` (one DO read: gates 1+2 + quota balance) → pure shape-ceiling check (gate 5) → quota gate (7) → cached catalog validate → `onQueued` with `{tenantId, weight, cap}` (gate 6). Refusals post one neutral check run per (repo, UTC day). The reconciler loops approved tenants with a shared subrequest budget and a `(tenant, repo)` cursor; recovered jobs re-enter through the exact same admission function as the webhook (parity by construction). The reaper reads per-tenant TTLs via SQL join (gate 8).

**Tech Stack:** unchanged — CF Workers + DO SQLite, TypeScript, zod, vitest + pool-workers, bun.

**Spec:** `docs/superpowers/specs/2026-07-22-multi-tenant-community-runners-design.md`
**Builds on:** Plan 2a (`2026-07-23-multi-tenant-plan-2a-tenant-infra.md`) — MUST be merged first. Interfaces this plan consumes, exactly as 2a produced them:

```typescript
// Coordinator (DO RPC)
admitTenantJob(installationId: number, repoFullName: string, month: string): TenantAdmission
onQueued(job: PendingJob, deliveryId: string, tenantCtx?: TenantCtx): Promise<QueuedDecision>
shouldNotifyRefusal(installationId: number, repoFullName: string, day: string): boolean
markDestroyed(jobId: number, egressBytes?: number): Promise<void>
// types.ts
PendingTenant { installationId; orgLogin; runnerGroupId; allowAllRepos }
TenantAdmission = unknown-tenant | not-approved | repo-not-approved
  | { kind: "ok"; tenant; concurrencyCap; maxShape; minuteGrant; usedMinutes; jobTtlMs }
TenantCtx { tenantId; weight; cap }
PendingJob.tenant: PendingTenant | null      TeardownTask.tenantId: number | null
// quota.ts: monthKey, dayKey, weightForLabel     config: tenancyMode, communityBandwidthBytes, applyFormUrl
// github: new GitHubClient(config, fetchImpl?, tenant?: GitHubTenant)
//   createRunnerGroup(name, repoIds) → id (409-adopts) · setRunnerGroupRepos(id, repoIds) · createCheckRun(repo, sha, title, summary)
// sandbox.ts: teardownSandbox(config, id, deps, readEgress?) → egress bytes | null
```

## Global Constraints

Identical to Plan 2a — restated where they bind hardest here:

- **Performance and cost are priorities.** Multi-mode hot-path budget (deviation = defect): queued webhook = **2 DO calls**, non-createos jobs = **0**; `completed`/`in_progress` = **1**; provisioning = **0 extra RPC** (tenant rides `PendingJob`); check runs ≤ **1 GitHub call + 1 DO row-write per repo per UTC day**; reconciler = **1 `adminListTenants` RPC per tick** plus the budgeted scan.
- **`TENANCY_MODE=single` stays byte-for-byte today's behavior**; the pre-existing suite stays green untouched.
- **A push to `main` is a production deploy** — full gate first, capture the rollback version id.
- **bun only; no TDD; never hit the network in tests** (GitHub via `mockFetch`, CreateOS via `SandboxDeps.makeClient`); pins untouched (`@cloudflare/vitest-pool-workers@0.8.71`, `vitest@3.2.4`).
- **Coordinator stays passive**; never imports `shapes.ts`. **No throws across DO stubs in tests** (harness trap) — pre-check or `runInDurableObject`.
- **No silent bounds**; **Conventional Commits** atomic per task; files < 1100 lines.
- Tests stubbing shapes/fetch call `resetShapeCacheForTests()` / `resetCredentialSessionsForTests()` in `beforeEach`.

---

### Task 1: Multi-mode webhook admission + provisioning + check runs

**Files:**
- Modify: `src/shapes.ts` (`shapeWithinCeiling`), `src/handler.ts` (queued path + `provisionAndRecord` + refusal notices), `src/sandbox.ts` (`createRunnerSandbox` bandwidth + tenant client)
- Test: `test/unit/shapes.test.ts` (extend), `test/integration/tenancy-webhook.test.ts` (new)

**Interfaces:**
- Consumes: everything in the Builds-on block.
- Produces:
  - `shapeWithinCeiling(shape: string, ceiling: string): boolean` in `shapes.ts` — pure; **unparseable input returns false** (fail closed at a security gate) and warns.
  - `admitAndDrive(env, config, job, ctx, deps, scope): Promise<string>` exported from `handler.ts` — the ONE multi-mode admission function; Task 4's reconciler reuses it verbatim (webhook/reconciler parity, same guarantee `admission.ts` gives single mode).

- [ ] **Step 1: `shapeWithinCeiling`** in `src/shapes.ts`:

```typescript
const SHAPE_SIZE_RE = /^s-(\d+(?:\.\d+)?)vcpu-(\d+)(gb|mb)$/;

/**
 * Gate 5: is `shape` within the tenant's ceiling on BOTH axes? Fail closed:
 * anything unparseable is over the ceiling — a shape we cannot size must not
 * slip past a security gate — and warns (no-silent-bounds).
 */
export function shapeWithinCeiling(shape: string, ceiling: string): boolean {
  const s = SHAPE_SIZE_RE.exec(shape);
  const c = SHAPE_SIZE_RE.exec(ceiling);
  if (!s || !c) {
    console.warn(`shape ceiling: cannot parse "${shape}" vs "${ceiling}"; refusing`);
    return false;
  }
  const mb = (m: RegExpExecArray) => Number(m[2]) * (m[3] === "gb" ? 1024 : 1);
  return Number(s[1]) <= Number(c[1]) && mb(s) <= mb(c);
}
```

Unit tests: equal shapes pass; `s-8vcpu-16gb` vs `s-4vcpu-8gb` fails; `s-2vcpu-16gb` vs `s-4vcpu-8gb` fails (memory axis); `s-0.5vcpu-512mb` vs `s-4vcpu-8gb` passes; junk fails.

- [ ] **Step 2: `admitAndDrive` in `handler.ts`** — the whole multi-mode ladder in one exported function so webhook and reconciler share it:

```typescript
/**
 * Multi-mode admission + drive: label → tenant gates → shape ceiling → quota
 * → catalog → onQueued/provision. The ONE path a queued job takes in multi
 * mode, whether it arrived by webhook or recovery scan (`scope` labels the
 * caller for logs, same convention as warnAdmission). Returns the decision
 * word used as the webhook response body.
 */
export async function admitAndDrive(
  env: Bindings,
  config: Config,
  job: WorkflowJob,
  ctx: { waitUntil(p: Promise<unknown>): void },
  deps: SandboxDeps,
  scope: string,
): Promise<string> {
  const co = coordinator(env);
  // Label first: pure, filters every non-createos job in the granted repos at
  // zero DO/GitHub cost. Refusal notices only fire for jobs that explicitly
  // asked for our label.
  const ident = identifyJob(job, config);
  if (ident.kind === "none") return "no-label";
  if (ident.kind === "ambiguous") {
    warnAdmission(scope, job, { kind: "refused", reason: "ambiguous-label", labels: ident.labels });
    return "ambiguous-label";
  }
  if (job.installationId === undefined) {
    console.warn(`${scope}job ${job.jobId} (${job.repoFullName}): no installation id on payload`);
    return "no-installation";
  }

  const admission = await co.admitTenantJob(
    job.installationId,
    job.repoFullName,
    monthKey(Date.now()),
  );
  if (admission.kind !== "ok") {
    ctx.waitUntil(notifyRefusal(env, config, job, refusalCopy(admission, config)));
    return admission.kind;
  }

  const shape = shapeForLabel(ident.label, config);
  if (!shapeWithinCeiling(shape, admission.maxShape)) {
    ctx.waitUntil(
      notifyRefusal(env, config, job, {
        title: "Requested runner size exceeds this org's limit",
        summary:
          `\`${ident.label}\` maps to \`${shape}\`, above your approved ceiling ` +
          `\`${admission.maxShape}\`. Use a smaller \`runs-on\` label${contactCopy(config)}`,
      }),
    );
    return "shape-over-ceiling";
  }

  if (admission.usedMinutes >= admission.minuteGrant) {
    ctx.waitUntil(
      notifyRefusal(env, config, job, {
        title: "CreateOS runner minutes exhausted",
        summary:
          `This org has used ${Math.round(admission.usedMinutes)} of its ` +
          `${admission.minuteGrant} weighted minutes for ${monthKey(Date.now())}. ` +
          `Quota resets on the 1st (UTC)${contactCopy(config)}`,
      }),
    );
    ctx.waitUntil(
      notify(config, `ghar quota exhausted — ${admission.tenant.orgLogin} (${job.repoFullName})`),
    );
    return "quota-exhausted";
  }

  // Catalog validation exactly as the single path does it (shared rule).
  const catalogAdmit = createJobAdmission(config, {
    isForkJob: () => Promise.resolve(false), // gates 1-2 replace fork policy in multi mode
    loadCatalog: () => fetchCatalog(config, deps),
  });
  const admitted = await catalogAdmit(job);
  if (admitted.kind === "refused") {
    warnAdmission(scope, job, admitted);
    return admitted.reason;
  }

  const pending: PendingJob = { ...admitted.job, tenant: admission.tenant };
  const delivery = job.deliveryId ?? crypto.randomUUID();
  const decision = await co.onQueued(pending, delivery, {
    tenantId: admission.tenant.installationId,
    weight: weightForLabel(ident.label, config.runnerLabel, config.runnerShape),
    cap: admission.concurrencyCap,
  });
  if (decision.action === "provision") {
    ctx.waitUntil(provisionAndRecord(env, pending, deps));
  }
  return decision.action;
}
```

`WorkflowJob` gains `deliveryId?: string` (set by `handleWebhook` from the `X-GitHub-Delivery` header before calling; the reconciler leaves it unset so recovered jobs mint a UUID — matching today's reconciler dedup behavior). `handleWebhook`'s queued branch becomes:

```typescript
  if (job.action === "queued") {
    if (config.tenancyMode === "multi") {
      job.deliveryId = delivery;
      const word = await admitAndDrive(env, config, job, ctx, deps, "");
      return new Response(word, { status: 202 });
    }
    // ...existing single-mode block, untouched...
  }
```

Helpers at module level in `handler.ts`:

```typescript
function contactCopy(config: Config): string {
  return config.applyFormUrl ? ` — details/apply: ${config.applyFormUrl}` : ".";
}

function refusalCopy(
  admission:
    | { kind: "unknown-tenant" }
    | { kind: "not-approved"; status: TenantStatus }
    | { kind: "repo-not-approved"; orgLogin: string },
  config: Config,
): { title: string; summary: string } {
  if (admission.kind === "repo-not-approved") {
    return {
      title: "This repository is not approved for CreateOS runners",
      summary: `The org is onboarded, but this repo is not on its approved list${contactCopy(config)}`,
    };
  }
  if (admission.kind === "not-approved") {
    return {
      title: `CreateOS runner access is ${admission.status}`,
      summary: `This org's access is currently "${admission.status}"${contactCopy(config)}`,
    };
  }
  return {
    title: "This org is not approved for CreateOS runners",
    summary: `CreateOS Sandbox runners are free for approved projects${contactCopy(config)}`,
  };
}

/**
 * Posts the refusal check run at most once per (tenant, repo, UTC day) — the
 * DO's INSERT-OR-IGNORE is the dedup, so cost is bounded by construction.
 * Best-effort: needs head_sha, checks:write, and a mintable token for the
 * payload's own installation; any failure is logged, never surfaced.
 */
async function notifyRefusal(
  env: Bindings,
  config: Config,
  job: WorkflowJob,
  copy: { title: string; summary: string },
): Promise<void> {
  if (job.installationId === undefined || job.headSha === undefined) return;
  try {
    const fresh = await coordinator(env).shouldNotifyRefusal(
      job.installationId,
      job.repoFullName,
      dayKey(Date.now()),
    );
    if (!fresh) return;
    const gh = new GitHubClient(config, undefined, {
      orgLogin: job.repoFullName.split("/")[0]!,
      installationId: job.installationId,
    });
    await gh.createCheckRun(job.repoFullName, job.headSha, copy.title, copy.summary);
  } catch (err) {
    console.warn(`refusal notice failed ${job.repoFullName}#${job.jobId}: ${String(err)}`);
  }
}
```

- [ ] **Step 3: Tenant-aware provisioning** — `provisionAndRecord` builds its client from the job's tenant:

```typescript
  const github = new GitHubClient(
    config,
    undefined,
    job.tenant
      ? {
          orgLogin: job.tenant.orgLogin,
          installationId: job.tenant.installationId,
          runnerGroupId: job.tenant.runnerGroupId,
        }
      : undefined,
  );
```

In `createRunnerSandbox`, add to the `createSandbox` call:

```typescript
    // D15: community VMs get a per-VM egress quota; allow-all tenants
    // (NodeOps) and single mode stay unmetered.
    ...(job.tenant && !job.tenant.allowAllRepos
      ? { bandwidth_quota_bytes: config.communityBandwidthBytes }
      : {}),
```

- [ ] **Step 4: Integration tests** — `test/integration/tenancy-webhook.test.ts`: drive `handleWebhook` with a multi-mode env (`{ ...env, TENANCY_MODE: "multi" } as unknown as Bindings`), GitHub via `mockFetch` (token mint, check-runs, jitconfig routes), CreateOS via `SandboxDeps.makeClient` double, HMAC-signed bodies (reuse the signing helper from the existing webhook integration suite), `resetShapeCacheForTests()` + `resetCredentialSessionsForTests()` in `beforeEach`, tenants seeded on the singleton stub via `adminUpsertTenant`/`adminAddProjects`. Cases:

1. unknown org + `createos` label → 202 `unknown-tenant`; check-run route hit ONCE; second delivery same repo/day → not hit again;
2. unknown org + `ubuntu-latest` labels only → 202 `no-label`; check-run route NEVER hit;
3. approved tenant + approved repo → provisions; jitconfig URL contains `/orgs/<tenant org>/`; `createSandbox` received `bandwidth_quota_bytes: 107374182400`;
4. `allow_all_repos` tenant → `createSandbox` received NO `bandwidth_quota_bytes`;
5. shaped label above `max_shape` → 202 `shape-over-ceiling`; no job row inserted (assert count via `runInDurableObject`);
6. usage total ≥ grant → 202 `quota-exhausted`.

- [ ] **Step 5: Gate, commit**

Run: `bun run lint && bun run typecheck && bun run test` → green, existing suites untouched.

```bash
git add src/shapes.ts src/handler.ts src/sandbox.ts src/types.ts test/unit/shapes.test.ts test/integration/tenancy-webhook.test.ts
git commit -m "feat: multi-tenant webhook admission and provisioning"
```

---

### Task 2: Per-tenant job TTL in the sweep

**Files:**
- Modify: `src/coordinator.ts` (`sweep`)
- Test: `test/integration/tenancy.test.ts` (extend; reuse its `approved()`/`job()`/`ctx()` helpers)

**Interfaces:** none new — `sweep(nowMs, maxAgeMs)` keeps its signature; `maxAgeMs` becomes the default for rows whose tenant has no TTL.

- [ ] **Step 1:** In `sweep`, the destructive age test's bound becomes per-row (keep `ROW_AGE` — never `created_at`, see that constant's livelock doc):

```sql
WHERE ? - ${ROW_AGE} > COALESCE(
  (SELECT job_ttl_ms FROM tenants WHERE tenants.installation_id = jobs.tenant_id),
  ?
)
```

bound as `(nowMs, maxAgeMs)`. Comment: gate 8 — a tenant's `job_ttl_ms` is its max VM wall-time; NULL `tenant_id` (single mode / pre-migration) keeps the global `REAPER_MAX_AGE_MS`. Only the destructive age pass changes; the `destroying`-row retry pass keeps its existing logic.

- [ ] **Step 2: Test:**

```typescript
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
```

- [ ] **Step 3: Gate, commit**

```bash
git add src/coordinator.ts test/integration/tenancy.test.ts
git commit -m "feat: per-tenant job TTL in reaper sweep"
```

---

### Task 3: Admin approval orchestration — runner group fail-closed

**Files:**
- Modify: `src/admin.ts` (+ thread an optional `fetchImpl` param: `handleAdmin(req, env, fetchImpl?)` → `new GitHubClient(config, fetchImpl, …)`; production callers omit it — test seam only)
- Test: `test/integration/admin.test.ts` (extend)

**Interfaces:**
- Consumes: `createRunnerGroup`, `setRunnerGroupRepos` (Plan 2a Task 5); the shipped approval-stamp logic in POST `/admin/tenants` (kept intact — `approved_at/by` still stamp only on transition into approved).
- Produces: behavior only — no new routes.

- [ ] **Step 1: Approval creates the group (D12, fail-closed)** — in POST `/admin/tenants`, after computing `enteringApproved` and before `adminUpsertTenant`:

```typescript
      let runnerGroupId = b.runner_group_id;
      if (enteringApproved && !b.allow_all_repos) {
        // Gate 3 is GitHub-side: approval REQUIRES the scoped runner group.
        // Fail closed — a tenant whose runners would land in the org Default
        // group (visibility: all repos) must never reach `approved` (D12).
        const projects = existing ? existing.projects : [];
        if (projects.length === 0) {
          return json({ error: "cannot approve: no approved projects; add projects first" }, 400);
        }
        try {
          const gh = new GitHubClient(config, fetchImpl, {
            orgLogin: b.org_login,
            installationId: b.installation_id,
          });
          runnerGroupId = await gh.createRunnerGroup(
            "createos",
            projects.map((p) => p.repoId),
          );
        } catch (err) {
          console.error(`runner group creation failed org=${b.org_login}: ${String(err)}`);
          return json({ error: `runner group creation failed: ${String(err)}` }, 502);
        }
      }
```

and the record uses this `runnerGroupId`. (An `allow_all_repos` tenant — NodeOps — passes its group id explicitly, typically `1`.)

- [ ] **Step 2: Project changes sync the group first (fail-closed)** — in POST `/admin/projects` and DELETE `/admin/projects`, after the tenant pre-check: when the tenant is `approved`, not `allow_all_repos`, and has a `runnerGroupId` — compute the post-change repo-id list (existing projects ∪ added, or ∖ removed) and call `setRunnerGroupRepos` **before** the registry write; on throw return 502 **without writing**. GitHub scope and registry rows must never disagree in the permissive direction — a sync failure that leaves the group narrower than the registry is acceptable; wider never.

- [ ] **Step 3: Tests** — extend `test/integration/admin.test.ts`, GitHub via `mockFetch` through the new `fetchImpl` param:

1. approving with zero projects → 400; tenant keeps its previous status;
2. approving with projects + group API 500 → 502; `adminGetTenant` still shows the prior status (fail-closed);
3. approving with projects + group API ok → 201; record's `runnerGroupId` = the returned id; the POST body carried the project repo ids;
4. adding a project to an approved tenant hits the PUT route with the union of ids BEFORE rows change; PUT 500 → 502 and the project is NOT in `adminGetTenant().projects`;
5. `allow_all_repos: true` approval → no runner-group route hit; `runner_group_id` taken from the body.

- [ ] **Step 4: Gate, commit**

```bash
git add src/admin.ts test/integration/admin.test.ts
git commit -m "feat: fail-closed runner group at tenant approval"
```

---

### Task 4: Multi-tenant reconciler

**Files:**
- Modify: `src/reconcile.ts`
- Test: `test/integration/reconcile.test.ts` (extend)

**Interfaces:**
- Consumes: `adminListTenants`, tenant-scoped `GitHubClient`s, `admitAndDrive` (Task 1), `recoveryCursor`/`setRecoveryCursor`.
- Produces: `runReconciler` handles both modes; multi-mode cursor format is `JSON.stringify({ installationId, repo })` stored via the existing cursor methods.

- [ ] **Step 1: Multi branch in `runReconciler`** — `single` keeps today's body verbatim. Multi:

```typescript
  const tenants = (await co.adminListTenants()).filter((t) => t.status === "approved");
  const scopes = tenants.map((t) => ({
    tenant: t,
    gh: new GitHubClient(config, undefined, {
      orgLogin: t.orgLogin,
      installationId: t.installationId,
      runnerGroupId: t.runnerGroupId,
    }),
  }));

  // A. Liveness: the online union across ALL tenant orgs. All-or-nothing —
  //    reapUnregistered tests for absence over the whole row set, so a single
  //    tenant's failed listRunners would read that tenant's live runners as
  //    gone and destroy them mid-job. One failure skips the whole step.
  let runnersByTenant: Map<number, Runner[]> | null = new Map();
  try {
    for (const s of scopes) {
      runnersByTenant.set(s.tenant.installationId, await s.gh.listRunners());
    }
  } catch (err) {
    console.error(`reconcile: runner sweep skipped (a tenant list failed): ${String(err)}`);
    runnersByTenant = null;
  }
  if (runnersByTenant) {
    const online = [...runnersByTenant.values()]
      .flat()
      .filter((r) => r.status === "online")
      .map((r) => r.name);
    const { toDestroy, nextPending } = await co.reapUnregistered(
      Date.now(),
      online,
      config.reconcileGraceMs,
    );
    await Promise.allSettled([
      ...toDestroy.map((t) => destroyAndConfirm(env, config, t, deps)),
      ...nextPending.map((j) => provisionAndRecord(env, j, deps)),
    ]);
  }

  // B. Recovery: rotate tenants starting AFTER the cursor's tenant, one shared
  //    subrequest budget per tick; within a tenant, discoverQueuedJobs' own
  //    repo cursor rotates as before. Recovered jobs re-enter through
  //    admitAndDrive — the SAME gate ladder as the webhook, by construction.
  const rawCursor = await co.recoveryCursor();
  const parsed = parseTenantCursor(rawCursor);
  const order = rotateFrom(scopes, parsed?.installationId);
  let budget = config.recoverySubrequestBudget;
  let nextCursor: string | null = rawCursor;
  for (const s of order) {
    if (budget <= 0) break;
    const start = s.gh.subrequests;
    const { jobs, coverage } = await discoverQueuedJobs(s.gh, {
      budget,
      cursor: s.tenant.installationId === parsed?.installationId ? parsed.repo : null,
      policy: "org-wide", // project gating happens in admitAndDrive, not here
      allowlist: [],
    });
    budget -= s.gh.subrequests - start;
    nextCursor = JSON.stringify({
      installationId: s.tenant.installationId,
      repo: coverage.nextCursor,
    });
    for (const q of jobs) {
      await admitAndDrive(
        env,
        config,
        {
          action: "queued",
          jobId: q.jobId,
          runId: q.runId,
          repoFullName: q.repoFullName,
          labels: q.labels,
          installationId: s.tenant.installationId,
        },
        { waitUntil: (p) => p.catch((e) => console.error(String(e))) },
        deps,
        "reconcile: ",
      );
    }
    if (coverage.budgetBound) {
      console.warn(
        `reconcile: budget bound at tenant ${s.tenant.orgLogin} — ` +
          `covered ${coverage.covered}, deferred ${coverage.deferred}`,
      );
      break;
    }
  }
  if (nextCursor !== rawCursor) await co.setRecoveryCursor(nextCursor);

  // C. Orphaned registrations: per tenant, REUSING step A's runner lists (no
  //    re-fetch — cost). Same ownership proof as single mode: name parses as
  //    ours + offline + not busy + no live Coordinator row. The per-tick
  //    delete cap is shared across tenants.
  //    (Adapt the existing sweepOrphanedRunners body to take (gh, runners);
  //    skip when runnersByTenant is null — same fail-safe as step A.)

  // D. Orphaned sandboxes: UNCHANGED — account-wide by VM name, one DO,
  //    liveJobIds() spans all tenants. Deliberately tenant-blind and
  //    GitHub-independent; never gate it on the tenant loop above.
```

With two pure helpers in `reconcile.ts`:

```typescript
/** Multi-mode cursor: {installationId, repo}. Malformed → null, loudly. */
function parseTenantCursor(raw: string | null): { installationId: number; repo: string | null } | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { installationId?: unknown; repo?: unknown };
    if (typeof p.installationId !== "number") throw new Error("bad installationId");
    return { installationId: p.installationId, repo: typeof p.repo === "string" ? p.repo : null };
  } catch {
    console.warn(`reconcile: malformed tenant cursor ${JSON.stringify(raw)}; restarting rotation`);
    return null;
  }
}

/** Stable rotation: the cursor's tenant first, then the rest in id order. */
function rotateFrom<T extends { tenant: { installationId: number } }>(
  scopes: T[],
  startId: number | undefined,
): T[] {
  if (startId === undefined) return scopes;
  const i = scopes.findIndex((s) => s.tenant.installationId === startId);
  return i < 0 ? scopes : [...scopes.slice(i), ...scopes.slice(0, i)];
}
```

- [ ] **Step 2: Tests** — extend `test/integration/reconcile.test.ts`, multi-mode env override, two seeded tenants:

1. recovery admits a still-queued createos job from tenant A's approved repo (provisions) and refuses one from an unapproved repo (no row inserted);
2. step A union: tenant A's `listRunners` ok, tenant B's → 500 → NO reaping happens (tenant A's stale row survives the tick);
3. cursor round-trips: tick 1 budget-bound at tenant A persists `{installationId: A, repo}`; tick 2 starts at tenant A, then covers B;
4. single-mode reconciler suite stays green untouched.

- [ ] **Step 3: Gate, commit**

```bash
git add src/reconcile.ts test/integration/reconcile.test.ts
git commit -m "feat: multi-tenant reconciler with shared budget"
```

---

### Task 5: Docs + deploy checkpoint (flag off)

**Files:**
- Modify: `CONTEXT.md`, `AGENTS.md`, `README.md`, `wrangler.toml`

- [ ] **Step 1: wrangler.toml** — add to `[vars]`, both explicitly at today's behavior:

```toml
# Multi-tenancy master switch. "single" = pre-tenant behavior. Flipping to
# "multi" is the Plan 3 cutover — do not flip without the cutover runbook.
TENANCY_MODE = "single"
# Per-VM egress quota for community tenants (bytes). 100 GB.
COMMUNITY_VM_BANDWIDTH_BYTES = "107374182400"
APPLY_FORM_URL = ""
```

- [ ] **Step 2: Docs**

- `CONTEXT.md`: add **Tenant admission** (the multi-mode gate ladder, one term-level paragraph), **Refusal notice** (one neutral check run per repo per UTC day), **Job TTL** (per-Tenant reaper bound); extend **Ledger** — billed at destroy confirmation using the weight persisted at admission.
- `AGENTS.md`: file-table row for `reconcile.ts`; gotchas: "**`TENANCY_MODE=multi` requires the Plan 3 cutover runbook** — flipping it without a seeded tenant registry refuses every job (fails closed, loudly)"; the DO-stub-throw harness trap.
- `README.md`: the three new env vars; approval flow now creates the runner group and fails closed.

- [ ] **Step 3: Full gate + deploy**

```bash
bun run lint && bun run typecheck && bun run test
bunx wrangler@latest deployments list   # note active version id — rollback target
git add -A && git commit -m "docs: document tenancy runtime surface"
git push origin main                    # deploys with TENANCY_MODE=single — no behavior change
```

Verify: `/health` ok; **Actions → ghar-test → Run workflow** green (DO schema changed in 2a — prove provisioning end-to-end); `wrangler tail` clean on a few webhook deliveries.

- [ ] **Step 4: Rollback readiness** — `bunx wrangler@latest rollback <version-id>`; all schema changes additive.

---

## Self-review checklist (run before handing off to Plan 3)

- `admitAndDrive` is the ONLY multi-mode admission path — `rg 'admitTenantJob'` in src hits exactly coordinator (definition) + handler (one call inside `admitAndDrive`).
- Check-run copy carries no secrets/internal ids; `conclusion: "neutral"` everywhere; notices fire only for label-carrying jobs.
- Hot-path call counts match the Global Constraints table (count DO RPCs in the webhook test with a spy if in doubt).
- Single-mode: entire pre-2a suite green with no test-body edits in this plan.
