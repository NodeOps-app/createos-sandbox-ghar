# Worker Lifecycle Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move provisioning, provision-failure disposal, teardown confirmation, and promoted-Job execution out of `handler.ts` into one deep Worker lifecycle module.

**Architecture:** All Coordinator transitions that release capacity return one array-based `LifecycleEffects` interface. `src/lifecycle.ts` owns create-record-launch, durable failure disposal, destroy-confirm, and the explicit difference between webhook-style teardown-first execution and cron-style parallel execution. `handler.ts` keeps intake ordering and translates each Coordinator result into one lifecycle call.

**Tech Stack:** TypeScript 6.0.3, Bun, Cloudflare Workers + Durable Objects, Vitest 3.2.4, `@cloudflare/vitest-pool-workers` 0.8.71, oxlint, oxfmt.

## Global Constraints

- Execute after the runtime adapter plan; this plan consumes `ControllerRuntime` and direct CreateOS/GitHub adapters.
- **Implement, then test — no TDD.** Complete the interface migration, then add ordering tests.
- Prefix every shell command and command-chain segment with `rtk`.
- The Coordinator stays passive. `src/lifecycle.ts` performs all network I/O.
- Preserve record-before-launch: a Sandbox must be recorded by Runner identity before `launchRunner` runs.
- Preserve durable Destroying rows and confirmation only after idempotent teardown succeeds.
- Preserve the unrecorded-VM fallback and Orphaned Sandbox sweep alert text.
- Preserve current execution semantics: completion/provision-failure are teardown-first; Reaper and Reconciler bulk effects are parallel.
- No new dependency, environment variable, SQLite migration, cap, or silent early exit.
- Run `rtk oxfmt --write` on every changed TypeScript file.
- Conventional Commits, imperative subject, at most 50 characters.
- This plan changes provisioning/teardown. Capture rollback state before merge and require the post-deploy `ghar-test` smoke.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/lifecycle.ts` | create | Provisioning, failure disposal, teardown confirmation, and effect scheduling |
| `src/types.ts` | modify | Replace three overlapping result types with `LifecycleEffects` |
| `src/coordinator.ts` | modify | Return array-based lifecycle effects from every capacity-releasing transition |
| `src/handler.ts` | modify | Delete lifecycle implementation and call the deep module |
| `test/integration/lifecycle.test.ts` | create | Verify teardown-first versus parallel execution and durable confirmation |
| `test/integration/{provision,reaper,reconcile,teardown,retirement}.test.ts` | modify | Expect arrays from the unified interface |
| `CONTEXT.md` | modify | Define lifecycle effects as the Worker half of a Coordinator transition |

---

### Task 1: Unify Coordinator results and extract lifecycle execution

**Files:**
- Create: `src/lifecycle.ts`
- Modify: `src/types.ts:90-123`
- Modify: `src/coordinator.ts`
- Modify: `src/handler.ts`

**Interfaces:**
- Consumes: `ControllerRuntime`, `PendingJob`, `TeardownTask`, Sandbox functions, Coordinator methods.
- Produces:
  - `LifecycleEffects { toDestroy: TeardownTask[]; nextPending: PendingJob[] }`
  - `LifecycleMode = "teardown-first" | "parallel"`
  - `provisionAndRecord(runtime, job)`
  - `executeLifecycleEffects(runtime, effects, mode)`

- [ ] **Step 1: Replace overlapping result types in `src/types.ts`**

Delete `ProvisionFailedResult`, `CompletedResult`, and `ReapResult`. Add:

```ts
/**
 * Coordinator → Worker effects after a transition releases capacity. Arrays
 * cover single completion/failure and bulk Reaper/Reconciler transitions with
 * one interface.
 */
export interface LifecycleEffects {
  toDestroy: TeardownTask[];
  nextPending: PendingJob[];
}
```

- [ ] **Step 2: Change Coordinator imports and result types**

Import `LifecycleEffects` in `src/coordinator.ts`. Change these return types:

```ts
async markProvisionFailed(jobId: number, sandboxId?: string): Promise<LifecycleEffects>;
async onCompleted(jobId: number, runnerName?: string): Promise<LifecycleEffects>;
async reapUnregistered(
  nowMs: number,
  onlineRunners: string[],
  graceMs: number,
): Promise<LifecycleEffects>;
async sweep(nowMs: number, maxAgeMs: number): Promise<LifecycleEffects>;
```

In `markProvisionFailed`, normalize the private values once:

```ts
    const nextPending = this.#dequeuePending();
    return {
      toDestroy: toDestroy ? [toDestroy] : [],
      nextPending: nextPending ? [nextPending] : [],
    };
```

In both `onCompleted` return sites use:

```ts
      const nextPending = this.#dequeuePending();
      return {
        toDestroy: [],
        nextPending: nextPending ? [nextPending] : [],
      };
```

and:

```ts
    const toDestroy = this.#retireRow(row);
    const nextPending = this.#dequeuePending();
    return {
      toDestroy: toDestroy ? [toDestroy] : [],
      nextPending: nextPending ? [nextPending] : [],
    };
```

`reapUnregistered` and `sweep` already build arrays; change only their declared result type and keep their returned object unchanged.

- [ ] **Step 3: Create `src/lifecycle.ts`**

```ts
import { notify } from "./notify";
import type { ControllerRuntime } from "./runtime";
import {
  createRunnerSandbox,
  launchRunner,
  teardownSandbox,
} from "./sandbox";
import type { LifecycleEffects, PendingJob, TeardownTask } from "./types";

export type LifecycleMode = "teardown-first" | "parallel";

export async function provisionAndRecord(
  runtime: ControllerRuntime,
  job: PendingJob,
): Promise<void> {
  const { config, coordinator, github, createos, attemptId } = runtime;
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
    const decision = await coordinator.recordSandboxCreated(
      job.jobId,
      sandboxId,
      runnerName,
    );
    if (decision.action === "destroy") {
      await teardownSandbox(createos, sandboxId);
      return;
    }
    await launchRunner(sandbox);
    await coordinator.markRunning(job.jobId);
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

  let effects: LifecycleEffects;
  try {
    effects = await runtime.coordinator.markProvisionFailed(job.jobId, sandboxId);
  } catch (doErr) {
    console.error(`markProvisionFailed unreachable job=${job.jobId}: ${String(doErr)}`);
    if (sandboxId) await destroyUnrecorded(runtime, job.jobId, sandboxId);
    return;
  }
  await executeLifecycleEffects(runtime, effects, "teardown-first");
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
  task: TeardownTask,
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

export async function executeLifecycleEffects(
  runtime: ControllerRuntime,
  effects: LifecycleEffects,
  mode: LifecycleMode,
): Promise<void> {
  const destroy = (): Promise<PromiseSettledResult<void>[]> =>
    Promise.allSettled(effects.toDestroy.map((task) => destroyAndConfirm(runtime, task)));
  const provision = (): Promise<PromiseSettledResult<void>[]> =>
    Promise.allSettled(effects.nextPending.map((job) => provisionAndRecord(runtime, job)));

  if (mode === "teardown-first") {
    await destroy();
    await provision();
    return;
  }
  await Promise.all([destroy(), provision()]);
}
```

- [ ] **Step 4: Remove lifecycle implementation from `src/handler.ts`**

Delete `provisionAndRecord`, `failProvision`, `destroyUnrecorded`, and `destroyAndConfirm`. Remove now-unused imports of `createRunnerSandbox`, `launchRunner`, `teardownSandbox`, `notify`, and lifecycle result types. Add:

```ts
import { executeLifecycleEffects, provisionAndRecord } from "./lifecycle";
```

- [ ] **Step 5: Replace handler effect snippets**

Queued provision remains:

```ts
ctx.waitUntil(provisionAndRecord(runtime, admission.job));
```

Completed handling becomes:

```ts
const effects = await co.onCompleted(job.jobId, job.runnerName);
ctx.waitUntil(executeLifecycleEffects(runtime, effects, "teardown-first"));
```

`runReaper` becomes:

```ts
const effects = await runtime.coordinator.sweep(
  Date.now(),
  runtime.config.reaperMaxAgeMs,
);
await executeLifecycleEffects(runtime, effects, "parallel");
```

Reconciler step A becomes:

```ts
const effects = await co.reapUnregistered(
  Date.now(),
  online,
  config.reconcileGraceMs,
);
await executeLifecycleEffects(runtime, effects, "parallel");
```

The Reconciler admission loop still collects newly admitted Jobs and calls:

```ts
await Promise.allSettled(toProvision.map((job) => provisionAndRecord(runtime, job)));
```

- [ ] **Step 6: Update scalar result expectations**

Change tests from:

```ts
expect(result.toDestroy).toEqual({ jobId, sandboxId });
expect(result.nextPending).toEqual(job);
```

to:

```ts
expect(result.toDestroy).toEqual([{ jobId, sandboxId }]);
expect(result.nextPending).toEqual([job]);
```

Change optional property access such as `result.toDestroy?.sandboxId` to `result.toDestroy[0]?.sandboxId`, and `toBeNull()` assertions to `toEqual([])`.

- [ ] **Step 7: Format and run the migrated lifecycle suites**

```bash
rtk oxfmt --write src/types.ts src/coordinator.ts src/lifecycle.ts src/handler.ts test/integration/provision.test.ts test/integration/reaper.test.ts test/integration/reconcile.test.ts test/integration/teardown.test.ts test/integration/retirement.test.ts
rtk bun run test test/integration/provision.test.ts test/integration/reaper.test.ts test/integration/reconcile.test.ts test/integration/teardown.test.ts test/integration/retirement.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: all migrated suites pass; typecheck and lint exit 0.

- [ ] **Step 8: Commit the deep lifecycle module**

```bash
rtk git add src/types.ts src/coordinator.ts src/lifecycle.ts src/handler.ts test/integration/provision.test.ts test/integration/reaper.test.ts test/integration/reconcile.test.ts test/integration/teardown.test.ts test/integration/retirement.test.ts
rtk git commit -m "refactor: deepen worker lifecycle"
```

### Task 2: Verify lifecycle scheduling semantics

**Files:**
- Create: `test/integration/lifecycle.test.ts`

**Interfaces:**
- Consumes: `createControllerRuntime`, adapter test helpers, `executeLifecycleEffects`.
- Produces: regression coverage for teardown-first and parallel modes.

- [ ] **Step 1: Create `test/integration/lifecycle.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { executeLifecycleEffects } from "../../src/lifecycle";
import { createControllerRuntime } from "../../src/runtime";
import { createosAdapter, githubAdapter } from "../helpers/adapters";
import { runnerName } from "../helpers/mocks";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function effectsFor(jobId: number, sandboxId: string) {
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
  await coordinator.onQueued(
    { jobId, runId: jobId, repoFullName: "nodeops-app/api", label: "createos" },
    `lifecycle-destroy-${jobId}`,
  );
  await coordinator.recordSandboxCreated(jobId, sandboxId, runnerName(jobId));
  await coordinator.markRunning(jobId);
  return coordinator.onCompleted(jobId, runnerName(jobId));
}

describe("executeLifecycleEffects", () => {
  it("waits for teardown before provisioning in teardown-first mode", async () => {
    const gate = deferred();
    const destroy = vi.fn(async () => gate.promise);
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb-next-970",
      runCommand: vi.fn().mockResolvedValue({ exit_code: 0 }),
    });
    const runtime = createControllerRuntime(env as any, {
      github: githubAdapter({
        generateJitConfig: vi.fn().mockResolvedValue("jit"),
      }),
      createos: createosAdapter({
        getSandbox: vi.fn().mockResolvedValue({ destroy }),
        createSandbox,
      }),
      attemptId: () => "aa",
    });
    const effects = await effectsFor(970, "sb-970");
    const next = {
      jobId: 971,
      runId: 971,
      repoFullName: "nodeops-app/api",
      label: "createos",
    };
    await runtime.coordinator.onQueued(next, "lifecycle-next-971");

    const running = executeLifecycleEffects(
      runtime,
      { ...effects, nextPending: [next] },
      "teardown-first",
    );
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    expect(createSandbox).not.toHaveBeenCalled();

    gate.resolve();
    await running;
    expect(createSandbox).toHaveBeenCalledOnce();
  });

  it("starts teardown and provisioning together in parallel mode", async () => {
    const gate = deferred();
    const destroy = vi.fn(async () => gate.promise);
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb-next-972",
      runCommand: vi.fn().mockResolvedValue({ exit_code: 0 }),
    });
    const runtime = createControllerRuntime(env as any, {
      github: githubAdapter({
        generateJitConfig: vi.fn().mockResolvedValue("jit"),
      }),
      createos: createosAdapter({
        getSandbox: vi.fn().mockResolvedValue({ destroy }),
        createSandbox,
      }),
      attemptId: () => "aa",
    });
    const effects = await effectsFor(972, "sb-972");
    const next = {
      jobId: 973,
      runId: 973,
      repoFullName: "nodeops-app/api",
      label: "createos",
    };
    await runtime.coordinator.onQueued(next, "lifecycle-next-973");

    const running = executeLifecycleEffects(
      runtime,
      { ...effects, nextPending: [next] },
      "parallel",
    );
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(createSandbox).toHaveBeenCalledOnce());

    gate.resolve();
    await running;
  });
});
```

- [ ] **Step 2: Format and run lifecycle scheduling tests**

```bash
rtk oxfmt --write test/integration/lifecycle.test.ts
rtk bun run test test/integration/lifecycle.test.ts test/integration/provision.test.ts test/integration/reaper.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: teardown-first blocks provisioning until destroy settles; parallel starts both; all existing lifecycle tests pass.

- [ ] **Step 3: Commit lifecycle scheduling coverage**

```bash
rtk git add test/integration/lifecycle.test.ts
rtk git commit -m "test: cover lifecycle scheduling"
```

### Task 3: Document and fully verify the lifecycle seam

**Files:**
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: canonical lifecycle-effect vocabulary and a verified runtime path.

- [ ] **Step 1: Add Lifecycle effects to `CONTEXT.md`**

Insert near **Destroying**:

```md
- **Lifecycle effects** — the Worker work returned by a capacity-releasing Coordinator transition: Sandbox teardowns to execute and Pending Jobs to provision. The lifecycle module owns create-record-launch, destroy-confirm, provision-failure disposal, and scheduling. Completion and provision failure are teardown-first; Reaper/Reconciler bulk effects run in parallel. The Coordinator only persists state and returns effects.
```

- [ ] **Step 2: Run full verification**

```bash
rtk bun run lint
rtk bun run typecheck
rtk bun run test
rtk git diff --check
rtk proxy rg -n "function (failProvision|destroyAndConfirm|destroyUnrecorded)|async function provisionAndRecord" src/handler.ts
```

Expected: checks exit 0 and the final search has no matches.

- [ ] **Step 3: Commit the glossary entry**

```bash
rtk git add CONTEXT.md
rtk git commit -m "docs: define lifecycle effects"
```

- [ ] **Step 4: Re-verify the shipped leak/age fixes still fail on mutation**

Task 1 rewrote the assertions in `provision.test.ts`, `reaper.test.ts`, `reconcile.test.ts`, `teardown.test.ts`, and `retirement.test.ts` from scalar to array shape — the suites guarding the shipped VM-leak and age-from-provisioning fixes. An array assertion that passes proves the shape changed, not that the guard still bites. Re-run the mutations against the new array assertions:

```bash
# 1. VM-leak guard: in src/coordinator.ts make markProvisionFailed's destroying-row
#    branch unreachable → the 4 leak tests (now asserting toDestroy: [ … ]) must fail.
# 2. Age-from-provisioning: change ROW_AGE COALESCE(provision_started_at, created_at)
#    → created_at → the 2 reaper "spares" tests must fail.
# Revert both after confirming. The mid-boot sandbox-sweep filter is not touched by
# this plan (it moves in orphan reclamation); re-verify that guard there.
```

Expected: each mutation fails exactly its named guard test(s) under the new array assertions; reverting restores green. A mutation that leaves the suite green means the shape rewrite dropped the guard — repair before shipping.

- [ ] **Step 5: Prepare rollback and smoke**

```bash
rtk bunx wrangler@latest deployments list
rtk gh workflow view ghar-test.yml
```

Expected: active version recorded. After merge-to-main deploy, run `ghar-test`, require green, and confirm the Sandbox is destroyed.
