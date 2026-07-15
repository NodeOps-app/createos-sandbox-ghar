# Orphan Reclamation Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace copied Orphaned runner-registration and Orphaned Sandbox sweeps with one deep, bounded reclamation module while preserving each resource's ownership proof.

**Architecture:** `src/reclamation.ts` accepts one of two real adapters. The module always lists external resources before reading `Coordinator.liveJobIds()`, applies the shared missing-row safety oracle, enforces a loud per-tick bound, runs cleanup with `Promise.allSettled`, and reports a summary. Runner and Sandbox adapters retain their distinct status checks, name parsers, labels, and removal operations.

**Tech Stack:** TypeScript 6.0.3, Bun, Cloudflare Workers + Durable Objects, Vitest 3.2.4, `@cloudflare/vitest-pool-workers` 0.8.71, oxlint, oxfmt.

## Global Constraints

- Execute after the runtime adapter and Worker lifecycle plans.
- **Implement, then test — no TDD.** Extract production behavior first, then add contract and destructive-path tests.
- Prefix every shell command and command-chain segment with `rtk`.
- External list must happen before the live-Job read for each adapter. Do not share one stale `liveJobIds` snapshot across both resources.
- A Runner is eligible only when offline, not busy, its name parses as ours, and its Job has no Coordinator row.
- A Sandbox is eligible only when not destroyed/failed, its exact name round-trips through our mint/parser, and its Job has no Coordinator row.
- A booting Runner or Sandbox always has a Coordinator row and must never be removed.
- Keep `MAX_RUNNER_DELETES_PER_TICK = 10` and `MAX_SANDBOX_DESTROYS_PER_TICK = 5`.
- No silent bounds. When a batch truncates, warn with kind, limit, collected count, attempted count, and dropped count.
- **Preserve the disabled-sandbox-sweep warning.** When `sandboxNamesAreSweepable(config)` is false the current `sweepOrphanedSandboxes` logs a loud `sandbox sweep: DISABLED — …` and refuses the sweep. The classifier alone keeps the *safety* (it yields no orphans) but drops that signal; the sandbox adapter's `list()` MUST re-emit the identical warning and return `[]`, or an unsafe prefix silently reclaims nothing — the exact failure this rule exists to prevent.
- Keep reclamation late in the Reconciler: Runner registrations after admission, Sandboxes last and independent of GitHub availability.
- No new dependency, config, schema, or Durable Object network I/O.
- Run `rtk oxfmt --write` on every changed TypeScript file.
- Conventional Commits, imperative subject, at most 50 characters.
- This plan changes destructive runtime code. Capture rollback state before merge and require the post-deploy `ghar-test` smoke.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/reclamation.ts` | create | Shared orphan proof, bound, cleanup execution, result accounting, and two adapters |
| `src/handler.ts` | modify | Keep Reconciler ordering; call reclamation instead of owning sweep snippets |
| `test/unit/reclamation.test.ts` | create | Generic module contract, resource classifiers, cap warning, and failures |
| `test/integration/reconcile.test.ts` | modify | Exercise non-empty Orphaned Sandbox deletion and booting-Sandbox protection |
| `CONTEXT.md` | modify | Define Orphan reclamation across both external resource kinds |

---

### Task 1: Create deep orphan reclamation and both adapters

**Files:**
- Create: `src/reclamation.ts`

**Interfaces:**
- Consumes: `Config`, `Runner`, `GitHubAdapter`, `CreateosClient`, `jobIdFromRunnerName`, `jobIdFromSandboxName`.
- Produces:
  - `ReclamationAdapter<T>`
  - `ReclamationSummary`
  - `reclaimOrphans(adapter, liveJobIds)`
  - `runnerReclamationAdapter(github, runners)`
  - `sandboxReclamationAdapter(config, createos)`

- [ ] **Step 1: Create `src/reclamation.ts`**

```ts
import type { CreateosClient, ListedSandbox } from "./createos";
import type { GitHubAdapter } from "./runtime";
import { jobIdFromRunnerName, jobIdFromSandboxName, sandboxNamesAreSweepable } from "./sandbox";
import type { Config, Runner } from "./types";

export interface ReclamationAdapter<T> {
  kind: "runner" | "sandbox";
  limit: number;
  list(): Promise<readonly T[]>;
  classify(resource: T): { jobId: number; label: string } | null;
  remove(resource: T): Promise<void>;
}

export interface ReclamationSummary {
  collected: number;
  orphaned: number;
  attempted: number;
  succeeded: number;
  failed: number;
  dropped: number;
}

export async function reclaimOrphans<T>(
  adapter: ReclamationAdapter<T>,
  liveJobIds: () => Promise<number[]>,
): Promise<ReclamationSummary> {
  // Ordering is load-bearing: onQueued can add a row after this list, and that
  // new row then protects any resource minted during the sweep.
  const resources = await adapter.list();
  const live = new Set(await liveJobIds());
  const orphans: { resource: T; jobId: number; label: string }[] = [];

  for (const resource of resources) {
    const candidate = adapter.classify(resource);
    if (candidate && !live.has(candidate.jobId)) {
      orphans.push({ resource, ...candidate });
    }
  }

  const batch = orphans.slice(0, adapter.limit);
  const dropped = orphans.length - batch.length;
  if (dropped > 0) {
    console.warn(
      `${adapter.kind} sweep: limit=${adapter.limit} bound; collected=${resources.length} ` +
        `orphaned=${orphans.length} attempted=${batch.length} dropped=${dropped}`,
    );
  }

  const results = await Promise.allSettled(
    batch.map(({ resource }) => adapter.remove(resource)),
  );
  let failed = 0;
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failed += 1;
      console.error(
        `${adapter.kind} sweep: cleanup failed resource=${batch[index]!.label}: ${String(result.reason)}`,
      );
    }
  });

  const summary: ReclamationSummary = {
    collected: resources.length,
    orphaned: orphans.length,
    attempted: batch.length,
    succeeded: batch.length - failed,
    failed,
    dropped,
  };
  if (batch.length > 0) {
    console.log(
      `${adapter.kind} sweep: succeeded=${summary.succeeded}/${summary.attempted} ` +
        `orphaned=${summary.orphaned} dropped=${summary.dropped}`,
    );
  }
  return summary;
}

const MAX_RUNNER_DELETES_PER_TICK = 10;
const MAX_SANDBOX_DESTROYS_PER_TICK = 5;

export function runnerReclamationAdapter(
  github: Pick<GitHubAdapter, "deleteRunner">,
  runners: readonly Runner[],
): ReclamationAdapter<Runner> {
  return {
    kind: "runner",
    limit: MAX_RUNNER_DELETES_PER_TICK,
    list: async () => runners,
    classify: (runner) => {
      if (runner.status !== "offline" || runner.busy) return null;
      const jobId = jobIdFromRunnerName(runner.name);
      return jobId === null ? null : { jobId, label: runner.name };
    },
    remove: (runner) => github.deleteRunner(runner.id),
  };
}

export function sandboxReclamationAdapter(
  config: Config,
  createos: Pick<CreateosClient, "listSandboxes">,
): ReclamationAdapter<ListedSandbox> {
  return {
    kind: "sandbox",
    limit: MAX_SANDBOX_DESTROYS_PER_TICK,
    // A prefix long enough to truncate a minted name makes ownership unprovable.
    // The classifier is already safe (`jobIdFromSandboxName` returns null), so
    // nothing would be destroyed — but silence is the bug: the operator must be
    // told the sweep is off, or a leaked VM is never reclaimed AND never
    // explained. Warn once per tick and yield no candidates, exactly as the
    // pre-refactor `sweepOrphanedSandboxes` did before its early return. This is
    // the one place the reclamation refactor must NOT let the warning disappear.
    list: async () => {
      if (!sandboxNamesAreSweepable(config)) {
        console.warn(
          `sandbox sweep: DISABLED — SANDBOX_NAME_PREFIX="${config.sandboxNamePrefix}" is long enough ` +
            `that createos truncates the VM name, so a VM's job id cannot be proven. Leaked VMs will ` +
            `NOT be reclaimed until the prefix is shortened.`,
        );
        return [];
      }
      return createos.listSandboxes();
    },
    classify: (sandbox) => {
      if (sandbox.status === "destroyed" || sandbox.status === "failed" || !sandbox.name) {
        return null;
      }
      const jobId = jobIdFromSandboxName(sandbox.name, config);
      return jobId === null ? null : { jobId, label: sandbox.name };
    },
    remove: (sandbox) => sandbox.destroy().then(() => undefined),
  };
}
```

- [ ] **Step 2: Format and typecheck the module**

```bash
rtk oxfmt --write src/reclamation.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: typecheck and lint exit 0; no other file changes yet.

#### Integration phase: Replace copied Reconciler sweeps

**Files:**
- Modify: `src/handler.ts:260-380, 505-525`

**Interfaces:**
- Consumes: reclamation factories and `reclaimOrphans` from Task 1.
- Produces: Reconciler C/D call sites with existing ordering and fail-safe catches.

- [ ] **Step 1: Replace reclamation imports in `src/handler.ts`**

Remove imports of `jobIdFromRunnerName`, `jobIdFromSandboxName`, and the two per-tick constants. Add:

```ts
import {
  reclaimOrphans,
  runnerReclamationAdapter,
  sandboxReclamationAdapter,
} from "./reclamation";
```

- [ ] **Step 2: Delete copied sweep implementations**

Delete `sweepOrphanedRunners` and `sweepOrphanedSandboxes` in full. Do not move their comments into `handler.ts`; the load-bearing ownership and ordering comments now live in `src/reclamation.ts`.

- [ ] **Step 3: Replace Reconciler step C**

Keep it after queued-Job admission and use:

```ts
  if (runners) {
    try {
      await reclaimOrphans(
        runnerReclamationAdapter(github, runners),
        () => co.liveJobIds(),
      );
    } catch (err) {
      console.error(`reconcile: orphaned-runner sweep failed: ${String(err)}`);
    }
  }
```

- [ ] **Step 4: Replace Reconciler step D**

Keep it last and independent of the GitHub reads:

```ts
  try {
    await reclaimOrphans(
      sandboxReclamationAdapter(config, runtime.createos),
      () => co.liveJobIds(),
    );
  } catch (err) {
    console.error(`reconcile: orphaned-sandbox sweep failed: ${String(err)}`);
  }
```

- [ ] **Step 5: Confirm the duplicated executor is gone**

```bash
rtk proxy rg -n "orphans\.slice|Promise\.allSettled\(batch|liveJobIds\(\)" src/handler.ts src/reclamation.ts
```

Expected: slice, bounded execution, and per-resource live reads exist only in `src/reclamation.ts`; `handler.ts` contains two callback call sites.

- [ ] **Step 6: Format and run existing Reconciler tests**

```bash
rtk oxfmt --write src/handler.ts
rtk bun run test test/integration/reconcile.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: existing Runner-registration sweep behavior passes; typecheck and lint exit 0.

- [ ] **Step 7: Commit the extraction**

```bash
rtk git add src/reclamation.ts src/handler.ts
rtk git commit -m "refactor: deepen orphan reclamation"
```

### Task 2: Add the generic reclamation contract

**Files:**
- Create: `test/unit/reclamation.test.ts`

**Interfaces:**
- Consumes: `ReclamationAdapter`, `reclaimOrphans`.
- Produces: deterministic coverage for ordering, live protection, bounds, and failures.

- [ ] **Step 1: Create `test/unit/reclamation.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  reclaimOrphans,
  type ReclamationAdapter,
} from "../../src/reclamation";

interface Resource {
  id: number;
  jobId: number | null;
}

function adapter(
  resources: Resource[],
  remove: (resource: Resource) => Promise<void>,
  limit = 10,
  calls: string[] = [],
): ReclamationAdapter<Resource> {
  return {
    kind: "runner",
    limit,
    list: async () => {
      calls.push("list");
      return resources;
    },
    classify: (resource) =>
      resource.jobId === null
        ? null
        : { jobId: resource.jobId, label: `resource-${resource.id}` },
    remove,
  };
}

describe("reclaimOrphans", () => {
  it("lists externally before reading live Job ids", async () => {
    const calls: string[] = [];
    await reclaimOrphans(
      adapter([{ id: 1, jobId: 1 }], vi.fn().mockResolvedValue(undefined), 10, calls),
      async () => {
        calls.push("live");
        return [];
      },
    );
    expect(calls.slice(0, 2)).toEqual(["list", "live"]);
  });

  it("protects live Jobs and ignores unowned resources", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const summary = await reclaimOrphans(
      adapter(
        [
          { id: 1, jobId: 10 },
          { id: 2, jobId: 11 },
          { id: 3, jobId: null },
        ],
        remove,
      ),
      async () => [10],
    );

    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith({ id: 2, jobId: 11 });
    expect(summary).toMatchObject({ collected: 3, orphaned: 1, attempted: 1, succeeded: 1 });
  });

  it("warns with counts when the bound binds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const summary = await reclaimOrphans(
      adapter(
        [
          { id: 1, jobId: 1 },
          { id: 2, jobId: 2 },
          { id: 3, jobId: 3 },
        ],
        remove,
        2,
      ),
      async () => [],
    );

    expect(remove).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ orphaned: 3, attempted: 2, dropped: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/limit=2.*collected=3.*dropped=1/));
    warn.mockRestore();
  });

  it("continues after an individual cleanup failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const remove = vi.fn(async (resource: Resource) => {
      if (resource.id === 1) throw new Error("delete failed");
    });
    const summary = await reclaimOrphans(
      adapter(
        [
          { id: 1, jobId: 1 },
          { id: 2, jobId: 2 },
        ],
        remove,
      ),
      async () => [],
    );

    expect(remove).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ attempted: 2, succeeded: 1, failed: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("resource-1"));
    error.mockRestore();
  });
});
```

- [ ] **Step 2: Add resource-specific classifier cases**

Extend the file's import block, define `baseConfig` before the first `describe`, then append the two classifier tests:

```ts
import { loadConfig } from "../../src/config";
import {
  runnerReclamationAdapter,
  sandboxReclamationAdapter,
} from "../../src/reclamation";

const baseConfig = loadConfig({
  GITHUB_ORG: "nodeops-app",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "key",
  GITHUB_INSTALLATION_ID: "2",
  GITHUB_WEBHOOK_SECRET: "secret",
  CREATEOS_BASE_URL: "https://createos.test",
  CREATEOS_API_KEY: "token",
  RUNNER_TEMPLATE: "ghar-runner",
  RUNNER_LABEL: "createos",
  RUNNER_SHAPE: "s-4vcpu-4gb",
});

it("classifies only offline, idle, owned Runner names", () => {
  const github = { deleteRunner: vi.fn().mockResolvedValue(undefined) };
  const resources = [
    { id: 1, name: "cos-100-aa", status: "offline", busy: false },
    { id: 2, name: "cos-101-aa", status: "online", busy: false },
    { id: 3, name: "cos-102-aa", status: "offline", busy: true },
    { id: 4, name: "arc-runner", status: "offline", busy: false },
  ];
  const built = runnerReclamationAdapter(github, resources);
  expect(resources.map((resource) => built.classify(resource))).toEqual([
    { jobId: 100, label: "cos-100-aa" },
    null,
    null,
    null,
  ]);
});

it("classifies only active, exactly-owned Sandbox names", () => {
  const destroy = vi.fn().mockResolvedValue({ id: "x", status: "destroying" });
  const config = { ...baseConfig, sandboxNamePrefix: "gha-ci" };
  const resources = [
    { id: "1", name: "gha-ci-200", status: "running", destroy },
    { id: "2", name: "gha-ci-201", status: "destroyed", destroy },
    { id: "3", name: "staging-db-202", status: "running", destroy },
  ];
  const built = sandboxReclamationAdapter(config, {
    listSandboxes: vi.fn().mockResolvedValue(resources),
  });
  expect(resources.map((resource) => built.classify(resource))).toEqual([
    { jobId: 200, label: "gha-ci-200" },
    null,
    null,
  ]);
});

it("warns and lists nothing when the prefix makes names unsweepable", () => {
  // A prefix long enough to truncate a minted name (clampSandboxName caps at 22)
  // makes ownership unprovable. The sweep must refuse AND say so — the pre-refactor
  // `sweepOrphanedSandboxes` logged `sandbox sweep: DISABLED`; the adapter's list()
  // must keep doing so, never silently reclaim nothing.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const listSandboxes = vi.fn().mockResolvedValue([]);
  const config = { ...baseConfig, sandboxNamePrefix: "gha-ci-nodeops-app" };
  const built = sandboxReclamationAdapter(config, { listSandboxes });
  return built.list().then((listed) => {
    expect(listed).toEqual([]);
    expect(listSandboxes).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sandbox sweep: DISABLED/));
    warn.mockRestore();
  });
});
```

- [ ] **Step 3: Format and run the contract**

```bash
rtk oxfmt --write test/unit/reclamation.test.ts
rtk bun run test test/unit/reclamation.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: ordering, safety, cap warning, failure continuation, and both classifiers pass.

- [ ] **Step 4: Commit the reclamation contract**

```bash
rtk git add test/unit/reclamation.test.ts
rtk git commit -m "test: cover orphan reclamation"
```

### Task 3: Cover non-empty Orphaned Sandbox destruction

**Files:**
- Modify: `test/integration/reconcile.test.ts`

**Interfaces:**
- Consumes: `runReconciler`, runtime adapter helpers, Sandbox ownership naming.
- Produces: regression coverage for a real destructive candidate and a booting-resource exclusion.

- [ ] **Step 1: Add Orphaned Sandbox deletion coverage**

```ts
it("destroys an owned Sandbox whose Job row is absent", async () => {
  const destroy = vi.fn().mockResolvedValue({ id: "orphan", status: "destroying" });
  const orphan = {
    id: "orphan",
    name: "cos-980-aa",
    status: "running",
    destroy,
  };
  await runReconciler(
    env as any,
    controllerDeps({
      github: githubAdapter({
        listRunners: vi.fn().mockResolvedValue([]),
        listQueuedJobs: vi.fn().mockResolvedValue([]),
      }),
      createos: createosAdapter({
        listSandboxes: vi.fn().mockResolvedValue([orphan]),
      }),
    }),
  );

  expect(destroy).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Add booting Sandbox protection**

```ts
it("does not destroy an owned Sandbox while its Job row is live", async () => {
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
  await coordinator.onQueued(
    { jobId: 981, runId: 981, repoFullName: "nodeops-app/api", label: "createos" },
    "booting-sandbox-981",
  );
  const destroy = vi.fn().mockResolvedValue({ id: "booting", status: "destroying" });
  const booting = {
    id: "booting",
    name: "cos-981-aa",
    status: "running",
    destroy,
  };

  await runReconciler(
    env as any,
    controllerDeps({
      github: githubAdapter({
        listRunners: vi.fn().mockResolvedValue([]),
        listQueuedJobs: vi.fn().mockResolvedValue([]),
      }),
      createos: createosAdapter({
        listSandboxes: vi.fn().mockResolvedValue([booting]),
      }),
    }),
  );

  expect(destroy).not.toHaveBeenCalled();
  await coordinator.markProvisionFailed(981);
});
```

- [ ] **Step 3: Format and run destructive-path tests**

```bash
rtk oxfmt --write test/integration/reconcile.test.ts
rtk bun run test test/unit/reclamation.test.ts test/integration/reconcile.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: the true orphan is destroyed once, the booting Sandbox is protected, and all existing Runner-registration cases remain green.

- [ ] **Step 4: Commit the destructive-path coverage**

```bash
rtk git add test/integration/reconcile.test.ts
rtk git commit -m "test: cover sandbox reclamation"
```

### Task 4: Document and fully verify reclamation

**Files:**
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: canonical Orphan reclamation vocabulary and verified destructive behavior.

- [ ] **Step 1: Add Orphan reclamation to `CONTEXT.md`**

Insert after **Orphaned runner registration**:

```md
- **Orphan reclamation** — the Reconciler's shared, bounded cleanup rule for Orphaned runner registrations and unowned Sandboxes. Each external adapter lists first, then the module reads `Coordinator.liveJobIds()` so a booting resource's row protects it. Resource-specific status and exact ownership-name parsing stay in their adapters; missing-row proof, loud per-tick bounds, failure accounting, and summaries are shared.
```

- [ ] **Step 2: Run the full repository checks**

```bash
rtk bun run lint
rtk bun run typecheck
rtk bun run test
rtk git diff --check
```

Expected: all commands exit 0 with no new warnings.

- [ ] **Step 3: Audit destructive ownership checks**

```bash
rtk proxy rg -n "jobIdFromRunnerName|jobIdFromSandboxName|liveJobIds|limit=|sandboxNamesAreSweepable|sandbox sweep: DISABLED" src/reclamation.ts test/unit/reclamation.test.ts test/integration/reconcile.test.ts
```

Expected: both exact parsers, per-adapter live reads, and loud-bound assertions are visible — AND `sandboxNamesAreSweepable` gates the sandbox adapter's `list()` with the loud `sandbox sweep: DISABLED` warning, covered by its own test. If that warning is absent, the refactor has silently dropped the disabled-sweep signal (the regression this plan explicitly guards) and must not ship.

- [ ] **Step 4: Commit the glossary entry**

```bash
rtk git add CONTEXT.md
rtk git commit -m "docs: define orphan reclamation"
```

- [ ] **Step 5: Re-verify the shipped sweep guards still fail on mutation**

This plan moved the sandbox orphan filter out of `handler.ts` into `src/reclamation.ts` and rewrote the Reconciler sandbox tests. The shipped mid-boot-sweep guard (a live job's row must protect its VM) now lives in `reclaimOrphans`'s `!live.has(candidate.jobId)` check, and the disabled-sweep warning now lives in the sandbox adapter's `list()`. Re-run both mutations at their new sites:

```bash
# 1. Mid-boot sweep guard: in src/reclamation.ts drop the `!live.has(candidate.jobId)`
#    half of the orphan filter (classify-only) → the "does not destroy an owned
#    Sandbox while its Job row is live" test must fail.
# 2. Disabled-sweep warning: delete the sandboxNamesAreSweepable guard from the
#    sandbox adapter's list() → the unsweepable-prefix test must fail.
# Revert both after confirming.
```

Expected: each mutation fails exactly its named test; reverting restores green. If the booting-protection or disabled-warning test stays green, the refactor dropped a guard and must be repaired before shipping.

- [ ] **Step 6: Prepare rollback and smoke**

```bash
rtk bunx wrangler@latest deployments list
rtk gh workflow view ghar-test.yml
```

Expected: active version recorded. After merge-to-main deploy, run `ghar-test`, require green, and confirm the `ghar-<jobId>` Sandbox is gone; inspect logs for reclamation failures before closing the rollout.
