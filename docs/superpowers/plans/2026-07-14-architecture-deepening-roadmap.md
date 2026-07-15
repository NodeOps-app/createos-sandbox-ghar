# Architecture Deepening Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply all five architecture-review recommendations as independently reviewable, deployable refactors without losing the current provisioning-leak fixes.

**Architecture:** Five focused plans deepen one seam at a time. Job admission moves first because it has demonstrated ordering bugs; the Coordinator's private retirement implementation follows without changing its public interface; runtime assembly then creates stable GitHub/CreateOS adapters; Worker lifecycle execution and orphan reclamation use those adapters to remove the remaining duplicated effect and sweep snippets.

**Tech Stack:** TypeScript 6.0.3, Bun, Cloudflare Workers + Durable Objects (SQLite), `@nodeops-createos/sandbox` 0.6.1, Vitest 3.2.4, `@cloudflare/vitest-pool-workers` 0.8.71, oxlint, oxfmt.

## Global Constraints

- Commit `03575a8` contains the provisioning and Orphaned Sandbox leak-hardening baseline. Start from that commit or a descendant and never rewrite or squash those fixes into a refactor commit.
- **Implement, then test — no TDD.** This project rule overrides the generic planning template.
- **bun only** — never npm, npx, or node. Keep exact dependency versions.
- Prefix every shell command with `rtk`, including every segment of a command chain.
- Keep the Coordinator passive. All GitHub/CreateOS network I/O remains in the Worker so the Durable Object can hibernate on the Cloudflare Free plan.
- Never call `fetch` as a method. Bind it at construction with `fetch.bind(globalThis)` or call it through a local function.
- Preserve ADR-0004: one Shape label per Runner, policy before Shape catalog, and no Shape catalog dependency on completed-webhook teardown.
- Preserve runner and Sandbox ownership proofs: minting and parsing must remain co-located and booting resources must be protected by `Coordinator.liveJobIds()`.
- No silent bounds. Any bound that binds must warn with the bound, identifier, and collected/dropped counts.
- Run `rtk oxfmt --write` on every changed TypeScript file, then `rtk bun run lint`, `rtk bun run typecheck`, and `rtk bun run test`.
- Conventional Commits, imperative subject, at most 50 characters, one atomic concern per commit.
- A push to `main` deploys production. Capture the active Worker version and rollback command before every merge; do not run `wrangler deploy` for these refactors.
- Any plan that changes provisioning or teardown requires a post-deploy `ghar-test` smoke run and verification that its Sandbox disappears.

---

## Required execution order

| Order | Plan | Why here | Depends on |
| --- | --- | --- | --- |
| 0 | Baseline `03575a8` | Confirm the leak-hardening commit is present and green | none |
| 1 | [Job admission module](2026-07-14-job-admission-module.md) | Highest correctness leverage; removes duplicated policy/catalog ordering | `03575a8` baseline |
| 2 | [Coordinator row retirement](2026-07-14-coordinator-row-retirement.md) | Pure Durable Object deepening with minimal file overlap | plan 1 only for baseline |
| 3 | [Runtime adapter seams](2026-07-14-runtime-adapter-seams.md) | Centralizes GitHub/CreateOS construction before Worker logic moves files | plans 1–2 |
| 4 | [Worker lifecycle execution](2026-07-14-worker-lifecycle-execution.md) | Moves provisioning/teardown effects using the assembled runtime | plan 3 |
| 5 | [Orphan reclamation module](2026-07-14-orphan-reclamation-module.md) | Last destructive refactor; reuses runtime and failure conventions | plans 3–4 |

The plans are ordered patches, not five alternatives. Later plans name interfaces produced by earlier plans and should be executed against the preceding plan's committed state.

## End-state file map

| File | Responsibility after all plans |
| --- | --- |
| `src/index.ts` | Worker routing and scheduled ordering only |
| `src/handler.ts` | Translate webhook/cron inputs into calls to deep modules; no duplicated admission, lifecycle, or reclamation snippets |
| `src/admission.ts` | Identify a Job's requested Runner label and perform ordered Job admission with one lazily shared Shape catalog per intake batch |
| `src/lifecycle.ts` | Provision/create-record-launch, provision-failure disposal, destroy-confirm, and execution of Coordinator effects |
| `src/reclamation.ts` | External-list-before-live-row orphan proof, bounded cleanup, warnings, and failure accounting for two adapters |
| `src/runtime.ts` | Construct one invocation-scoped Config, Coordinator stub, GitHub adapter, CreateOS adapter, and attempt-token source |
| `src/coordinator.ts` | Durable Job state machine with one private row-retirement implementation |
| `src/shapes.ts` | Shape mapping and cached catalog only; admission choreography does not leak from it |
| `src/createos.ts` | Narrow CreateOS capability types and production adapter construction |
| `src/github/client.ts` | GitHub transport implementing `GitHubAdapter` |
| `test/helpers/adapters.ts` | Default GitHub/CreateOS test adapters; tests override only exercised behavior |

## Cross-plan interfaces

Plan 1 produces:

```ts
export interface JobCandidate {
  jobId: number;
  runId: number;
  repoFullName: string;
  labels: string[];
}

export interface AdmissionDeps {
  isForkJob(repoFullName: string, runId: number): Promise<boolean>;
  loadCatalog(): Promise<Catalog>;
}

export function identifyJob(candidate: JobCandidate, config: Config): IdentifiedJob;
export function createJobAdmission(
  config: Config,
  deps: AdmissionDeps,
): (candidate: JobCandidate) => Promise<AdmissionDecision>;
```

Plan 2 produces one private Coordinator implementation and intentionally no new public interface:

```ts
#retireRow(row: Row, sandboxId?: string | null): TeardownTask | null;
```

Plan 3 produces:

```ts
export interface ControllerDeps {
  github?: GitHubAdapter;
  createos?: CreateosClient;
  attemptId?: () => string;
}

export interface ControllerRuntime {
  env: Bindings;
  config: Config;
  coordinator: DurableObjectStub<Coordinator>;
  github: GitHubAdapter;
  createos: CreateosClient;
  attemptId: () => string;
}

export function createControllerRuntime(
  env: Bindings,
  deps?: ControllerDeps,
): ControllerRuntime;
```

Plan 4 produces:

```ts
export interface LifecycleEffects {
  toDestroy: TeardownTask[];
  nextPending: PendingJob[];
}

export type LifecycleMode = "teardown-first" | "parallel";

export function provisionAndRecord(runtime: ControllerRuntime, job: PendingJob): Promise<void>;
export function executeLifecycleEffects(
  runtime: ControllerRuntime,
  effects: LifecycleEffects,
  mode: LifecycleMode,
): Promise<void>;
```

Plan 5 produces:

```ts
export interface ReclamationAdapter<T> {
  kind: "runner" | "sandbox";
  limit: number;
  list(): Promise<readonly T[]>;
  classify(resource: T): { jobId: number; label: string } | null;
  remove(resource: T): Promise<void>;
}

export function reclaimOrphans<T>(
  adapter: ReclamationAdapter<T>,
  liveJobIds: () => Promise<number[]>,
): Promise<ReclamationSummary>;
```

## Roadmap gates

### Gate 0: Validate the leak-hardening baseline

- [ ] **Step 1: Confirm the baseline commit is present**

```bash
rtk git merge-base --is-ancestor 03575a8 HEAD
rtk git status --short
```

Expected: the ancestry check exits 0 and the execution worktree is clean before Plan 1 starts.

- [ ] **Step 2: Validate the existing work before refactoring**

```bash
rtk bun run lint
rtk bun run typecheck
rtk bun run test
```

Expected: all three commands exit 0 with no new warnings.

- [ ] **Step 3: Create the execution worktree from the validated baseline**

Use the `using-git-worktrees` skill at execution time. The worktree branch must contain `03575a8`; the six plan documents may be committed separately as documentation before implementation begins.

### Gate 1: Review after every plan

- [ ] **Step 1: Confirm the plan's commits are atomic**

```bash
rtk git log --oneline --decorate -8
rtk git status --short
```

Expected: the completed plan's commits contain only its named files and the working tree has no accidental edits.

- [ ] **Step 2: Run the repository definition of done**

```bash
rtk bun run lint
rtk bun run typecheck
rtk bun run test
```

Expected: all commands exit 0.

- [ ] **Step 3: Review the diff against the plan**

```bash
rtk git diff HEAD~1 --stat
rtk git diff HEAD~1
```

Expected: no unrelated refactor, new dependency, silent bound, or network I/O inside `src/coordinator.ts`.

### Gate 2: Production merge and rollback readiness

- [ ] **Step 1: Capture the active production version before merge**

```bash
rtk bunx wrangler@latest deployments list
```

Expected: record the active version id in the merge checklist. If rollback is required, pass that exact recorded id as the final argument to `rtk bunx wrangler@latest rollback`.

- [ ] **Step 2: Confirm rollback safety**

Expected: Plans 1, 3, 4, and 5 make code-only changes. Plan 2 changes no schema. Existing additive columns remain readable by the previous Worker version.

- [ ] **Step 3: Merge through the normal repository flow**

Do not run `wrangler deploy`; merging to `main` is the deployment.

- [ ] **Step 4: Trigger and watch the smoke workflow**

```bash
rtk gh workflow run ghar-test.yml
rtk gh run list --workflow ghar-test.yml --limit 1
rtk gh run watch "$(rtk gh run list --workflow ghar-test.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: the workflow is green, one `ghar-<jobId>` Sandbox boots, and the Sandbox disappears after the Job completes.

- [ ] **Step 5: Roll back first if smoke fails**

Run `rtk bunx wrangler@latest rollback` with the exact active version id recorded in Step 1 as its final argument.

Expected: the previous Worker version becomes active; diagnose only after production is restored.
