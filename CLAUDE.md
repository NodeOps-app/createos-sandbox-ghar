# CLAUDE.md — createos-sandbox-ghar

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
       → createSandbox + detached runner launch (sandbox.ts) → DO.markRunning
completed webhook → DO.onCompleted → destroy VM + dequeue next pending
cron (*/5) → src/index.ts scheduled → handler.runReaper → DO.sweep → destroy orphans
```

## File responsibilities (each one thing; keep files < 1100 lines)
- `src/index.ts` — Worker entry: fetch router (`/health`, `/webhook`) + `scheduled` (cron). Exports the `Coordinator` DO.
- `src/config.ts` — `loadConfig(env)` → validated `Config`. All env parsing lives here.
- `src/types.ts` — shared domain types. The interface contract between modules.
- `src/webhook.ts` — `verifySignature` (HMAC), `parseWorkflowJob`, `matchesLabel`. Pure.
- `src/policy.ts` — `shouldProvision` switch (org-wide / repo-allowlist / fork-gated). Pure; fork check injected.
- `src/sandbox.ts` — `provisionSandbox` (JIT → createSandbox → detached runner) + `teardownSandbox` (idempotent). Wraps the createos SDK. `SandboxDeps.makeClient` is the test injection seam.
- `src/coordinator.ts` — the `Coordinator` **Durable Object**. ALL state (SQLite): Job→Sandbox map, concurrency counter, pending queue, delivery-dedup, `sweep`. RPC methods: `onQueued`, `markRunning`, `onCompleted`, `sweep`, `activeCount`.
- `src/github/{jwt,auth,client}.ts` — zero-dep GitHub App auth: RS256 JWT (Web Crypto) → installation-token cache → `GitHubClient` (`generateJitConfig`, `isForkJob`).
- `template/` — pre-baked runner rootfs (`Dockerfile` RUN-only, `start-runner.sh`, `build.ts`). Built manually against a real createos control plane; not part of the Worker bundle.

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

## Conventions
- **bun only** — never npm/npx/node. Pin exact (`bun add -E`).
- **Deploy with `bunx wrangler@latest deploy`** — always this exact command (not `node_modules/.bin/wrangler`), so deploys use the latest wrangler.
- **Tests: implement-then-test (NO TDD).** Write the code, then comprehensive tests, then commit. Two layers: plain `vitest` for pure logic (jwt/hmac/policy/config), `@cloudflare/vitest-pool-workers` for real-DO integration (webhook flow, cap, idempotency, reaper). Mock GitHub + createos at the `fetch` boundary; never hit the network in tests.
- **oxlint + oxfmt** on every `.ts` change.
- **Conventional Commits**, imperative subject ≤ 50 chars, atomic.
- Self-documenting code over comments; comment the *why* / design decisions.
- **CF Free plan is a hard constraint** (`docs/adr/0002`): DO must stay `new_sqlite_classes`; keep the DO passive (state only) so it hibernates; do all blocking network I/O (createSandbox poll, GitHub API, destroy) in the Worker, not the DO; reaper is a **cron trigger**, not DO alarms.

## Changing the domain model
If you rename/add a domain concept, update `CONTEXT.md` in the same change. If you make a hard-to-reverse, surprising, trade-off decision, add an ADR under `docs/adr/`. Use the `domain-modeling` skill.

## Adding a feature
Brainstorm → (if multi-step) write a plan under `docs/superpowers/plans/` → implement-then-test → keep `CONTEXT.md`/ADRs in sync. Prefer the `superpowers:brainstorming` and `writing-plans` skills for non-trivial work.

## Not done yet
Deploy is not done (needs GitHub App creds + a real template build + `RUNNER_TEMPLATE`/`CREATEOS_BASE_URL`). See `README.md`. Optional future teardown upgrade tracked at NodeOps-app/fc#520 (guest self-destruct) — not a dependency.
