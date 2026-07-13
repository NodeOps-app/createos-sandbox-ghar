# AGENTS.md — createos-sandbox-ghar

Contributor guide for humans and coding agents (Claude Code, Codex, Cursor, …). `CLAUDE.md` is a symlink to this file — one source of truth. Read this before editing.

## What this is

A Cloudflare Worker that autoscales **ephemeral GitHub Actions self-hosted runners** — one CreateOS Sandbox microVM per queued `workflow_job`, destroyed when the job finishes. `README.md` covers setup and operation; this file covers the code.

## Onboarding in 60 seconds

```bash
bun install
bun run lint && bun run typecheck && bun run test   # must be green before you start
```

Then read, in order: `CONTEXT.md` (domain vocabulary — use these words), `src/types.ts` (the contract between modules), `src/handler.ts` (the whole request flow in one file).

## Request flow

```
workflow_job webhook → src/index.ts (POST /webhook) → src/handler.ts
  verify HMAC (webhook.ts) → parse + label filter (webhook.ts)
  → policy check (policy.ts) → Coordinator DO (coordinator.ts): onQueued
  → if provision: mint JIT config (github/client.ts → auth.ts → jwt.ts)
       → createSandbox (sandbox.ts) → DO.recordSandboxCreated (records VM + runner
         name BEFORE launch; says destroy if the job already completed)
       → launchRunner detached → DO.markRunning  (any failure → DO.markProvisionFailed → frees slot)

runner exits → start-runner.sh POSTs 127.0.0.1:1029/self/delete → host destroys the VM
  in seconds (fast path; reclaims the host VM only, not the DO slot; best-effort)

completed webhook → DO.onCompleted(jobId, runner_name) → destroy the VM that ran the job
  (by runner identity; NotFound if self-delete beat it) → DO.markDestroyed → dequeue next pending

cron (*/5) → src/index.ts scheduled → handler.runReconciler → handler.runReaper → DO.sweep
```

## File responsibilities

Each file does one thing. Keep files under 1100 lines.

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Worker entry: `fetch` router (`/health`, `/webhook`) + `scheduled` (cron). Exports the `Coordinator` DO. |
| `src/config.ts` | `loadConfig(env)` → validated `Config`. **All** env parsing lives here. |
| `src/types.ts` | Shared domain types — the interface contract between modules. |
| `src/webhook.ts` | `verifySignature` (HMAC), `parseWorkflowJob`, `matchesLabel`. Pure. |
| `src/policy.ts` | `shouldProvision` (org-wide / repo-allowlist / fork-gated). Pure; the fork check is injected. |
| `src/handler.ts` | Orchestration: webhook path, provisioning, teardown, reconciler, reaper. |
| `src/sandbox.ts` | `createRunnerSandbox` (JIT → createSandbox) and `launchRunner` as **two steps**, so ownership is recorded in the DO between them; plus idempotent `teardownSandbox`. `SandboxDeps.makeClient` is the test seam. |
| `src/coordinator.ts` | The `Coordinator` **Durable Object**. ALL state (SQLite): job rows (owning their VM by `runner_name`), concurrency counter, pending queue, delivery dedup, `sweep`. Rows: `pending`→`provisioning`→`running`→`destroying`. |
| `src/github/{jwt,auth,client}.ts` | Zero-dep GitHub App auth: RS256 JWT (Web Crypto) → installation-token cache → `GitHubClient`. |
| `src/notify.ts` | Optional Slack-style failure webhook. No-op if unset; never throws. |
| `template/` | Pre-baked runner rootfs (`Dockerfile` + `build.ts`). Not part of the Worker bundle. |

## Commands

```bash
bun run test        # vitest: unit + real-DO integration
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint
bun run dev         # wrangler dev (needs .dev.vars)
bun run deploy      # bunx wrangler@latest deploy
bun run build:template   # rebuild the ghar-runner rootfs (needs CREATEOS_* env)
```

## Gotchas — read these, they will bite you

- **Do NOT upgrade `@cloudflare/vitest-pool-workers` past `0.8.71` or `vitest` past `3.2.4`.** The vitest-4 line of pool-workers ships no `defineWorkersConfig` / `./config` export and `vitest.config.ts` breaks. The pin is deliberate.
- **Never call `fetch` as a method** (`this.x.fetch(...)`, `obj.fetch(...)`) — Workers throws `Illegal invocation` when `fetch`'s `this` isn't `globalThis`. Bind at the injection seam (`fetch.bind(globalThis)`) or call through a local var. Tests mock `fetch`, so they will **not** catch this; only a real run does.
- **`RUNNER_DISK_MIB` must be ≤ your CreateOS plan's disk cap** or `createSandbox` returns 403. The code default (30720) exceeds the common 10240 cap.
- **`GITHUB_INSTALLATION_ID` is the numeric installation id**, not the App client id (`Iv23…`). The wrong one makes token minting 404.
- **The Cloudflare Free plan is a hard constraint.** The DO must stay `new_sqlite_classes`; keep it passive (state only) so it hibernates; do all blocking network I/O (createSandbox poll, GitHub API, destroy) in the Worker, not the DO; the reaper is a **cron trigger**, not a DO alarm.
- `vitest.config.ts` `miniflare.bindings` holds a **throwaway test-only PKCS#8 key** — not a secret. Real secrets live in `.dev.vars` (gitignored) or `wrangler secret`.
- The runner launch script is embedded in `template/Dockerfile` via `printf` (the template builder permits `RUN` only — no `COPY`/heredoc). That Dockerfile is its single source of truth.

## Conventions

- **bun only** — never npm/npx/node. Pin exact versions (`bun add -E`).
- **Deploy with `bunx wrangler@latest deploy`**, so deploys always use the latest wrangler.
- **Implement, then test — no TDD.** Two layers: plain `vitest` for pure logic (jwt/hmac/policy/config), `@cloudflare/vitest-pool-workers` for real-DO integration (webhook flow, cap, idempotency, reaper). Mock GitHub and CreateOS at the `fetch` boundary; **never hit the network in tests**.
- **oxlint + oxfmt** on every `.ts` change.
- **Conventional Commits**, imperative subject ≤ 50 chars, atomic.
- Self-documenting code over comments; comment the *why*, not the *what*.
- **No silent bounds.** Any cap, limit, truncation or early-exit you add MUST `console.warn` when it actually binds — log the bound, the identifier, and how much was collected or dropped (see `#getPaged` warning on `MAX_PAGES`). A silent cap reads as "covered everything" when it didn't.
- If you rename or add a domain concept, update `CONTEXT.md` in the same change.

## Definition of done

Before claiming a change works:

1. `bun run lint && bun run typecheck && bun run test` — all green, no new warnings.
2. New behaviour has tests at the right layer (pure → `test/unit`, DO/flow → `test/integration`).
3. `CONTEXT.md` / `README.md` updated if the domain model or the operator-facing surface changed.
4. For anything touching the provisioning or teardown path, run the end-to-end smoke: **Actions → `ghar-test` → Run workflow** — a `ghar-<jobId>` microVM must boot, run green, and disappear.

Do not claim "it works" from a passing test suite alone if you changed the runtime path — the tests mock the network, so they cannot catch Workers-runtime traps (see the `fetch` gotcha above).

> A local, untracked `.agents/` directory (if present) holds this deployment's ADRs, design specs and status notes. Read it before changing architecture; it is not part of the public repo.
