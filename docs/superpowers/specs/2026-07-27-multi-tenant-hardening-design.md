# Multi-tenant hardening: fork gating, webhook edge controls, job-id invariant

Date: 2026-07-27
Status: **deferred, not scheduled.** Design approved in shape (fork gating revised
2026-07-27 to drop the Repository Administration:read grant — permission delta is
zero). Implementation intentionally NOT started: NodeOps-app onboards its first
community tenant first, runs it for a while, and this ships only if that
onboarding surfaces the need. Revisit this file before writing an implementation
plan — do not assume it is still current without re-checking against whatever the
first tenant's onboarding actually taught us.
Supersedes nothing. Extends `2026-07-22-multi-tenant-community-runners-design.md`.

## Why now

We are onboarding third-party GitHub orgs and repos as tenants. Three gaps in the
current multi-tenant path have to close before that:

1. `admitAndDrive` hard-codes `isForkJob: () => Promise.resolve(false)`
   (`src/handler.ts:387`), so multi mode has **no fork gating at all**. Fork PRs on
   an approved repo queue jobs and spend VMs.
2. `/webhook` has **no rate limit and no origin filter** beyond the HMAC check.
3. `jobs.job_id` is a bare `INTEGER PRIMARY KEY` with no tenant component. The
   invariant that holds it up (job ids are unique across github.com) is real but
   undocumented and unenforced.

## Threat model

CreateOS Sandbox microVMs are isolated at the hypervisor boundary: a guest escape
does not reach the CreateOS control plane or other tenants. So running untrusted
third-party code is **not** a lateral-compromise risk here. What we are actually
defending is:

- **Spend** — VM-hours charged against a tenant's weighted-minute grant, and
  capacity denied to other tenants.
- **Egress** — capped per VM at 10 GiB (`COMMUNITY_VM_BANDWIDTH_BYTES`).
- **Reputation** — mining, scanning, or spam egressing from NodeOps IP space.
- **Availability** — a request flood against the Worker and the singleton
  Coordinator DO.

Every control below is priced against those four, not against VM escape. This
paragraph stays in this internal spec and out of the public `AGENTS.md`.

---

## Part A — Fork gating, at zero permission cost

### The constraint that shapes this

Verified against the OpenAPI description: `webhook-workflow-job-queued` carries no
fork signal whatsoever (`check_run_url, completed_at, conclusion, created_at,
head_sha, html_url, id, labels, name, node_id, run_attempt, run_id, run_url,
runner_group_id, runner_group_name, runner_id, runner_name, started_at, status,
head_branch, workflow_name, steps, url`). `repository.fork` describes the _base_
repo, not the PR head. Fork detection therefore always costs a
`GET /repos/{owner}/{repo}/actions/runs/{run_id}` subrequest — which is exactly
what `GitHubClient.isForkJob` already does (`src/github/client.ts:97`), at
Repository **Actions: read**.

### Why we do NOT read the fork-approval policy

The obvious design reads
`GET /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval` and
verifies the tenant has set `all_external_contributors` — at which point GitHub
parks unapproved fork runs in `action_required` and never emits a `queued`
webhook, making enforcement free at our runtime.

**Rejected.** That endpoint requires Repository **Administration: read**, which is
not a narrow grant. It carries 42 endpoints, including:

```
GET /repos/{o}/{r}/traffic/views | /clones | /popular/paths | /popular/referrers
GET /repos/{o}/{r}/branches/{branch}/protection*            (9 endpoints)
GET /repos/{o}/{r}/keys                                     (deploy keys)
GET /repos/{o}/{r}/vulnerability-alerts
GET /repos/{o}/{r}/code-scanning/default-setup
GET /repos/{o}/{r}/code-security-configuration
GET /repos/{o}/{r}/invitations | /teams | /interaction-limits
GET /repos/{o}/{r}/rulesets/rule-suites
```

Asking a third-party org for private repo traffic analytics, full branch
protection configuration, deploy-key inventory, and security posture — in order to
read one boolean — is not something any careful org should grant, and this App is
public. The org-level variant is worse (Organization Administration: read).

**Permission delta for Part A is therefore zero.** Confirm Repository
**Actions: read** is present; add nothing.

### Design

Multi mode, on every `queued` job:

1. Tenant has `allow_forks = 1` → admit, no fork check, no extra call.
2. Tenant has `allow_forks = 0` (the default) → call `isForkJob`. Fork-origin runs
   are refused with an actionable check-run; non-fork runs proceed.

`isForkJob` already fails closed — it returns `true` on any error, on a missing
`head_repository`, and on a missing `owner.login` — so a GitHub failure refuses
rather than admits.

`allow_forks = 1` is set by an operator through `/admin/tenants`, **only after
manually confirming** the org has _Require approval for all external
contributors_ set. Onboarding is already a manual gate (approval status, scoped
runner group, minute grant, shape ceiling); this is one more item on that
checklist, not a new workflow.

**What this trades away, stated plainly:** the tenant's setting is verified once,
by a human, at onboarding — not continuously by API. A tenant can relax it
afterward and we will not notice. The exposure is bounded by the tenant's
concurrency cap, weighted-minute grant, and 10 GiB per-VM egress cap, and the
tenant is revocable. That is a better trade than holding repo traffic analytics
and branch-protection config on every tenant repo, forever, to close a gap whose
worst case is bounded spend.

### Hot-path cost

One GitHub subrequest per `queued` job for every tenant with `allow_forks = 0`
(installation token is already cached). Mitigated by a module-level cache keyed on
`run_id` in `src/handler.ts`: a matrix fan-out shares one `run_id`, so a 20-job
matrix costs one call. Bounded size with an explicit eviction warn — no silent
caps.

Measured context: the provision phase already dominates end-to-end spawn latency
by 80–90%, so a ~200 ms admission call is not the thing a user notices.

DO call count on the hot path is **unchanged** — still exactly 2 in multi mode,
per the Plan 2 budget. `allow_forks` rides on the existing `admitTenantJob`
return value.

### Schema (additive)

```sql
ALTER TABLE tenants ADD COLUMN allow_forks INTEGER NOT NULL DEFAULT 0;
```

Nullable-equivalent via its default and ignored by old code — forward-compatible
per the rollback rule in `AGENTS.md` (a DO migration does not auto-revert with a
Worker rollback). Defaulting to `0` means an existing tenant is fork-gated the
moment this ships, which is the fail-closed direction.

### Where each piece lives

| Change                                                                               | File                              |
| ------------------------------------------------------------------------------------ | --------------------------------- |
| `allowForks` on `TenantRecord`; persisted + returned                                 | `src/types.ts`, `src/registry.ts` |
| `allow_forks` column, migration, carried on `admitTenantJob`                         | `src/coordinator.ts`              |
| `allow_forks` accepted on tenant upsert                                              | `src/admin.ts`                    |
| Fork gate + `run_id` cache, replacing the hard-coded `false` at `src/handler.ts:387` | `src/handler.ts`                  |
| `forkGateMode`                                                                       | `src/config.ts`                   |

### Refusal copy

Reuses the existing `notifyRefusal` check-run path with its per-repo-per-UTC-day
dedup:

> **Fork pull requests cannot use CreateOS runners on this repository**
> Runs originating from a fork are not provisioned. If this repository requires
> maintainer approval for all external contributors and you want fork PRs to use
> CreateOS runners, contact us to enable it for your org.

### Env

| Var              | Default   | Meaning                                                                                             |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `FORK_GATE_MODE` | `observe` | `off` \| `observe` \| `enforce`. `observe` makes the call, logs what it _would_ refuse, and admits. |

Single mode (`TENANCY_MODE=single`) is untouched: `shouldProvision`'s
`fork-gated` policy stays exactly as-is and none of the above runs.

### Possible upgrade, no permission change

Two candidate signals could turn `allow_forks = 1` from _trust_ into _verify_,
both at Repository **Actions: read**:

- `GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals` — documented as
  "anyone with read access", but its schema is `environment-approvals`, which may
  only cover deployment-environment gates rather than fork-PR approval.
- `actor` vs `triggering_actor` on the run object — plausibly the approver on an
  approved fork run.

**Both are unverified behavioral claims.** Settle them empirically with a real
fork PR against `atlasnetwork-xyz/test-ghar` before relying on either. Follow-up,
not a blocker.

---

## Part B — Webhook edge controls

### B.0 Shape gate (no crypto, no network)

Before HMAC, reject with 400:

- missing `X-GitHub-Event`, `X-GitHub-Delivery`, or `X-Hub-Signature-256`
- `Content-Type` not `application/json`
- `Content-Length` absent or `> WEBHOOK_MAX_BODY_BYTES`

Sheds malformed traffic before any work. Zero cost.

### B.1 GitHub source-IP allowlist

**No field in the request body can prove GitHub origin** — the body is exactly
what an attacker controls, and the HMAC over that body is already the stronger
form of the same proof. What an IP check adds is a _network_-origin filter that
rejects before we spend crypto.

`GET https://api.github.com/meta` → `hooks`, currently 6 CIDRs:

```
192.30.252.0/22   185.199.108.0/22   140.82.112.0/20
143.55.64.0/20    2a0a:a440::/29     2606:50c0::/32
```

Cached in the Coordinator `meta` table, refreshed on cron, matched against
`CF-Connecting-IP`.

**Fails open** when the cache is empty, unparseable, or older than its ceiling. An
allowlist that has not loaded must never brick production — this control is
defence in depth behind the HMAC, not the authorization boundary.

`WEBHOOK_IP_MODE = off | observe | enforce`, ships `observe`.

Zone-level WAF rate limiting / IP access rules were considered and are **not
available**: `wrangler.toml` declares no `routes` or custom domain, so the Worker
serves on `*.workers.dev`, which is not in a zone we control. Revisit only if a
custom domain is added.

### B.2 HMAC — unchanged

`verifySignature` stays the authorization boundary.

### B.3 Per-installation rate limit

Workers native rate-limiting binding, declared in `wrangler.toml` and shipped by
the same push-to-`main` deploy as the code:

```toml
[[ratelimits]]
name = "WEBHOOK_LIMITER"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 300
  period = 60
```

Applied **after** signature verification (so the key is trustworthy), keyed
`q:<installationId>`, and **only when `action === "queued"`**.

Non-`queued` actions are never limited, and this is load-bearing: **GitHub does
not automatically retry failed webhook deliveries.** A dropped `completed` means
the VM that ran the job is never torn down by the fast path and leaks until the
reaper catches it. A dropped `queued`, by contrast, is self-healing — the
5-minute reconciler re-drives still-queued jobs from GitHub's own view.

Binding caveats, recorded because they will surprise someone later:

- The counter is **per Cloudflare colo**, not global. Effective global ceiling is
  higher than the configured number and varies with traffic distribution.
- `period` accepts only `10` or `60`.
- `limit` and `period` are **config-time**, not runtime env. Changing the numbers
  is a `wrangler.toml` edit and a deploy.

`WEBHOOK_RATE_LIMIT_MODE = off | observe | enforce` is the runtime kill switch.
Ships `observe`: the limiter is consulted and a bind is logged, but the request
proceeds. Flip to `enforce` after reading a week of logs.

`300/60/colo` is sized so a large legitimate matrix fan-out does not trip it.
It is not the VM-spend control — the tenant concurrency cap and weighted-minute
grant are. It exists to protect Worker CPU and the singleton DO from a flood.

If the binding is absent from `env`, the limiter is skipped (so `wrangler dev`
and the test suite need no extra setup).

### Env

| Var                       | Default   | Meaning                          |
| ------------------------- | --------- | -------------------------------- |
| `WEBHOOK_MAX_BODY_BYTES`  | `262144`  | B.0 body-size ceiling.           |
| `WEBHOOK_IP_MODE`         | `observe` | `off` \| `observe` \| `enforce`. |
| `WEBHOOK_RATE_LIMIT_MODE` | `observe` | `off` \| `observe` \| `enforce`. |

---

## Part C — job_id invariant guard

No schema change. `jobs.job_id` stays the primary key.

### Why not UUIDv7

Rejected on a hard constraint, not preference. The runner name carries the job id
(`runnerNameFor` / `jobIdFromRunnerName`, `src/sandbox.ts`), and the JIT config
blob is measured at ~4085 of GitHub's 4096-byte `encoded_jit_config` ceiling —
**runner-name length is the entire safety margin** (`AGENTS.md`). A UUIDv7 adds 22
characters base64url-encoded, 36 as canonical text. Either overflows, and an
overflow fails _every_ provision rather than degrading. A UUID also does not
derive from the job id, so mapping one to the other needs a
`(installation_id, job_id)` lookup — which is a composite key with extra steps.

A real composite primary key `(tenant_id, job_id)` is the correct fix if the
invariant ever breaks. SQLite cannot `ALTER` a primary key, so it means a table
rebuild inside the DO, which does not auto-revert on Worker rollback. Not worth
it for a risk that is currently zero.

### The guard

`Coordinator#onQueued` currently returns `{ action: "ignore" }` for any existing
`job_id` row (`src/coordinator.ts:369`). A cross-tenant collision would therefore
be silently absorbed into another tenant's row. Replace with:

- existing row's `tenant_id` **equals** the incoming tenant → `ignore` (redelivery,
  unchanged behaviour)
- existing row's `tenant_id` **is NULL** and incoming is non-null → `ignore`, log at
  info. A pre-tenancy row legitimately predates the cutover; this is not an alarm.
- both non-null and **different** → return a new `{ action: "conflict" }`,
  `console.error`, and `notify()`

**Return, never throw.** An exception crossing the real DO stub poisons it for the
rest of a test run and corrupts `@cloudflare/vitest-pool-workers@0.8.71`'s
isolated-storage bookkeeping (`AGENTS.md`).

`handleWebhook` surfaces `conflict` as the 202 body word, same as every other
admission outcome.

### Documentation

`AGENTS.md` gains a gotcha and `CONTEXT.md` the vocabulary: job ids are unique
within a single GitHub host; onboarding a GitHub Enterprise Server tenant onto
the same Worker requires the composite-key migration **first**, because GHES runs
its own id space.

---

## Testing

| Layer              | Tests                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure (`test/unit`) | B.0 shape gate; CIDR matching incl. IPv6 and the fail-open cases; config parsing of all four new vars incl. invalid-mode rejection                                                                                                           |
| GitHub client      | `isForkJob` fail-closed paths already covered — extend for the `run_id` cache: hit, miss, eviction warn                                                                                                                                      |
| DO integration     | job-id conflict guard across all three branches; `allow_forks` round-trip through `admitTenantJob`; migration onto a DO created before the column existed defaults to `0`                                                                    |
| Flow integration   | `allow_forks = 1` makes **no** `isForkJob` call; `allow_forks = 0` makes exactly one and refuses a fork; matrix fan-out on one `run_id` makes exactly one; `observe` mode admits while logging; rate limiter never consulted for `completed` |

Mutation check on the highest-value assertion: reintroduce
`isForkJob: () => Promise.resolve(false)` at `src/handler.ts:387` and confirm the
flow test fails.

Full gate per `AGENTS.md`: `bun run lint && bun run typecheck && bun run test`,
then the `ghar-test` end-to-end smoke on **both** `atlasnetwork-xyz/test-ghar`
and the `NodeOps-app` org.

## Rollout order

No step depends on a GitHub App permission change — that idea was rejected above.

1. **C** — no dependencies, no schema change.
2. **B.0 + B.3** — `wrangler.toml` binding plus handler wiring, both modes `observe`.
3. **B.1** — IP allowlist, `observe`.
4. **A** — `FORK_GATE_MODE=observe` first, to measure how many real fork jobs the
   gate would refuse before it starts refusing them.

Each step is a separate atomic commit and a separate deploy. Capture the live
version id before each push (`bunx wrangler@latest deployments list`); a push to
`main` is the deploy.

## Rollback

- **C** — code-only, clean rollback.
- **B** — code-only. Removing the `[[ratelimits]]` block removes the binding; code
  already skips a missing binding, so ordering is not a hazard.
- **A** — the `tenants.allow_forks` column persists across a Worker rollback. It is
  additive with a default, so pre-A code ignores it. Set `FORK_GATE_MODE=off`
  before rolling back rather than relying on the code revert alone.

## Open items

- Confirm Repository **Actions: read** is granted to the App — the fork gate is
  built on it (App settings → Permissions). This is a _verification_, not a change:
  if it is already present, Part A ships with no permission delta at all.
- Pick the `namespace_id` for `[[ratelimits]]`; it must be unique per Cloudflare
  account. `1001` assumed here, verify nothing else claims it.
- Tenant-facing README section: fork PRs are not provisioned by default, what to
  do about it, and the _Require approval for all external contributors_ setting we
  check by hand before enabling `allow_forks`.
- Follow-up experiment (not a blocker): settle whether
  `/actions/runs/{run_id}/approvals` or `triggering_actor` reliably identifies a
  maintainer-approved fork run, using a real fork PR on
  `atlasnetwork-xyz/test-ghar`. A positive result upgrades `allow_forks` from
  trust to verification with no permission change.
