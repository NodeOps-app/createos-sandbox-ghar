# Multi-Tenant Plan 3: Cutover Implementation Plan

> **⚠️ SUPERSEDED — do not follow.** Executed 2026-07-24, but the deployment
> **reused the existing public App** (`createos-runners`) rather than creating a
> new one and swapping secrets. The authoritative record of what actually shipped
> is **ADR [0006](../../adr/0006-one-app-public-install-gated.md)**. Tasks 2/3/6
> (create new App, install it, retire old App) and the Task 5 secret-swap below
> **did not happen** — following them now would cause a webhook outage and could
> strand installation-keyed tenant data. Kept for history only.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Most tasks here are OPERATIONAL (dashboard + curl + secrets), not code — execute them in order, verify each before the next, and STOP at every marked confirmation gate.

**Goal:** Move production from the private single-tenant App to the public multi-tenant App: Workers Paid, public App created and installed, NodeOps seeded as Tenant #1, `TENANCY_MODE=multi` flipped, old App retired, first community tenant onboarded.

**Architecture:** No new subsystems — this plan sequences the spec §9/§10 cutover. The one load-bearing ordering: **install the new App before deploying the flip** (old code 401s the new App's deliveries cleanly; reverse the order and there is a real gap where the old App is live and nothing accepts it). The flip itself is secrets + flag in one push; the ~minutes of 401'd `queued` webhooks between the secret swap and the deploy going live are recovered by the reconciler within one 5-minute tick (idempotent on `job_id`).

**Tech Stack:** Cloudflare dashboard, GitHub App settings, `wrangler secret`, curl.

**Spec:** `docs/superpowers/specs/2026-07-22-multi-tenant-community-runners-design.md` (§9 cutover, §10 steps 4–7, D4/D7/D17/D18)
**Prerequisites:** Plans 2a + 2b deployed to prod with `TENANCY_MODE=single`, latest `ghar-test` smoke green, admin API verified against prod (Plan 1 Task 5).

## Global Constraints

- **Every irreversible or outward-facing step has a STOP gate — get explicit operator/user confirmation before executing it.** Marked ⛔ below. No exceptions, even mid-flow.
- **Always be ready to roll back before pushing:** capture `bunx wrangler@latest deployments list` active version id before EVERY push; keep the old App's secrets in the team vault until Task 8 — rollback = `wrangler rollback` + re-`secret put` the old values + `TENANCY_MODE` revert push.
- **A push to `main` is a production deploy.** Full gate (`bun run lint && bun run typecheck && bun run test`) before every push.
- **Performance and cost are priorities:** the Paid-plan upgrade is what legalizes the multi-tenant subrequest fan-out (50 → 10,000); do NOT flip the flag on the Free plan — a busy tick would exhaust subrequests mid-reconcile.
- **Secrets never in git, logs, or transcripts** — vault only. bun only. Conventional Commits.

---

### Task 1: Workers Paid + recovery budget

- [ ] **Step 1:** ⛔ **STOP — confirm with the operator:** upgrading the Cloudflare account to Workers Paid ($5/mo, billed to the account). On confirmation: Cloudflare dashboard → Workers & Pages → Plans → **Workers Paid**.
- [ ] **Step 2:** Verify: dashboard shows Paid; the account limit for subrequests is now 10,000/invocation (Workers docs "Account plan limits" table is the reference — no runtime probe needed).
- [ ] **Step 3:** Raise the recovery budget in `wrangler.toml`:

```toml
# Max GitHub subrequests the 5-min recovery scan may spend before deferring the
# tail to the next tick (cursor-resumed). Was 30 under the Free-plan 50-cap;
# on Workers Paid (10,000/invocation) the bound is CreateOS/GitHub courtesy and
# cron wall-time, not the platform. 200 covers every current tenant in one tick;
# the warn-on-bind + (tenant, repo) cursor remain the overflow behavior.
RECOVERY_SUBREQUEST_BUDGET = "200"
```

- [ ] **Step 4:** Gate, capture rollback version, commit, push:

```bash
bun run lint && bun run typecheck && bun run test
bunx wrangler@latest deployments list
git add wrangler.toml && git commit -m "chore: raise recovery budget for Workers Paid" && git push origin main
```

Verify `/health` and one clean cron tick in `wrangler tail` (no budget-bound warning).

---

### Task 2: Create the public GitHub App

- [ ] **Step 1:** Generate and vault a fresh webhook secret: `openssl rand -hex 32`.
- [ ] **Step 2:** GitHub → NodeOps-app org → Settings → Developer settings → GitHub Apps → **New GitHub App**:
  - Name: `createos-runners` (public listing name — user-facing).
  - Homepage: the community docs/README URL.
  - Webhook URL: `https://<worker-url>/webhook`; Webhook secret: the value from Step 1.
  - **Permissions** (D17 — set ALL at creation; adding later forces every install to re-accept):
    - Organization → Self-hosted runners: **Read and write** (JIT config + runner groups + runner list/delete)
    - Repository → Actions: **Read** (runs/jobs for recovery + fork lookup)
    - Repository → Checks: **Read and write** (refusal notices)
    - Repository → Metadata: **Read** (implicit)
  - **Subscribe to events:** `Workflow job`.
  - Where can this App be installed: **Any account** (public — the backend whitelist is the gate, D16).
- [ ] **Step 3:** After creation: note the **App ID**; **Generate a private key** (downloads PEM). Convert to PKCS#8 for Web Crypto (the shipped jwt.ts expects PKCS#8):

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in <downloaded>.pem -out app-pkcs8.pem
```

Vault: App ID, PKCS#8 PEM, webhook secret. Delete local key files after vaulting.

---

### Task 3: Install the public App on NodeOps-app — BEFORE any deploy

- [ ] **Step 1:** App settings → Install App → NodeOps-app → **All repositories** (D18: NodeOps is the `allow_all_repos` tenant).
- [ ] **Step 2:** Record the **new installation id**: it is the trailing number in the installation's settings URL (`…/settings/installations/<id>`), or via API with an App JWT: `GET /orgs/NodeOps-app/installation` → `.id`.
- [ ] **Step 3:** Verify safety property of the overlap window: App advanced tab shows `workflow_job` deliveries being sent and receiving **401** from the Worker (old code, old secret — clean rejection, no state touched). NodeOps CI continues via the old App. This is the expected state until Task 5.

---

### Task 4: Seed the NodeOps tenant + backfill (new installation id)

Spec §10 step 4 — the seed uses the NEW App's installation id (the Plan-1 timing fix: seeding earlier would have keyed the tenant on the old App's id, which Task 5 invalidates).

- [ ] **Step 1:** Create the tenant (full-record upsert — every field required by design; `<NEW_INSTALLATION_ID>` from Task 3, `<ADMIN_TOKEN>` from the vault):

```bash
curl -sf https://<worker-url>/admin/tenants \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{
    "installation_id": <NEW_INSTALLATION_ID>,
    "org_login": "NodeOps-app",
    "status": "approved",
    "allow_all_repos": true,
    "minute_grant": 1000000,
    "concurrency_cap": 50,
    "max_shape": "s-8vcpu-16gb",
    "job_ttl_ms": 1800000,
    "runner_group_id": 1,
    "contact": null,
    "notes": "Tenant #1 — internal. allow_all_repos; Default runner group.",
    "approved_by": "pratik"
  }'
```

(`allow_all_repos: true` skips runner-group creation by design — group 1 = the org Default group, correct for the all-repos tenant. `minute_grant` is effectively unlimited internally; `concurrency_cap` 50 matches today's `MAX_CONCURRENT`.)

- [ ] **Step 2:** Backfill pre-tenant job rows:

```bash
curl -sf https://<worker-url>/admin/backfill \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"installation_id": <NEW_INSTALLATION_ID>}'
```

Expect `{"ok":true,"claimed":<n>}` — n = live rows at this moment (likely small; 0 on a quiet system is fine).

- [ ] **Step 3:** Verify: `GET /admin/tenants` shows the record with `status: "approved"`, `approvedAt` stamped, `approvedBy: "pratik"`.

---

### Task 5: The flip — secrets + flag in one push

⛔ **STOP — operator confirmation before starting: this changes production webhook auth. From the secret swap until the push goes live (~minutes), `queued` webhooks 401 and are recovered by the next reconciler tick. Schedule in a quiet window.**

- [ ] **Step 1:** Pre-flight: `bun run lint && bun run typecheck && bun run test` green; `bunx wrangler@latest deployments list` → note the active version id; old App's four secret values confirmed present in the vault.
- [ ] **Step 2:** Edit `wrangler.toml`: `TENANCY_MODE = "multi"`; set `APPLY_FORM_URL` to the Google Form link. Commit (do NOT push yet):

```bash
git add wrangler.toml && git commit -m "feat: flip tenancy to multi"
```

- [ ] **Step 3:** Swap the secrets to the new App, then push immediately (back-to-back — this opens the 401 window, the push closes it):

```bash
bunx wrangler@latest secret put GITHUB_APP_ID              # new App ID
bunx wrangler@latest secret put GITHUB_APP_PRIVATE_KEY     # new PKCS#8 PEM
bunx wrangler@latest secret put GITHUB_WEBHOOK_SECRET      # new webhook secret
bunx wrangler@latest secret put GITHUB_INSTALLATION_ID     # <NEW_INSTALLATION_ID> (config requires it; multi mode uses per-tenant ids)
git push origin main
```

- [ ] **Step 4:** Verification checklist, in order:
  1. Workers Builds: deploy live. `/health` → ok.
  2. New App advanced tab: next `workflow_job` delivery → **202** (redeliver one if the queue is idle).
  3. **Actions → ghar-test → Run workflow**: microVM boots via the NEW App identity, runs green, disappears; `wrangler tail` shows the spawn timeline line.
  4. After that job completes: `GET /admin/tenants` unchanged, and a `usage` month row exists for the NodeOps tenant (billing is live — check via a one-off authenticated call or the next ops query).
  5. Old App advanced tab: its deliveries now 401 (expected — it is done).
- [ ] **Step 5 (only on failure):** rollback = `bunx wrangler@latest rollback <version-id>` + re-`secret put` the four OLD values + revert the wrangler.toml commit + push. Schema needs nothing (additive). Diagnose second.

---

### Task 6: Retire the old App

⛔ **STOP — operator confirmation: uninstalling the old App ends its deliveries permanently.**

- [ ] **Step 1:** Wait for ≥ 1 day of clean multi-mode operation (smoke green, no teardown/provision alerts in Slack).
- [ ] **Step 2:** Uninstall `createos-runners-by-nodeops` from NodeOps-app (org Settings → GitHub Apps → Configure → Uninstall). Do **not** delete the App entity yet — its delivery log is the forensic backstop; delete after Task 8.
- [ ] **Step 3:** Watch one more smoke run + one reconciler tick clean.

---

### Task 7: Docs + ADRs

- [ ] **Step 1:** Write `docs/adr/0005-single-do-multi-tenancy.md`:

```markdown
# Single-DO multi-tenancy with org-level tenants

**Status:** accepted

All tenants share the one singleton Coordinator DO; a Tenant is a GitHub org
keyed by App installation id; a Project is an approved repo; quota (weighted
minutes, calendar-month UTC) is enforced on the Tenant and attributed per
Project. Tenant ownership lives in `jobs.tenant_id` — never in runner or VM
names, whose byte budgets (JIT blob ~4085/4096; sandbox name ≤22 chars) have
no room for a tenant tag.

Rejected: per-tenant DOs (serialization relief not yet needed; would have
required moving live rows between objects — the one migration a Worker
rollback cannot undo — and would have broken the name-based orphan sweep);
per-repo quota (repos are free to create — quota on the org, admission on the
repo); a global capacity arbiter (operator keeps Σ caps ≤ plan capacity).

Revisit when queued→provisioning p95 climbs under concurrent tenant bursts or
DO duration billing becomes visible; `jobs.tenant_id` makes the split
mechanical.
```

- [ ] **Step 2:** Write `docs/adr/0006-one-app-quiet-cutover.md`:

```markdown
# One public GitHub App, quiet-swap cutover

**Status:** accepted

One public App serves every tenant (each install = one installation id = one
Tenant). The migration from the private single-tenant App was a quiet swap:
install new App → seed tenant → swap secrets + flip TENANCY_MODE in one
deploy → uninstall old App. Ordering is load-bearing: install BEFORE deploy,
so the old code 401s the new App cleanly and no delivery source is ever
unaccepted.

Rejected: dual-App verification (multi-secret HMAC). onQueued is idempotent
on job_id and the reconciler re-drives any queued webhook lost in the
~minutes flip window, so permanent multi-secret complexity bought back only
a one-time 5-minute recovery delay on a handful of jobs.
```

- [ ] **Step 3:** `CONTEXT.md`: update **Org** (no longer one fixed org — a Tenant's org; NodeOps is Tenant #1) and **Provisioning policy** (single-mode term; in multi mode the registry IS the policy). `AGENTS.md`: request-flow diagram gains the tenant gate ladder; gotcha updated — the Free-plan constraint paragraph now says the account is on Workers Paid and which limits stopped binding (subrequests, daily requests), while the "keep the DO passive/hibernating" discipline stays. `README.md`: cutover runbook link, tenant onboarding runbook (Task 8's flow), env table.
- [ ] **Step 4:** Gate + commit + push (docs only):

```bash
bun run lint && bun run typecheck && bun run test
git add docs CONTEXT.md AGENTS.md README.md
git commit -m "docs: record multi-tenant ADRs and cutover" && git push origin main
```

---

### Task 8: First community tenant + burn-in close-out

- [ ] **Step 1:** Onboard the first external org (the runbook this step also validates):
  1. Application arrives via the Google Form (fields per `docs/community/onboarding-form.md`).
  2. Review; size grant/cap/shape/TTL from Section 3 of the form.
  3. They install the public App on their org, selecting the repos.
  4. `POST /admin/tenants` (status `pending`, their installation id from the App's installations list) + `POST /admin/projects` with the approved repos (repo ids via `GET /repos/{owner}/{repo}` → `.id`).
  5. `POST /admin/tenants` again with `status: "approved"` — the runner group is auto-created scoped to their repos (fail-closed; a 502 here means fix GitHub-side and retry, the tenant stays unapproved).
  6. Tell them: swap `runs-on: ubuntu-latest` → `runs-on: createos` (or a shaped label ≤ their ceiling).
- [ ] **Step 2:** Verify the gates fire in the wild, once each:
  - a job from a NON-approved repo in their org → 202 + ONE neutral check run;
  - an approved-repo job → VM boots in THEIR runner group (org → Settings → Actions → Runner groups shows the ephemeral runner under `createos`), runs green, self-deletes;
  - `usage` rows for their tenant show the weighted minutes and the per-repo attribution; the VM had `bandwidth_quota_bytes` set (CreateOS dashboard or `getBandwidth`).
- [ ] **Step 3:** ⛔ **STOP — after ≥ 1 week clean burn-in, confirm with the operator, then** delete the old App entity, purge its secrets from the vault, and file the follow-up cleanup issue: remove the `TENANCY_MODE=single` branches and the now-dead `GITHUB_ORG` / `PROVISION_POLICY` / `REPO_ALLOWLIST` config reads (a small standalone plan — deletion only, after the flag has no way back).

---

## Self-review checklist

- Order preserved everywhere: Paid → App created → **installed** → seeded → flip → retire. No task reads state a later task creates.
- Every ⛔ gate precedes the irreversible action it guards (billing, webhook auth, uninstall, delete).
- Rollback path stated at every deploy, and the old App's secrets survive in the vault until the final gate.
