# Multi-tenant community runners — design

**Date:** 2026-07-22
**Status:** approved for planning
**Companion doc:** `docs/community/onboarding-form.md` (intake form + lead capture)

## Goal

Turn the single-org ghar controller into a multi-tenant service that offers
CreateOS Sandbox microVMs as free GitHub Actions runners to approved external
orgs — burning idle plan capacity, generating community leads, and dogfooding
the Sandbox product against real third-party CI workloads. NodeOps itself
becomes a tenant of the new system; the current single-tenant deployment is
retired after cutover.

Onboarding is deliberately manual: orgs apply via a Google Form, an operator
approves them and whitelists their repos from the backend. Installing the
public GitHub App alone grants nothing.

## Decisions (settled during brainstorming)

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Tenant unit | GitHub **org**, keyed by App `installation_id`. Org login is display only. |
| D2 | Admission unit | **Project** = an approved repo within a Tenant. |
| D3 | Quota placement | On the **Tenant**. Per-Project usage recorded for attribution, never enforced. |
| D4 | GitHub App | **One public App.** Existing private App retired via quiet swap (§9). |
| D5 | Deployments | **One Worker**, evolved in place. No parallel community deployment. |
| D6 | Coordinator | **Single DO retained** (`idFromName("singleton")`). Revisit triggers in §11. |
| D7 | Cloudflare plan | **Workers Paid ($5/mo).** Kills the 100k req/day availability cliff (error 1027), raises subrequests 50 → 10,000, CPU 10 ms → 30 s. Go rewrite rejected: re-litigates every encoded gotcha to save ~$5.40/mo. |
| D8 | Quota unit | **Weighted minutes** = wall minutes of VM lifetime × (shape vCPU ÷ 2). |
| D9 | Metering window | VM lifetime: `booted_at` → destroy confirmation. Calendar month, UTC. |
| D10 | Exhaustion | Hard stop: no provision, check run with balance + reset date, Slack alert. No degraded tier. |
| D11 | Capacity protection | Per-Tenant concurrency caps only; operator keeps Σ(caps) ≤ CreateOS plan capacity. No global arbiter DO in v1. |
| D12 | Runner groups | One per Tenant org, created at approval, `visibility: selected` scoped to approved Projects. Fail-closed: group creation failure blocks approval. |
| D13 | Community shape cap | `4vcpu-8gb` default `max_shape`, per-Tenant overridable. |
| D14 | Job TTL | 30 min default, per-Tenant configurable (raise for tenants with longer builds). |
| D15 | Bandwidth | 100 GB per VM via `bandwidth_quota_bytes`. Monthly egress total recorded per Tenant, alert-only. |
| D16 | Onboarding | Google Form → manual review → authenticated admin endpoint. Never an env var (a push to `main` is a deploy). |
| D17 | Unapproved traffic | Ignore + post a check run ("not approved, apply here <link>"). Requires `checks:write` on the App **at creation** — adding later forces every install to re-accept. |
| D18 | NodeOps | Tenant #1 with `allow_all_repos: true`. The only Tenant with that flag. |

## 1. Domain model

- **Tenant** — an approved GitHub org. Keyed by `installation_id`. Owns: grant,
  concurrency cap, `max_shape`, job TTL, runner group id, contact/lead record,
  status (`pending` / `approved` / `suspended` / `revoked`).
- **Project** — an approved repo inside a Tenant. Owns admission and nothing
  else. Identified by repo full name (and repo id, for runner-group scoping).
- **Grant** — the Tenant's weighted minutes per calendar month (UTC).
- **Weighted minute** — 1 wall minute × (vCPU ÷ 2). `s-2vcpu-2gb` = 1×,
  `s-4vcpu-4gb` = 2×, `s-4vcpu-8gb` = 2×.
- **Ledger** — usage rows keyed `(tenant, month)` for enforcement and
  `(tenant, project, month)` for attribution.

## 2. The ten gates

Every abuse edge and which mechanism closes it. No unlisted path provisions a VM.

| # | Gate | Level | Enforced where | Bounds |
| --- | --- | --- | --- | --- |
| 1 | Org not an approved Tenant | org | admission | Random public installs |
| 2 | Repo not an approved Project | repo | admission | Scope creep inside an approved org |
| 3 | Runner group scoped to approved repos | org | **GitHub-side** | Defence in depth: even past gates 1–2, GitHub won't schedule an unapproved repo onto the runner |
| 4 | Exactly one createos label | job | admission (exists today) | Ambiguous requests |
| 5 | Requested shape ≤ Tenant `max_shape` | org | admission | Size farming |
| 6 | Tenant concurrency cap | org | Coordinator | **Our capacity** — bounds burn rate at cap × TTL regardless of workload |
| 7 | Monthly weighted-minute grant | org | admission | Total consumption |
| 8 | Job TTL (reaper kills VM at N min) | org | reaper | A single runaway job |
| 9 | 100 GB bandwidth per VM | VM | CreateOS | Egress abuse |
| 10 | Σ(Tenant caps) ≤ plan capacity | global | operator, at approval | Oversubscription |

Gate 6 caps *rate*; gate 7 caps *total*. That pair is why per-Project
enforcement is deliberately absent: attribution answers "which repo burned the
month," and the Tenant's own budget bounds the damage.

## 3. Naming constraint (why ownership lives in the DO, not in names)

Two hard byte budgets prevent putting a tenant tag in any name:

- The JIT blob is ~4085 of a 4096-byte cap on a createos `envs` value; the
  runner name `cos-<jobId>-<xx>` is the only controllable part and its length
  is the entire safety margin.
- Sandbox names cap at 22 chars; `gha-ci-<11-digit jobId>` is 18, and the
  orphan sweep refuses ownership on any prefix that can truncate.

Therefore tenant ownership is derived from the DO row (`jobs.tenant_id`),
never from a name. GitHub job ids are globally unique and one DO holds every
row, so the existing name-based orphan sweep and its ownership proofs keep
working **unchanged** — a direct benefit of D6.

## 4. Data model (Coordinator DO, additive)

```sql
-- new tables
CREATE TABLE IF NOT EXISTS tenants (
  installation_id   INTEGER PRIMARY KEY,
  org_login         TEXT NOT NULL,        -- display + runner-group API path
  status            TEXT NOT NULL,        -- pending|approved|suspended|revoked
  allow_all_repos   INTEGER NOT NULL DEFAULT 0,
  minute_grant      INTEGER NOT NULL,     -- weighted minutes / month
  concurrency_cap   INTEGER NOT NULL,
  max_shape         TEXT NOT NULL,
  job_ttl_ms        INTEGER NOT NULL,
  runner_group_id   INTEGER,              -- NULL until approval creates it
  contact           TEXT,                 -- JSON blob from the form
  notes             TEXT,
  approved_at       INTEGER,
  approved_by       TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  installation_id   INTEGER NOT NULL,
  repo_full_name    TEXT NOT NULL,
  repo_id           INTEGER NOT NULL,     -- runner-group scoping API takes ids
  added_at          INTEGER NOT NULL,
  PRIMARY KEY (installation_id, repo_full_name)
);
CREATE TABLE IF NOT EXISTS usage (
  installation_id   INTEGER NOT NULL,
  month             TEXT NOT NULL,        -- "2026-07" (UTC)
  repo_full_name    TEXT NOT NULL,        -- "" = tenant total row
  weighted_minutes  REAL NOT NULL DEFAULT 0,
  egress_bytes      INTEGER NOT NULL DEFAULT 0,  -- alert-only (D15)
  PRIMARY KEY (installation_id, month, repo_full_name)
);

-- existing table, additive migration (same pattern as prior columns)
ALTER TABLE jobs ADD COLUMN tenant_id INTEGER;   -- NULL = pre-migration row
```

The month is part of the primary key, so **there is no reset job** — a new
month is a new row. Nothing to schedule, nothing to fail silently on the 1st.
`NULL` `tenant_id` rows are backfilled to the NodeOps Tenant; until backfilled
they behave as before (COALESCE at read sites), so a Worker rollback mid-
migration degrades to shipped behaviour. All migrations additive per the
existing rollback rule (Worker rollback does not revert DO SQLite).

## 5. File responsibilities (changes only)

| File | Change |
| --- | --- |
| `src/config.ts` | Drops `githubOrg`, `githubInstallationId`, `repoAllowlist`, `provisionPolicy` (become per-Tenant). Keeps App credentials, community defaults (grant, cap, shape, TTL), admin bearer secret. |
| `src/registry.ts` | **New.** Tenant/Project reads + writes over the DO tables. The admission path's lookup surface. |
| `src/quota.ts` | **New.** Weighted-minute math, UTC month key, balance arithmetic. Pure functions, no I/O. |
| `src/policy.ts` | `shouldProvision(tenant, project)` — registry lookup replaces the env-string org comparison. |
| `src/admission.ts` | Ordered decision gains: Tenant status → Project (or `allow_all_repos`) → shape ≤ `max_shape` → quota balance. Existing label identification and catalog validation unchanged. Refusals carry a reason the caller can turn into a check run. |
| `src/coordinator.ts` | New tables; `jobs.tenant_id`; per-Tenant cap replaces global `MAX_CONCURRENT`; ledger writes on teardown; per-Tenant TTL feeds `sweep`/`reapUnregistered`. |
| `src/github/auth.ts` | Installation-token cache keyed on `installation_id`. |
| `src/github/client.ts` | Adds `createRunnerGroup`, `setRunnerGroupRepos`, `createCheckRun`. `generateJitConfig` takes the Tenant's org + group id. |
| `src/handler.ts` | Resolves Tenant from webhook `installation.id`; threads it through; posts check runs on refusals per D17. |
| `src/reconcile.ts` | **Extracted** from `handler.ts` (reconciler + reaper + sweeps) — the file is 623 lines and this work grows it; targeted split of code being touched. |
| `src/admin.ts` | **New.** Bearer-authenticated `POST /admin/tenants`, `POST /admin/projects` (+ status changes). Approval orchestrates runner-group creation and fails closed (D12). |
| `src/webhook.ts` | `parseWorkflowJob` also extracts `installation.id`. HMAC path unchanged (one App, one secret). |

## 6. Request flow (changed segments)

```
queued → verify HMAC → parse (+installation.id)
  → Tenant approved? ── no → 202 + check run "org not approved, apply: <link>"
  → Project approved (or allow_all_repos)? ── no → 202 + check run "repo not approved"
  → exactly one createos label? (existing)
  → shape ≤ max_shape? ── no → 202 + check run
  → quota balance > 0? ── no → 202 + check run "exhausted, resets <date>" + Slack
  → catalog validate (existing) → onQueued(tenant_id, …) → per-Tenant cap
  → provision (JIT into tenant.runner_group_id; bandwidth_quota_bytes set)

completed → identify label → onCompleted
  → ledger += weighted minutes (booted_at → now, shape weight) to (tenant, month)
    and (tenant, project, month)
  → destroy VM → promote next pending (same Tenant's queue)

cron → per-Tenant TTL reaping; recovery scan cursor becomes (tenant, repo)
```

Teardown continues to key on runner identity alone — never on Tenant status or
the shape catalog. A suspended Tenant's in-flight VMs still tear down cleanly.

## 7. Ledger semantics

- Billed on VM lifetime (D9): `booted_at` → destroy confirmation.
- A provision that never booted bills nothing — no VM ran.
- A reaper-reclaimed VM bills to reap time: it held capacity the whole while.
- Quota check is at admission (gate 7): a job admitted with 1 minute left runs
  to completion — overshoot is bounded by cap × TTL and is accepted; the next
  admission refuses.
- Egress: on teardown, read the VM's `getBandwidth().used_bytes` best-effort
  into `usage.egress_bytes`. Alert-only; never blocks teardown.

## 8. Runner groups (gate 3)

At approval: `POST /orgs/{org}/actions/runner-groups` (`visibility:
"selected"`, the Project repo ids). Store the id on the Tenant. Project
add/remove calls `PUT .../repositories`. `generateJitConfig` registers into
that group.

**Fail closed:** if group creation fails, the Tenant stays `pending`. A Tenant
whose runners would land in the org Default group (policy: all repos) silently
converts gate 3 into nothing — never approve into that state.

## 9. Cutover — one App, quiet swap

Dual-App verification was considered and rejected: `onQueued` is idempotent on
`job_id` (PRIMARY KEY), so overlap deliveries are harmless, and reconciler
step B already re-drives any job whose `queued` webhook was rejected during
the flip. The only exposure is ~10 s around the deploy, worth at most one
5-minute recovery delay on a handful of jobs — not worth a permanent
multi-secret verify path.

Order is load-bearing:

1. Create the public App (same webhook URL, `checks:write` from day one, D17).
2. **Install it on NodeOps-app *before* deploying new code.** Old code 401s
   the new App's deliveries cleanly; NodeOps CI continues via the old App.
3. Deploy the multi-tenant Worker holding the new App's credentials, NodeOps
   pre-seeded (D18). Old App now 401s.
4. Uninstall the old App. GitHub's redelivery UI is the manual backstop.

Reverse steps 2–3 and there is a real gap where the old App is live and
nothing accepts its deliveries.

## 10. Migration sequence (each step deployable + rollback-safe)

1. Additive schema (new tables, nullable `jobs.tenant_id`) + admin API. No
   behaviour change. Deploy, verify.
2. Verify seed tooling (admin endpoints) against prod. **The real NodeOps
   Tenant is NOT seeded yet:** a Tenant is keyed by `installation_id`, and
   seeding before step 4 would key it on the old App's id — which the step 5
   credential swap invalidates, stranding the row and its ledger.
3. Tenant-aware admission behind a flag defaulting to current behaviour.
4. Create public App; install on NodeOps-app. **Now** seed the NodeOps Tenant
   (`allow_all_repos`) keyed on the new App's installation id, and backfill
   `jobs.tenant_id` to it.
5. Flip flag + swap App credentials in one deploy. Watch smoke run; rollback
   = revert flag + credentials (schema is additive, old code ignores it).
6. Uninstall old App.
7. Onboard first community Tenant; watch the ledger and gates fire for real.

Also: upgrade the Cloudflare account to Workers Paid before step 5 (D7), and
raise `RECOVERY_SUBREQUEST_BUDGET` once on Paid — the budget mechanism and its
warn-on-bind stay (no-silent-bounds rule), rotation becomes overflow
behaviour, cursor becomes `(tenant, repo)`.

## 11. Accepted tradeoffs + revisit triggers

- **Single DO serializes all tenants** (one request at a time). Fine at
  expected scale. Revisit when: queued→provisioning p95 climbs under
  concurrent tenant bursts, or DO duration billing becomes visible. The
  `tenant_id` column makes a later per-tenant split mechanical.
- **No global arbiter** (D11): oversubscription is an operator judgment at
  approval. Revisit when Σ(caps) must exceed plan capacity to serve demand.
- **No per-Project enforcement / daily sub-limits**: add only if a real
  incident shows gates 6+7 insufficient.
- **Egress alert-only** (D15): promote to a hard monthly cap if abuse appears.

## 12. Testing

- **Unit (plain vitest):** weighted-minute math incl. month boundaries (UTC),
  quota arithmetic, registry rules (`allow_all_repos`, status transitions),
  admission ordering (tenant → project → label → shape → quota), refusal
  reasons.
- **Integration (real DO):** per-Tenant cap isolation (Tenant A at cap does
  not block Tenant B), quota exhaustion stops provisioning and next-month row
  restores it, `tenant_id` backfill + NULL-row compatibility, unapproved
  org/repo ignored with check-run intent surfaced, ledger written on
  teardown + reap, suspended Tenant teardown still works.
- **Mock at the fetch boundary; never hit the network** (existing rule).
- **E2E:** existing `ghar-test` workflow after each migration step; after
  step 7, a real job from a second org proving gates 1–3 and the ledger.

## 13. Out of scope (v1)

Self-serve dashboard, usage API, per-Project enforcement, daily sub-limits,
global arbiter DO, per-Tenant CreateOS keys, degraded tier at exhaustion,
automated approval, paid plans.

## 14. Docs to update during implementation

- `CONTEXT.md`: **Tenant**, **Project**, **Grant**, **Weighted minute**,
  **Ledger**; revise **Org** and **Provisioning policy** (policy becomes the
  registry).
- `AGENTS.md`: file table (registry/quota/reconcile/admin), gotchas (Paid-plan
  status of the subrequest constraint, install-before-deploy rule), request
  flow.
- `README.md`: operator surface — admin endpoints, approval runbook, cutover
  runbook.
- ADRs: single-DO multi-tenancy (D6, D3), one-App cutover (D4/§9) — both are
  hard to reverse, surprising later, and were real trade-offs.
