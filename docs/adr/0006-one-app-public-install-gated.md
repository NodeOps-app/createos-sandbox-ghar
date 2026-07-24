# One public GitHub App, install-gated tenancy

**Status:** accepted (supersedes the spec §9 "new App, quiet swap" cutover)

One public GitHub App (`createos-runners`) serves every tenant. Each install =
one installation id = one Tenant. **Public install does not grant runners:**
installing the App is open to any GitHub org, but admission to actually run
jobs is gated by the backend Tenant registry — an unapproved install's jobs are
ignored and get a single neutral check run pointing at the apply link (D16/D17).

## What changed from the spec

Spec §9/§10 planned a **new** public App and a quiet-swap migration (install new
App → seed → swap secrets + flip → retire the old private App). We instead made
the **existing** App public and reused it. The cutover was therefore:

1. Workers Paid upgrade (legalizes the multi-tenant subrequest fan-out) +
   raise `RECOVERY_SUBREQUEST_BUDGET` (30 → 200).
2. Make the existing App public + confirm it carries all D17 permissions
   (org Self-hosted runners R/W, repo Actions R, Checks R/W, Metadata R).
3. Seed NodeOps as Tenant #1 on its **existing** installation id
   (`allow_all_repos`), backfill `jobs.tenant_id`.
4. Flip `TENANCY_MODE=multi` + set `APPLY_FORM_URL` in one deploy. **No secret
   swap** — same App ID, PKCS#8, webhook secret, installation id — so there is
   no 401 window and no App to retire.

## Why reuse beat a new App

- No credential swap → no cutover window where `queued` webhooks 401 and wait
  for the reconciler. The flip is flag-only and atomically rollback-safe.
- NodeOps keeps its existing installation id, so the Tenant is seeded on the id
  that is already live — no re-key, no stranded registry/ledger rows.
- One App total, one delivery log, one set of permissions to audit.

## Rejected

- **Dual-App verification (multi-secret HMAC)** — permanent multi-secret
  complexity to buy back only a one-time recovery delay; `onQueued` is
  idempotent on `job_id` and the reconciler re-drives lost webhooks.
- **New public App + retire old** — adds a secret swap and a retirement window
  for no functional gain once the existing App can be made public.

Revisit only if we ever need distinct permission sets or rate-limit isolation
between internal (NodeOps) and community traffic on the same App.
