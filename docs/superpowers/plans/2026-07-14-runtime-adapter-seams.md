# Runtime Adapter Seams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble Config, Coordinator, GitHub, CreateOS, and attempt-token capabilities once per Worker invocation so production modules and tests consume stable adapters instead of constructing clients or repeating four-method fakes.

**Architecture:** `src/runtime.ts` becomes the composition root for invocation-scoped dependencies. It exposes structural `GitHubAdapter`, `ControllerDeps`, and `ControllerRuntime` interfaces; `handler.ts` creates one runtime per webhook/cron entry and threads it through recursive work, preserving one GitHub token cache and one CreateOS adapter. CreateOS functions accept the capability they use directly, and `test/helpers/adapters.ts` supplies one default adapter per external system.

**Tech Stack:** TypeScript 6.0.3, Bun, Cloudflare Workers + Durable Objects, `@nodeops-createos/sandbox` 0.6.1, Vitest 3.2.4, oxlint, oxfmt.

## Global Constraints

- Execute after the Job admission and Coordinator retirement plans.
- **Implement, then test — no TDD.** Change production interfaces first, then migrate tests.
- Prefix every shell command and command-chain segment with `rtk`.
- Bind real GitHub/CreateOS fetch at construction; never pass unbound `fetch` as a method.
- Keep all external I/O in the Worker. `src/coordinator.ts` is not modified.
- The real GitHub client and test GitHub adapter are two adapters behind one structural seam; the real CreateOS SDK client and test CreateOS adapter are the second real seam.
- Default test adapters return empty lists for reads and throw on unexpected mutations; tests override only behavior they exercise.
- Preserve the Shape catalog's module cache and one-catalog-per-admission-factory behavior.
- Preserve JIT runner-name length, Sandbox ownership naming, runner launch order, and idempotent NotFound teardown.
- No new dependency or configuration variable.
- Run `rtk oxfmt --write` on every changed TypeScript file.
- Conventional Commits, imperative subject, at most 50 characters.
- This plan changes provisioning/teardown. Capture rollback state before merge and require the post-deploy `ghar-test` smoke.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/runtime.ts` | create | Invocation-scoped composition root and adapter interfaces |
| `src/createos.ts` | modify | Production CreateOS adapter construction; remove `SandboxDeps` |
| `src/sandbox.ts` | modify | Consume `CreateosClient`, `GitHubAdapter`, and attempt-token function directly |
| `src/shapes.ts` | modify | Consume `CreateosClient` directly for catalog reads |
| `src/handler.ts` | modify | Construct one runtime at each entry and pass it through all work |
| `src/admission.ts` | unchanged | Continue consuming callable admission dependencies |
| `test/helpers/adapters.ts` | create | Default GitHub/CreateOS adapters with narrow overrides |
| `test/unit/runtime.test.ts` | create | Runtime identity and default-construction tests |
| `test/unit/{sandbox,shapes}.test.ts` | modify | Use direct CreateOS adapters |
| `test/integration/{provision,reaper,reconcile,shapes}.test.ts` | modify | Replace repeated `makeClient` objects and handler-global fetch mutation |

---

### Task 1: Add the invocation-scoped runtime

**Files:**
- Create: `src/runtime.ts`
- Test: `test/unit/runtime.test.ts`

**Interfaces:**
- Consumes: `Bindings`, `Coordinator`, `Config`, `GitHubClient`, `CreateosClient`, `makeSandboxClient`.
- Produces:
  - `GitHubAdapter`
  - `ControllerDeps`
  - `ControllerRuntime`
  - `createControllerRuntime(env, deps?)`

- [ ] **Step 1: Create `src/runtime.ts` without disturbing the old seam**

```ts
import { loadConfig } from "./config";
import type { Coordinator } from "./coordinator";
import { makeSandboxClient, type CreateosClient } from "./createos";
import { GitHubClient } from "./github/client";
import type { Bindings } from "./index";
import type { Config, QueuedJob, Runner } from "./types";

export interface GitHubAdapter {
  generateJitConfig(runnerName: string, label: string): Promise<string>;
  isForkJob(repoFullName: string, runId: number): Promise<boolean>;
  listRunners(): Promise<Runner[]>;
  deleteRunner(id: number): Promise<void>;
  listQueuedJobs(): Promise<QueuedJob[]>;
}

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

const randomAttemptId = (): string =>
  Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0");

export function createControllerRuntime(
  env: Bindings,
  deps: ControllerDeps = {},
): ControllerRuntime {
  const config = loadConfig(env as Record<string, unknown>);
  return {
    env,
    config,
    coordinator: env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton")),
    github: deps.github ?? new GitHubClient(config),
    createos: deps.createos ?? makeSandboxClient(config, {}),
    attemptId: deps.attemptId ?? randomAttemptId,
  };
}
```

`DurableObjectStub` is provided globally by the repository's `@cloudflare/workers-types` TypeScript configuration; do not import it from a runtime module.

- [ ] **Step 2: Add `test/unit/runtime.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { CreateosClient } from "../../src/createos";
import {
  createControllerRuntime,
  type GitHubAdapter,
} from "../../src/runtime";

const github = (): GitHubAdapter => ({
  generateJitConfig: vi.fn().mockResolvedValue("jit"),
  isForkJob: vi.fn().mockResolvedValue(false),
  listRunners: vi.fn().mockResolvedValue([]),
  deleteRunner: vi.fn().mockResolvedValue(undefined),
  listQueuedJobs: vi.fn().mockResolvedValue([]),
});

const createos = (): CreateosClient => ({
  createSandbox: vi.fn().mockRejectedValue(new Error("unexpected createSandbox")),
  getSandbox: vi.fn().mockRejectedValue(new Error("unexpected getSandbox")),
  listSandboxes: vi.fn().mockResolvedValue([]),
  listShapes: vi.fn().mockResolvedValue([]),
});

describe("createControllerRuntime", () => {
  it("preserves injected adapters and attempt source", () => {
    const injectedGitHub = github();
    const injectedCreateos = createos();
    const attemptId = vi.fn().mockReturnValue("k3");

    const runtime = createControllerRuntime(env as any, {
      github: injectedGitHub,
      createos: injectedCreateos,
      attemptId,
    });

    expect(runtime.github).toBe(injectedGitHub);
    expect(runtime.createos).toBe(injectedCreateos);
    expect(runtime.attemptId()).toBe("k3");
    expect(runtime.coordinator).toBeDefined();
    expect(runtime.config.githubOrg).toBe("nodeops-app");
  });

  it("reuses one adapter identity for the runtime lifetime", () => {
    const runtime = createControllerRuntime(env as any, {
      github: github(),
      createos: createos(),
    });

    expect(runtime.github).toBe(runtime.github);
    expect(runtime.createos).toBe(runtime.createos);
  });
});
```

- [ ] **Step 3: Format and verify the composition root**

```bash
rtk oxfmt --write src/runtime.ts test/unit/runtime.test.ts
rtk bun run test test/unit/runtime.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: runtime tests pass and the full project typechecks because the old `SandboxDeps` seam still exists during this task.

- [ ] **Step 4: Commit the composition root**

```bash
rtk git add src/runtime.ts test/unit/runtime.test.ts
rtk git commit -m "refactor: add controller runtime"
```

### Task 2: Make Sandbox and Shape modules consume direct capabilities

**Files:**
- Modify: `src/runtime.ts`
- Modify: `src/createos.ts:53-74`
- Modify: `src/sandbox.ts:1-186`
- Modify: `src/shapes.ts:1-140, 212-227`
- Test: `test/unit/sandbox.test.ts`
- Test: `test/unit/shapes.test.ts`

**Interfaces:**
- Consumes: `CreateosClient`, `GitHubAdapter`.
- Produces:
  - `createRunnerSandbox(config, github, job, createos, attemptId)`
  - `teardownSandbox(createos, sandboxId)`
  - `usableShapes(config, createos, nowMs?)`
  - `fetchCatalog(config, createos)`

- [ ] **Step 1: Remove the old CreateOS dependency bag**

In `src/createos.ts`, delete `SandboxDeps` and replace the factory with:

```ts
export function makeSandboxClient(config: Config): CreateosClient {
  return new CreateosSandboxClient({
    baseUrl: config.createosBaseUrl,
    apiKey: config.createosApiKey,
    fetch: globalThis.fetch.bind(globalThis),
  });
}
```

In `src/runtime.ts`, change the default CreateOS expression to:

```ts
createos: deps.createos ?? makeSandboxClient(config),
```

- [ ] **Step 2: Rewrite Sandbox imports and signatures**

At the head of `src/sandbox.ts`, use:

```ts
import { CreateosSandboxNotFoundError } from "@nodeops-createos/sandbox";
import type { CreateosClient, SandboxHandle } from "./createos";
import type { GitHubAdapter } from "./runtime";
import { shapeForLabel } from "./shapes";
import type { Config, PendingJob } from "./types";

export type { SandboxHandle };
```

Change `createRunnerSandbox` to:

```ts
export async function createRunnerSandbox(
  config: Config,
  github: Pick<GitHubAdapter, "generateJitConfig">,
  job: PendingJob,
  createos: CreateosClient,
  attemptId: () => string,
): Promise<{ sandboxId: string; runnerName: string; sandbox: SandboxHandle }> {
  const runnerName = runnerNameFor(job.jobId, attemptId());
  const jitConfig = await github.generateJitConfig(runnerName, job.label);
  const sandboxName = sandboxNameFor(job.jobId, runnerName, config);
  const sandbox = await createos.createSandbox({
    shape: shapeForLabel(job.label, config),
    rootfs: config.runnerTemplate,
    disk_mib: config.runnerDiskMib,
    name: sandboxName,
    egress: ["*"],
    envs: { JIT_CONFIG: jitConfig },
  });
  return { sandboxId: sandbox.id, runnerName, sandbox };
}
```

Change teardown to:

```ts
export async function teardownSandbox(
  createos: Pick<CreateosClient, "getSandbox">,
  sandboxId: string,
): Promise<void> {
  try {
    const handle = await createos.getSandbox(sandboxId);
    await handle.destroy();
  } catch (err) {
    if (err instanceof CreateosSandboxNotFoundError) return;
    throw err;
  }
}
```

Keep runner/Sandbox name minting and parsing plus `launchRunner` byte-for-byte unchanged.

- [ ] **Step 3: Rewrite Shape catalog capability parameters**

Replace the CreateOS import in `src/shapes.ts` with:

```ts
import type { CreateosClient } from "./createos";
```

Make these exact replacements in the existing implementation:

```ts
export async function usableShapes(
  config: Config,
  createos: Pick<CreateosClient, "listShapes">,
  nowMs: number = Date.now(),
): Promise<Set<string>> {
```

The opening brace replaces the old declaration opening; the existing cache body follows it unchanged.

Replace:

```ts
shapes = await makeSandboxClient(config, deps).listShapes();
```

with:

```ts
shapes = await createos.listShapes();
```

Replace the complete `fetchCatalog` function with:

```ts
export async function fetchCatalog(
  config: Config,
  createos: Pick<CreateosClient, "listShapes">,
): Promise<Catalog> {
  try {
    return { ok: true, usable: await usableShapes(config, createos) };
  } catch {
    return { ok: false };
  }
}
```

- [ ] **Step 4: Migrate direct unit tests**

In `test/unit/sandbox.test.ts`, replace each:

```ts
makeClient: () => ({ createSandbox, getSandbox, listShapes, listSandboxes })
```

with the direct object argument:

```ts
{
  createSandbox,
  getSandbox,
  listShapes: vi.fn().mockResolvedValue([]),
  listSandboxes: vi.fn().mockResolvedValue([]),
}
```

Pass `() => "k3"` as the fifth argument to deterministic create tests. Pass the direct adapter as the first argument to `teardownSandbox`.

In `test/unit/shapes.test.ts`, pass the direct CreateOS object to `usableShapes` and `fetchCatalog`; remove every `makeClient` nesting.

- [ ] **Step 5: Format and run direct capability tests**

```bash
rtk oxfmt --write src/runtime.ts src/createos.ts src/sandbox.ts src/shapes.ts test/unit/sandbox.test.ts test/unit/shapes.test.ts
rtk bun run test test/unit/sandbox.test.ts test/unit/shapes.test.ts
rtk bun run lint
```

Expected: Sandbox naming, JIT, launch, teardown, Shape cache, and catalog tests pass; lint exits 0. Do not commit yet: `handler.ts` still consumes the removed `SandboxDeps` interface until the orchestration phase immediately below.

#### Orchestration phase: Thread one runtime through Worker code

**Files:**
- Modify: `src/handler.ts`
- Modify: `src/index.ts` only if exported dependency types are referenced there

**Interfaces:**
- Consumes: `ControllerRuntime`, `ControllerDeps`, `createControllerRuntime`.
- Produces: `handleWebhook`, `runReconciler`, and `runReaper` retain their public env-based interface with `ControllerDeps` as the optional test seam.

- [ ] **Step 1: Replace handler construction imports**

Use:

```ts
import {
  createControllerRuntime,
  type ControllerDeps,
  type ControllerRuntime,
} from "./runtime";
```

Remove `loadConfig`, direct `GitHubClient`, `makeSandboxClient`, `SandboxDeps`, and the private `coordinator(env)` function from `src/handler.ts`.

- [ ] **Step 2: Convert provisioning and teardown helpers to runtime input**

Change their interfaces and first lines to:

```ts
async function provisionAndRecord(runtime: ControllerRuntime, job: PendingJob): Promise<void> {
  const { config, coordinator: co, github, createos, attemptId } = runtime;
  let sandboxId: string;
  let runnerName: string;
  let sandbox: Awaited<ReturnType<typeof createRunnerSandbox>>["sandbox"];
  try {
    ({ sandboxId, runnerName, sandbox } = await createRunnerSandbox(
      config,
      github,
      job,
      createos,
      attemptId,
    ));
  } catch (err) {
    await failProvision(runtime, job, err);
    return;
  }

  try {
    const decision = await co.recordSandboxCreated(job.jobId, sandboxId, runnerName);
    if (decision.action === "destroy") {
      await teardownSandbox(createos, sandboxId);
      return;
    }
    await launchRunner(sandbox);
    await co.markRunning(job.jobId);
  } catch (err) {
    await failProvision(runtime, job, err, sandboxId);
  }
}

async function failProvision(
  runtime: ControllerRuntime,
  job: PendingJob,
  err: unknown,
  sandboxId?: string,
): Promise<void> {
  console.error(`provision failed job=${job.jobId}: ${String(err)}`);
  await notify(
    runtime.config,
    `ghar provision failed — job ${job.jobId} (${job.repoFullName}): ${String(err)}`,
  );

  let result: ProvisionFailedResult;
  try {
    result = await runtime.coordinator.markProvisionFailed(job.jobId, sandboxId);
  } catch (doErr) {
    console.error(`markProvisionFailed unreachable job=${job.jobId}: ${String(doErr)}`);
    if (sandboxId) await destroyUnrecorded(runtime, job.jobId, sandboxId);
    return;
  }

  if (result.toDestroy) await destroyAndConfirm(runtime, result.toDestroy);
  if (result.nextPending) await provisionAndRecord(runtime, result.nextPending);
}

async function destroyUnrecorded(
  runtime: ControllerRuntime,
  jobId: number,
  sandboxId: string,
): Promise<void> {
  try {
    await teardownSandbox(runtime.createos, sandboxId);
  } catch (err) {
    console.error(
      `unrecorded teardown failed sandbox=${sandboxId} job=${jobId}: ${String(err)}`,
    );
    await notify(
      runtime.config,
      `ghar VM leaked — sandbox ${sandboxId} (job ${jobId}) has no Coordinator row and could not be destroyed: ${String(err)}. The orphaned-sandbox sweep will retry.`,
    );
  }
}

async function destroyAndConfirm(
  runtime: ControllerRuntime,
  task: { jobId: number; sandboxId: string },
): Promise<void> {
  try {
    await teardownSandbox(runtime.createos, task.sandboxId);
    await runtime.coordinator.markDestroyed(task.jobId);
  } catch (err) {
    console.error(
      `teardown failed sandbox=${task.sandboxId} job=${task.jobId}: ${String(err)}`,
    );
    await notify(
      runtime.config,
      `ghar teardown failed — sandbox ${task.sandboxId} (job ${task.jobId}): ${String(err)}`,
    );
  }
}
```

Import `ProvisionFailedResult` from `src/types.ts` and retain the existing comments that explain record-before-launch and the unrecorded-VM backstop.

- [ ] **Step 3: Construct runtime once in each public entry**

Change `handleWebhook`'s fourth parameter from `SandboxDeps` to `ControllerDeps`. Replace its initial Config construction and later Coordinator/GitHub construction with:

```ts
const runtime = createControllerRuntime(env, deps);
const { config, coordinator: co, github, createos } = runtime;
```

Replace every webhook-path call exactly as follows:

```ts
provisionAndRecord(env, admission.job, deps)
// becomes
provisionAndRecord(runtime, admission.job)

destroyAndConfirm(env, config, result.toDestroy, deps)
// becomes
destroyAndConfirm(runtime, result.toDestroy)
```

Replace `runReaper` in full with:

```ts

export async function runReaper(
  env: Bindings,
  deps: ControllerDeps = {},
): Promise<void> {
  const runtime = createControllerRuntime(env, deps);
  const { toDestroy, nextPending } = await runtime.coordinator.sweep(
    Date.now(),
    runtime.config.reaperMaxAgeMs,
  );
  await Promise.allSettled([
    ...toDestroy.map((task) => destroyAndConfirm(runtime, task)),
    ...nextPending.map((job) => provisionAndRecord(runtime, job)),
  ]);
}
```

Replace `runReconciler`'s initial Config/GitHub/Coordinator construction with:

```ts
export async function runReconciler(
  env: Bindings,
  deps: ControllerDeps = {},
): Promise<void> {
  const runtime = createControllerRuntime(env, deps);
  const { config, coordinator: co, github, createos } = runtime;
```

Keep its A/B/C/D ordering and replace mapped calls as follows:

```ts
destroyAndConfirm(env, config, task, deps)
// becomes
destroyAndConfirm(runtime, task)

provisionAndRecord(env, job, deps)
// becomes
provisionAndRecord(runtime, job)
```

Admission factories use:

```ts
const admit = createJobAdmission(config, {
  isForkJob: (repoFullName, runId) => github.isForkJob(repoFullName, runId),
  loadCatalog: () => fetchCatalog(config, createos),
});
```

Orphaned Sandbox listing uses `createos.listSandboxes()`. Every recursive or mapped provision/destroy call receives the same `runtime` object.

- [ ] **Step 4: Confirm client construction disappeared from orchestration**

```bash
rtk proxy rg -n "new GitHubClient|makeSandboxClient|loadConfig\(" src/handler.ts
```

Expected: no matches.

#### Test-migration phase: Add default adapters and remove repeated fakes

**Files:**
- Create: `test/helpers/adapters.ts`
- Modify: `test/integration/provision.test.ts`
- Modify: `test/integration/reaper.test.ts`
- Modify: `test/integration/reconcile.test.ts`
- Modify: `test/integration/shapes.test.ts`
- Modify: `test/unit/sandbox.test.ts`
- Modify: `test/unit/shapes.test.ts`

**Interfaces:**
- Consumes: `GitHubAdapter`, `CreateosClient`, `ControllerDeps`.
- Produces: `githubAdapter(overrides?)`, `createosAdapter(overrides?)`, `controllerDeps(overrides?)`.

- [ ] **Step 1: Create `test/helpers/adapters.ts`**

```ts
import { vi } from "vitest";
import type { CreateosClient } from "../../src/createos";
import type { ControllerDeps, GitHubAdapter } from "../../src/runtime";

const unexpected = (operation: string): never => {
  throw new Error(`unexpected adapter call: ${operation}`);
};

export function githubAdapter(overrides: Partial<GitHubAdapter> = {}): GitHubAdapter {
  return {
    generateJitConfig: vi.fn(async () => unexpected("generateJitConfig")),
    isForkJob: vi.fn().mockResolvedValue(true),
    listRunners: vi.fn().mockResolvedValue([]),
    deleteRunner: vi.fn(async () => unexpected("deleteRunner")),
    listQueuedJobs: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

export function createosAdapter(
  overrides: Partial<CreateosClient> = {},
): CreateosClient {
  return {
    createSandbox: vi.fn(async () => unexpected("createSandbox")),
    getSandbox: vi.fn(async () => unexpected("getSandbox")),
    listSandboxes: vi.fn().mockResolvedValue([]),
    listShapes: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

export function controllerDeps(
  overrides: ControllerDeps = {},
): ControllerDeps {
  return {
    github: githubAdapter(),
    createos: createosAdapter(),
    attemptId: () => "aa",
    ...overrides,
  };
}
```

- [ ] **Step 2: Replace CreateOS boilerplate mechanically**

For a provisioning test, replace a four-method fake with:

```ts
const createos = createosAdapter({ createSandbox });
const deps = controllerDeps({
  createos,
  github: githubAdapter({
    generateJitConfig: vi.fn().mockResolvedValue("ENCODED_JIT_BLOB"),
  }),
  attemptId: () => "k3",
});
```

For Shape tests, use:

```ts
const deps = controllerDeps({
  createos: createosAdapter({ listShapes }),
});
```

For teardown tests, use:

```ts
const deps = controllerDeps({
  createos: createosAdapter({
    getSandbox: vi.fn().mockResolvedValue({ destroy }),
  }),
});
```

Delete every unused `getSandbox: vi.fn()`, `listShapes: vi.fn()`, and `listSandboxes: vi.fn().mockResolvedValue([])` supplied only to satisfy the old interface.

- [ ] **Step 3: Stop handler tests from replacing global fetch**

In provisioning, Shape-flow, Reconciler, and Reaper tests, inject `githubAdapter` methods directly. Retain `mockFetch` only in `test/unit/client.test.ts` and `test/unit/auth.test.ts`, where the GitHub transport itself is under test.

Use direct queued-job data:

```ts
const github = githubAdapter({
  listRunners: vi.fn().mockResolvedValue([]),
  listQueuedJobs: vi.fn().mockResolvedValue([
    {
      jobId: 801,
      runId: 901,
      repoFullName: "nodeops-app/api",
      labels: ["createos"],
    },
  ]),
  generateJitConfig: vi.fn().mockResolvedValue("ENCODED_JIT_BLOB"),
});
```

- [ ] **Step 4: Prove a new CreateOS method no longer ripples**

```bash
rtk proxy rg -n "makeClient:|listSandboxes: vi\.fn\(\).*mockResolvedValue\(\[\]\)" test
```

Expected: no `makeClient` matches; the only default empty `listSandboxes` implementation is in `test/helpers/adapters.ts`.

- [ ] **Step 5: Format and run all affected tests**

```bash
rtk oxfmt --write src/runtime.ts src/createos.ts src/sandbox.ts src/shapes.ts src/handler.ts test/helpers/adapters.ts test/unit/runtime.test.ts test/unit/sandbox.test.ts test/unit/shapes.test.ts test/integration/provision.test.ts test/integration/reaper.test.ts test/integration/reconcile.test.ts test/integration/shapes.test.ts
rtk bun run test test/unit/runtime.test.ts test/unit/sandbox.test.ts test/unit/shapes.test.ts test/integration/provision.test.ts test/integration/reaper.test.ts test/integration/reconcile.test.ts test/integration/shapes.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: all affected tests pass; typecheck and lint exit 0.

- [ ] **Step 6: Commit runtime threading and test-adapter migration atomically**

```bash
rtk git add src/runtime.ts src/createos.ts src/sandbox.ts src/shapes.ts src/handler.ts test/helpers/adapters.ts test/unit/sandbox.test.ts test/unit/shapes.test.ts test/integration/provision.test.ts test/integration/reaper.test.ts test/integration/reconcile.test.ts test/integration/shapes.test.ts
rtk git commit -m "refactor: thread controller runtime"
```

### Task 3: Complete verification and smoke preparation

**Files:**
- Modify: none.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: verified invocation-scoped adapters and reusable test fakes.

- [ ] **Step 1: Run the full repository checks**

```bash
rtk bun run lint
rtk bun run typecheck
rtk bun run test
rtk git diff --check
```

Expected: all commands exit 0 with no new warnings.

- [ ] **Step 2: Confirm the intended construction locality**

```bash
rtk proxy rg -n "new GitHubClient|new CreateosSandboxClient" src
rtk proxy rg -n "globalThis\.fetch\s*=" test
```

Expected: production constructors appear only in `src/runtime.ts`/`src/createos.ts`; global fetch assignment remains only in transport-specific unit tests if still required.

- [ ] **Step 3: Re-verify the shipped leak/age fixes still fail on mutation**

The test migration rewrote `provision.test.ts`, `reconcile.test.ts`, and `reaper.test.ts` — the suites that guard the shipped VM-leak, mid-boot-sweep, and age-from-provisioning fixes. A green suite after a test rewrite proves the tests RUN, not that they still CATCH the bug. Reintroduce each bug at its current site, confirm ONLY the named test(s) fail, then revert. This plan changes no logic, so the sites are unmoved.

```bash
# 1. VM-leak guard (4 tests, provision.test.ts): in src/coordinator.ts make
#    markProvisionFailed's destroying-row branch unreachable → those 4 must fail.
# 2. Age-from-provisioning (2 "spares" tests, reaper.test.ts): change ROW_AGE
#    COALESCE(provision_started_at, created_at) → created_at → those 2 must fail.
# 3. Mid-boot sweep (1 test, reconcile.test.ts): in src/handler.ts change the
#    sandbox sweep filter `jobId !== null && !live.has(jobId)` → `jobId !== null`.
# Revert all three after confirming. Do NOT proceed to smoke until each was seen
# to fail its guard and the tree is restored green.
```

Expected: each mutation fails exactly its named guard test(s); reverting restores a green suite. If any mutation leaves the suite green, the migrated test no longer guards the fix and must be repaired before shipping.

- [ ] **Step 4: Prepare rollback and smoke**

```bash
rtk bunx wrangler@latest deployments list
rtk gh workflow view ghar-test.yml
```

Expected: active version recorded. After merge-to-main deploy, run `ghar-test`, require green, and confirm the `ghar-<jobId>` Sandbox is gone.
