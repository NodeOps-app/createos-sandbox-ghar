# CLAUDE.md — createos-sandbox-ghar

> Cost 

Guidance for Claude Code (and human collaborators) working in this repo. Read this before editing.

## What this is
A Cloudflare Worker that autoscales **ephemeral GitHub Actions self-hosted runners** for the `nodeops-app` org — one createos microVM per queued `workflow_job`, destroyed when the job finishes.

Design context (read, don't re-derive):
- `CONTEXT.md` — glossary / ubiquitous language.
- `docs/adr/0001-*` — ephemeral VM-per-job on createos (the core architecture).
- `docs/adr/0002-*` — single SQLite Durable Object on the CF Free plan.
- `docs/superpowers/plans/2026-07-05-createos-ghar-controller.md` — the full implementation plan (16 tasks, complete code).
- `README.md` — setup + deploy runbook.

## Architecture (request flow)
```
workflow_job webhook → src/index.ts (POST /webhook) → src/handler.ts
  verify HMAC (webhook.ts) → parse + label filter (webhook.ts)
  → policy check (policy.ts) → Coordinator DO (coordinator.ts): onQueued
  → if provision: mint JIT config (github/client.ts → auth.ts → jwt.ts)
       → createSandbox (sandbox.ts) → DO.recordSandboxCreated (records VM+runner
         name BEFORE launch; says destroy if job already completed)
       → launchRunner detached → DO.markRunning   (any failure → DO.markProvisionFailed → frees slot)
runner exits → start-runner.sh POSTs 127.0.0.1:1029/self/delete → host destroys the
  VM in seconds (fast path; reclaims host VM only, not the DO slot; best-effort)
completed webhook → DO.onCompleted(jobId, runner_name) → destroy the VM that ran
  the job (by runner identity; NotFound if self-delete beat it) → DO.markDestroyed on confirm → dequeue next pending
cron (*/5) → src/index.ts scheduled → handler.runReaper → DO.sweep → destroy orphans + retry unconfirmed destroys
```

## File responsibilities (each one thing; keep files < 1100 lines)
- `src/index.ts` — Worker entry: fetch router (`/health`, `/webhook`) + `scheduled` (cron). Exports the `Coordinator` DO.
- `src/config.ts` — `loadConfig(env)` → validated `Config`. All env parsing lives here.
- `src/types.ts` — shared domain types. The interface contract between modules.
- `src/webhook.ts` — `verifySignature` (HMAC), `parseWorkflowJob`. Pure.
- `src/policy.ts` — `shouldProvision` switch (org-wide / repo-allowlist / fork-gated). Pure; fork check injected.
- `src/sandbox.ts` — `createRunnerSandbox` (JIT → createSandbox, returns the handle + runner name) and `launchRunner` (detached runner) as **two steps** so the Worker can record ownership in the DO between them; plus `teardownSandbox` (idempotent). Wraps the createos SDK.
- `src/createos.ts` — builds the createos SDK client; owns `SandboxDeps` (`makeClient` test injection seam, `attemptId`). Exists to break the `sandbox.ts` ↔ `shapes.ts` import cycle.
- `src/shapes.ts` — label ↔ shape mapping, the cached (5 min) + floored shape catalog from `GET /v1/shapes`, and label admission. Pure parts (`createosLabels`, `shapeForLabel`, `pickLabel`) never touch the network.
- `src/coordinator.ts` — the `Coordinator` **Durable Object**. ALL state (SQLite): job rows (owning their Sandbox by `runner_name`, and their requested `label`), concurrency counter, pending queue, delivery-dedup, `sweep`. Row states: `pending`→`provisioning`→`running`→`destroying`. RPC: `onQueued`, `recordSandboxCreated` (launch|destroy), `markRunning`, `markProvisionFailed` (frees slot on failure), `onCompleted(jobId, runnerName?)`, `markDestroyed` (confirm teardown), `sweep`, `activeCount`.
- `src/github/{jwt,auth,client}.ts` — zero-dep GitHub App auth: RS256 JWT (Web Crypto) → installation-token cache → `GitHubClient` (`generateJitConfig(runnerName, label)`, `isForkJob(repoFullName, runId)`). API base is `config.githubApiUrl` (`GITHUB_API_URL`, default api.github.com).
- `src/notify.ts` — `notify(config, text)`: optional Slack-style failure webhook (`ALERT_WEBHOOK_URL`). No-op if unset; never throws. Called from the `provision failed` path in `handler.ts`.
- `template/` — pre-baked runner rootfs. See `template/CLAUDE.md` for build details. Not part of the Worker bundle.

## Dev commands (deps already installed; run via local bins)
```
node_modules/.bin/vitest run       # or: bun run test
node_modules/.bin/tsc --noEmit     # or: bun run typecheck
node_modules/.bin/oxlint src test  # or: bun run lint
node_modules/.bin/wrangler dev     # or: bun run dev
```

## Toolchain gotchas — READ, will bite you
- **Do NOT upgrade `@cloudflare/vitest-pool-workers` past `0.8.71` or `vitest` past `3.2.4`.** The vitest-4 line of pool-workers (0.16–0.18) ships no `defineWorkersConfig`/`./config` export — `vitest.config.ts` breaks. This pin is deliberate; justified in the plan's Global Constraints.
- **The SDK `@nodeops-createos/sandbox` is `bun link`'d** to sibling `../fc-sdk` (`link:` in package.json), NOT `file:`. It is unpublished. If it goes missing: `cd ../fc-sdk && bun link` then `bun link @nodeops-createos/sandbox`.
- **Do not casually reinstall deps.** If `node_modules` breaks, do ONE clean pass: `rm -rf node_modules bun.lock && /Users/ctos/.bun/bin/bun install`, no competing process, then verify `node_modules/.bin` is populated. (A `safe-chain` npm MITM scanner previously corrupted installs; it has been removed.)
- `vitest.config.ts` `miniflare.bindings` holds a **throwaway test-only PKCS#8 key** + test env — not a secret. Real secrets go in `.dev.vars` (gitignored) / `wrangler secret`.
- **Never call `fetch` as a method** (`this.x.fetch(...)`, `obj.fetch(...)`) — Workers throws `Illegal invocation` when fetch's `this` isn't `globalThis`. Bind at the injection seam (`fetch.bind(globalThis)`) or call through a local var. Tests mock fetch so they will NOT catch this; only a real run does. (Bit us via the SDK + GitHub client.)
- **`RUNNER_DISK_MIB` must be ≤ your createos plan's disk cap** (10240 MiB on the current plan) or `createSandbox` 403s. The code default (30720) exceeds it.
- **`GITHUB_INSTALLATION_ID` is the numeric installation id**, not the App client id (`Iv23…`) — the wrong one makes token minting 404.
- **The shape catalog is only consulted on `queued`.** A `completed` webhook must never depend on `GET /v1/shapes` — teardown keys on runner identity, and gating it on the catalog would leak every shaped VM during a shapes outage.
- **`src/shapes.ts` holds a module-level cache.** Tests that stub `listShapes` must call `resetShapeCacheForTests()` in `beforeEach` or the first suite's catalog leaks into the next.

## Conventions
- **bun only** — never npm/npx/node. Pin exact (`bun add -E`).
- **Deploy with `bunx wrangler@latest deploy`** — always this exact command (not `node_modules/.bin/wrangler`), so deploys use the latest wrangler.
- **Tests: implement-then-test (NO TDD).** Write the code, then comprehensive tests, then commit. Two layers: plain `vitest` for pure logic (jwt/hmac/policy/config), `@cloudflare/vitest-pool-workers` for real-DO integration (webhook flow, cap, idempotency, reaper). Mock GitHub + createos at the `fetch` boundary; never hit the network in tests.
- **oxlint + oxfmt** on every `.ts` change.
- **Conventional Commits**, imperative subject ≤ 50 chars, atomic.
- Self-documenting code over comments; comment the *why* / design decisions.
- **No silent bounds.** Any cap, limit, truncation, or guard you add (page cap, max-retries, batch size, top-N, sampling, early-exit) MUST `console.warn` when it actually binds — i.e. when the bound is what stopped the work, not the data. A silent cap reads as "covered everything" when it didn't. Log the bound, the identifier, and how much was collected/dropped (e.g. `#getPaged` warns on `MAX_PAGES`). Never truncate coverage without a trace.
- **CF Free plan is a hard constraint** (`docs/adr/0002`): DO must stay `new_sqlite_classes`; keep the DO passive (state only) so it hibernates; do all blocking network I/O (createSandbox poll, GitHub API, destroy) in the Worker, not the DO; reaper is a **cron trigger**, not DO alarms.

## Changing the domain model
If you rename/add a domain concept, update `CONTEXT.md` in the same change. If you make a hard-to-reverse, surprising, trade-off decision, add an ADR under `docs/adr/`. Use the `domain-modeling` skill.

## Adding a feature
Brainstorm → (if multi-step) write a plan under `docs/superpowers/plans/` → implement-then-test → keep `CONTEXT.md`/ADRs in sync. Prefer the `superpowers:brainstorming` and `writing-plans` skills for non-trivial work.

## Status
See `docs/STATUS.md` for deployment history and known gaps.
