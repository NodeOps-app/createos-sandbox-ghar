# Shape-Selectable Runner Labels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workflow pick its runner VM size via `runs-on: [createos-2vcpu-2gb]`, with the shape catalog discovered from the createos API so a newly-added shape needs no controller redeploy.

**Architecture:** A new `src/shapes.ts` owns label↔shape mapping and a 5-minute cached fetch of `GET /v1/shapes`, filtered by a memory floor. The label a job requested is persisted on its `jobs` row so a queued-at-cap job boots at the size it asked for, and the JIT runner registers under exactly that one label so GitHub's AND-matching keeps each shape's runner pool separate. The catalog is consulted only when admitting a `queued` job — never on teardown.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects (SQLite), `@nodeops-createos/sandbox` SDK, vitest + `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-07-09-shape-labels-design.md`

## Global Constraints

- **NO TDD.** This repo is implement-then-test (`CLAUDE.md`). Write the code, then the tests, then commit. Do not write a failing test first.
- **bun only.** Never npm/npx/node. Pin exact with `bun add -E`.
- **Do NOT upgrade** `@cloudflare/vitest-pool-workers` past `0.8.71` or `vitest` past `3.2.4`.
- **Do not casually reinstall deps.** The SDK is `bun link`'d to sibling `../fc-sdk`.
- **Never call `fetch` as a method** (`obj.fetch(...)`) — Workers throws `Illegal invocation`. Bind at the seam.
- **No silent bounds.** Every cap, guard, or early-exit that actually binds must `console.warn` with the bound, the identifier, and what was dropped.
- **CF Free plan is a hard constraint** (`docs/adr/0002`): the DO stays `new_sqlite_classes` and passive. All blocking network I/O (including the shapes fetch) happens in the Worker, never in the DO.
- **oxlint + oxfmt** on every `.ts` change: `node_modules/.bin/oxlint src test`.
- **Conventional Commits**, imperative subject ≤ 50 chars, atomic.
- Self-documenting code; comment the *why*, not the *what*.
- Files stay under 1100 lines.

**Verification commands** (used at the end of every task):

```bash
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run
node_modules/.bin/oxlint src test
```

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/createos.ts` | **create** | Build the createos SDK client. Owns `SandboxDeps` (the test seam). Exists solely to break the `sandbox.ts` ↔ `shapes.ts` import cycle. |
| `src/shapes.ts` | **create** | Label ↔ shape mapping, the cached + floored shape catalog, and label admission. |
| `src/sandbox.ts` | modify | Drop the private client factory (moved). Derive shape from the job's label. Pass the label to JIT config. |
| `src/config.ts` | modify | Parse `MIN_RUNNER_MEM_MIB`. |
| `src/types.ts` | modify | `Config.minRunnerMemMib`; `PendingJob.label`. |
| `src/coordinator.ts` | modify | `label` column + migration; carry it through `onQueued` / `#dequeuePending`. |
| `src/github/client.ts` | modify | `generateJitConfig(name, label)`; `listQueuedJobs(usable)`. |
| `src/handler.ts` | modify | Admit by label; thread the label into `PendingJob`; reconciler uses the real label. |
| `src/webhook.ts` | modify | Delete `matchesLabel` (superseded). |
| `wrangler.toml` | modify | `MIN_RUNNER_MEM_MIB = "2048"`. |
| `test/unit/shapes.test.ts` | **create** | Pure mapping, floor, cache, fetch-failure. |
| `test/integration/shapes.test.ts` | **create** | Shaped webhook end-to-end; unknown label; teardown during a shapes outage. |
| `docs/adr/0004-shape-labels.md` | **create** | The label naming scheme + one-label-per-runner rule. |
| `CONTEXT.md`, `README.md`, `CLAUDE.md`, `.github/workflows/ghar-test.yml` | modify | Docs + smoke coverage. |

---

### Task 1: Extract the createos client factory

Pure refactor, no behavior change. `shapes.ts` (Task 2) needs an SDK client, and `sandbox.ts` will need `shapeForLabel` from `shapes.ts`. Importing each other is a cycle. Both will import `createos.ts` instead.

**Files:**
- Create: `src/createos.ts`
- Modify: `src/sandbox.ts:1-23` (remove the factory, re-export the type)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SandboxDeps { makeClient?: (config: Config) => CreateosSandboxClient; attemptId?: () => string }`
  - `function makeSandboxClient(config: Config, deps: SandboxDeps): CreateosSandboxClient`

- [ ] **Step 1: Create `src/createos.ts`**

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import type { Config } from "./types";

export interface SandboxDeps {
  /** Injection seam for tests. Defaults to a real client from config. */
  makeClient?: (config: Config) => CreateosSandboxClient;
  /** Injection seam for tests. 2-char token discriminating provision attempts. */
  attemptId?: () => string;
}

/**
 * The single place a createos SDK client is constructed. Lives apart from
 * sandbox.ts so shapes.ts can build a client without importing sandbox.ts,
 * which imports shapes.ts for shapeForLabel — a cycle otherwise.
 */
export function makeSandboxClient(config: Config, deps: SandboxDeps): CreateosSandboxClient {
  if (deps.makeClient) return deps.makeClient(config);
  return new CreateosSandboxClient({
    baseUrl: config.createosBaseUrl,
    apiKey: config.createosApiKey,
    // Workers rejects an unbound fetch called off the SDK's config object.
    fetch: globalThis.fetch.bind(globalThis),
  });
}
```

- [ ] **Step 2: Rewrite the head of `src/sandbox.ts`**

Replace lines 1–23 (the imports, the `SandboxDeps` interface, and the private `client` function) with:

```ts
import { CreateosSandboxNotFoundError } from "@nodeops-createos/sandbox";
import type { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import type { Config, PendingJob } from "./types";
import type { GitHubClient } from "./github/client";
import { makeSandboxClient, type SandboxDeps } from "./createos";

// Re-exported so existing consumers (handler.ts, index.ts, tests) keep importing
// SandboxDeps from here.
export type { SandboxDeps };

/** A booted sandbox handle — the subset createRunnerSandbox returns to launchRunner. */
export type SandboxHandle = Awaited<ReturnType<CreateosSandboxClient["createSandbox"]>>;
```

- [ ] **Step 3: Replace the two `client(config, deps)` call sites in `src/sandbox.ts`**

In `createRunnerSandbox`, change:

```ts
  const c = client(config, deps);
```

to:

```ts
  const c = makeSandboxClient(config, deps);
```

In `teardownSandbox`, change:

```ts
  const c = client(config, deps);
```

to:

```ts
  const c = makeSandboxClient(config, deps);
```

- [ ] **Step 4: Verify nothing changed**

```bash
node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run && node_modules/.bin/oxlint src test
```

Expected: typecheck clean, the full existing suite passes (63 tests), lint shows only the pre-existing warnings. This task adds no tests — it is a pure extraction, and the existing suite is its regression test.

- [ ] **Step 5: Commit**

```bash
git add src/createos.ts src/sandbox.ts
git commit -m "refactor(sandbox): extract createos client factory"
```

---

### Task 2: `src/shapes.ts` — catalog, floor, cache, label admission

**Files:**
- Modify: `src/types.ts:17` (add `minRunnerMemMib`), `src/types.ts:43-47` (add `PendingJob.label`)
- Modify: `src/config.ts:44` (parse `MIN_RUNNER_MEM_MIB`)
- Modify: `wrangler.toml`
- Create: `src/shapes.ts`
- Test: `test/unit/shapes.test.ts`

**Interfaces:**
- Consumes: `makeSandboxClient`, `SandboxDeps` from Task 1.
- Produces:
  - `function createosLabels(labels: string[], config: Config): string[]`
  - `function shapeForLabel(label: string, config: Config): string`
  - `function usableShapes(config: Config, deps: SandboxDeps, nowMs?: number): Promise<Set<string>>`
  - `function isUsableLabel(label: string, config: Config, deps: SandboxDeps): Promise<boolean>`
  - `function pickLabel(labels: string[], usable: Set<string>, config: Config): string | null`
  - `function resetShapeCacheForTests(): void`

Note `PendingJob.label` is added here (Task 2) but not *populated* until Task 4. Between the two tasks nothing constructs a `PendingJob` — Task 3 changes the DO, Task 4 changes the constructors — so add it as a required field and let `tsc` point at every site Task 3/4 must fix. That is the intent.

- [ ] **Step 1: Add `minRunnerMemMib` to `Config` and `label` to `PendingJob` in `src/types.ts`**

After the `runnerShape` line in `interface Config`:

```ts
  runnerShape: string; // "s-4vcpu-4gb" — the shape the bare `createos` label means
  minRunnerMemMib: number; // 2048 — shapes below this are never offered as labels
```

And replace `interface PendingJob`:

```ts
/** DO → Worker: a job to boot (returned by onCompleted/sweep when a slot frees). */
export interface PendingJob {
  jobId: number;
  runId: number;
  repoFullName: string;
  /**
   * The single createos label the job asked for ("createos", or a shaped
   * "createos-2vcpu-2gb"). Persisted on the row: a job that queues behind the
   * concurrency cap must boot at the size it requested, and its JIT runner must
   * register under exactly this label (see ADR-0004).
   */
  label: string;
}
```

- [ ] **Step 2: Parse `MIN_RUNNER_MEM_MIB` in `src/config.ts`**

After the `runnerShape` line in the returned object:

```ts
    runnerShape: (env.RUNNER_SHAPE as string) || "s-4vcpu-4gb",
    minRunnerMemMib: num(env, "MIN_RUNNER_MEM_MIB", 2048),
```

- [ ] **Step 3: Add the var to `wrangler.toml`**

Under `[vars]`, next to `RUNNER_SHAPE`:

```toml
# Shapes below this are discovered from /v1/shapes but never offered as runner
# labels: an Actions runner needs ~2 GiB to check out and build anything.
MIN_RUNNER_MEM_MIB = "2048"
```

- [ ] **Step 4: Create `src/shapes.ts`**

```ts
import type { Shape } from "@nodeops-createos/sandbox";
import type { Config } from "./types";
import { makeSandboxClient, type SandboxDeps } from "./createos";

const CACHE_TTL_MS = 300_000;

let cache: { fetchedAt: number; ids: Set<string> } | null = null;

/** Test-only: drops the module-level cache so cases don't leak into each other. */
export function resetShapeCacheForTests(): void {
  cache = null;
}

/**
 * The createos labels in a job's `runs-on`: the bare label plus anything
 * prefixed with it. GitHub AND-matches `runs-on` against a runner's label set,
 * so a job's other labels (`self-hosted`, `linux`, `x64`) are carried
 * implicitly by any JIT runner and are irrelevant to shape selection.
 */
export function createosLabels(labels: string[], config: Config): string[] {
  const prefix = `${config.runnerLabel}-`;
  return labels.filter((l) => l === config.runnerLabel || l.startsWith(prefix));
}

/**
 * The createos shape a label names. The bare label means whatever the operator
 * configured; a shaped label carries the id in its suffix. Pure — needs no
 * catalog, so teardown and re-provision never depend on the shapes API.
 */
export function shapeForLabel(label: string, config: Config): string {
  if (label === config.runnerLabel) return config.runnerShape;
  return `s-${label.slice(config.runnerLabel.length + 1)}`;
}

/**
 * Shape ids from the live createos catalog that can actually host an Actions
 * runner. Cached for CACHE_TTL_MS per isolate: a shape added to the API is
 * offered as a label on the next miss, with no redeploy.
 *
 * The floor is not a per-shape allowlist — it is two properties. A shape under
 * MIN_RUNNER_MEM_MIB cannot check out and build. A shape with `cpu_quota_pct`
 * is a throttled fraction of one CPU, not a vCPU, and a runner on it stalls.
 *
 * Blocking network I/O, so this belongs to the Worker; the DO must stay passive
 * to hibernate (ADR-0002).
 */
export async function usableShapes(
  config: Config,
  deps: SandboxDeps,
  nowMs: number = Date.now(),
): Promise<Set<string>> {
  if (cache && nowMs - cache.fetchedAt < CACHE_TTL_MS) return cache.ids;

  const shapes: Shape[] = await makeSandboxClient(config, deps).listShapes();
  const ids = new Set<string>();
  const excluded: string[] = [];
  for (const s of shapes) {
    if (s.mem_mib >= config.minRunnerMemMib && s.cpu_quota_pct == null) ids.add(s.id);
    else excluded.push(s.id);
  }
  if (excluded.length > 0) {
    console.warn(
      `shapes: ${excluded.length}/${shapes.length} below the runner floor ` +
        `(mem_mib < ${config.minRunnerMemMib} or cpu_quota_pct set), not offered as labels: ${excluded.join(", ")}`,
    );
  }
  cache = { fetchedAt: nowMs, ids };
  return ids;
}

/**
 * Admission check for one createos label. The bare label short-circuits: its
 * shape comes from config, so a shapes-API outage can never stop the jobs that
 * work today. A shaped label is checked against the live catalog; a fetch
 * failure denies it, and the cron reconciler re-drives the still-`queued` job
 * on its next tick.
 */
export async function isUsableLabel(
  label: string,
  config: Config,
  deps: SandboxDeps,
): Promise<boolean> {
  if (label === config.runnerLabel) return true;
  let usable: Set<string>;
  try {
    usable = await usableShapes(config, deps);
  } catch (err) {
    console.warn(`shapes: catalog fetch failed, denying shaped label ${label}: ${String(err)}`);
    return false;
  }
  return usableLabel(label, usable, config);
}

function usableLabel(label: string, usable: Set<string>, config: Config): boolean {
  const shape = shapeForLabel(label, config);
  if (usable.has(shape)) return true;
  console.warn(`shapes: label ${label} names shape ${shape}, which is not offered`);
  return false;
}

/**
 * The one createos label a job requested, validated against an already-fetched
 * catalog. Used where the catalog is fetched once for many jobs (the
 * reconciler). Returns null when the job is not ours, or when it names more
 * than one createos label — a contradiction with no defensible winner, which we
 * refuse rather than resolve by array order.
 */
export function pickLabel(labels: string[], usable: Set<string>, config: Config): string | null {
  const ours = createosLabels(labels, config);
  if (ours.length === 0) return null;
  if (ours.length > 1) {
    console.warn(`shapes: job names ${ours.length} createos labels (${ours.join(", ")}); ignoring it`);
    return null;
  }
  const label = ours[0]!;
  if (label === config.runnerLabel) return label;
  return usableLabel(label, usable, config) ? label : null;
}
```

- [ ] **Step 5: Write `test/unit/shapes.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "../../src/config";
import {
  createosLabels,
  shapeForLabel,
  usableShapes,
  isUsableLabel,
  pickLabel,
  resetShapeCacheForTests,
} from "../../src/shapes";
import type { Config } from "../../src/types";

const config: Config = loadConfig({
  GITHUB_ORG: "nodeops-app",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "pk",
  GITHUB_INSTALLATION_ID: "2",
  GITHUB_WEBHOOK_SECRET: "s",
  CREATEOS_BASE_URL: "https://api.sb.createos.sh",
  CREATEOS_API_KEY: "k",
  RUNNER_TEMPLATE: "ghar-runner",
});

const CATALOG = [
  { id: "s-0.25vcpu-512mb", vcpu: 1, mem_mib: 512, default_disk_mib: 10240, cpu_quota_pct: 25 },
  { id: "s-0.5vcpu-1gb", vcpu: 1, mem_mib: 1024, default_disk_mib: 10240, cpu_quota_pct: 50 },
  { id: "s-1vcpu-256mb", vcpu: 1, mem_mib: 256, default_disk_mib: 10240 },
  { id: "s-1vcpu-1gb", vcpu: 1, mem_mib: 1024, default_disk_mib: 10240 },
  { id: "s-2vcpu-2gb", vcpu: 2, mem_mib: 2048, default_disk_mib: 10240 },
  { id: "s-4vcpu-4gb", vcpu: 4, mem_mib: 4096, default_disk_mib: 10240 },
  { id: "s-8vcpu-16gb", vcpu: 8, mem_mib: 16384, default_disk_mib: 10240 },
];

function depsWith(listShapes: () => Promise<unknown>) {
  return { makeClient: () => ({ listShapes }) as never };
}

beforeEach(() => {
  resetShapeCacheForTests();
  vi.restoreAllMocks();
});

describe("createosLabels", () => {
  it("keeps the bare label and shaped labels, drops everything else", () => {
    expect(createosLabels(["self-hosted", "linux", "createos-2vcpu-2gb"], config)).toEqual([
      "createos-2vcpu-2gb",
    ]);
    expect(createosLabels(["createos"], config)).toEqual(["createos"]);
    expect(createosLabels(["ubuntu-latest"], config)).toEqual([]);
  });
});

describe("shapeForLabel", () => {
  it("maps the bare label to the configured default shape", () => {
    expect(shapeForLabel("createos", config)).toBe("s-4vcpu-4gb");
  });

  it("maps a shaped label to its shape id", () => {
    expect(shapeForLabel("createos-8vcpu-16gb", config)).toBe("s-8vcpu-16gb");
    expect(shapeForLabel("createos-2vcpu-2gb", config)).toBe("s-2vcpu-2gb");
  });
});

describe("usableShapes", () => {
  it("excludes shapes under the memory floor and throttled shapes, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = await usableShapes(config, depsWith(async () => CATALOG));
    expect([...ids].sort()).toEqual(["s-2vcpu-2gb", "s-4vcpu-4gb", "s-8vcpu-16gb"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("s-1vcpu-1gb");
    expect(warn.mock.calls[0]![0]).toContain("s-0.25vcpu-512mb");
  });

  it("serves the cache inside the TTL and refetches past it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listShapes = vi.fn(async () => CATALOG);
    await usableShapes(config, depsWith(listShapes), 1_000_000);
    await usableShapes(config, depsWith(listShapes), 1_000_000 + 299_999);
    expect(listShapes).toHaveBeenCalledTimes(1);
    await usableShapes(config, depsWith(listShapes), 1_000_000 + 300_000);
    expect(listShapes).toHaveBeenCalledTimes(2);
  });
});

describe("isUsableLabel", () => {
  it("admits the bare label without touching the catalog", async () => {
    const listShapes = vi.fn(async () => CATALOG);
    expect(await isUsableLabel("createos", config, depsWith(listShapes))).toBe(true);
    expect(listShapes).not.toHaveBeenCalled();
  });

  it("admits a shaped label present in the catalog", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await isUsableLabel("createos-2vcpu-2gb", config, depsWith(async () => CATALOG))).toBe(
      true,
    );
  });

  it("denies a shaped label that exists but is under the floor, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await isUsableLabel("createos-1vcpu-1gb", config, depsWith(async () => CATALOG))).toBe(
      false,
    );
    expect(warn.mock.calls.some((c) => String(c[0]).includes("not offered"))).toBe(true);
  });

  it("denies a shaped label when the catalog fetch fails, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = depsWith(async () => {
      throw new Error("503");
    });
    expect(await isUsableLabel("createos-2vcpu-2gb", config, boom)).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("catalog fetch failed"))).toBe(true);
  });

  it("still admits the bare label when the catalog fetch fails", async () => {
    const boom = depsWith(async () => {
      throw new Error("503");
    });
    expect(await isUsableLabel("createos", config, boom)).toBe(true);
  });
});

describe("pickLabel", () => {
  const usable = new Set(["s-2vcpu-2gb", "s-4vcpu-4gb"]);

  it("returns null for a job that is not ours", () => {
    expect(pickLabel(["ubuntu-latest"], usable, config)).toBeNull();
  });

  it("returns the single createos label, ignoring incidental labels", () => {
    expect(pickLabel(["self-hosted", "createos-2vcpu-2gb"], usable, config)).toBe(
      "createos-2vcpu-2gb",
    );
  });

  it("refuses two createos labels rather than picking by order, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(pickLabel(["createos", "createos-2vcpu-2gb"], usable, config)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("2 createos labels"))).toBe(true);
  });

  it("returns null for a shaped label absent from the catalog", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(pickLabel(["createos-99vcpu-1tb"], usable, config)).toBeNull();
  });
});
```

- [ ] **Step 6: Run the new tests**

```bash
node_modules/.bin/vitest run test/unit/shapes.test.ts
```

Expected: PASS. `tsc --noEmit` will still fail across `coordinator.ts` / `handler.ts` / `client.ts` because `PendingJob.label` is required and nothing populates it — that is expected and Tasks 3–4 fix it. Do not run the full suite yet.

- [ ] **Step 7: Commit**

```bash
git add src/shapes.ts src/types.ts src/config.ts wrangler.toml test/unit/shapes.test.ts
git commit -m "feat(shapes): add cached, floored shape catalog"
```

---

### Task 3: Persist the requested label on the job row

**Files:**
- Modify: `src/coordinator.ts:12-14` (Env), `:16-25` (Row), `:48-69` (schema + migration), `:109-130` (onQueued), `:212-223` (#dequeuePending)
- Test: `test/integration/concurrency.test.ts` (extend)

**Interfaces:**
- Consumes: `PendingJob.label` from Task 2.
- Produces: `PendingJob` values returned by `onQueued` / `#dequeuePending` / `#drainPending` now carry `label`.

The DO cannot call `loadConfig` (it only receives its own bindings), so it reads `RUNNER_LABEL` directly to backfill rows written before this migration. That var already exists in `wrangler.toml` and in `vitest.config.ts`'s miniflare bindings.

- [ ] **Step 1: Widen the DO's `Env` and `Row` in `src/coordinator.ts`**

```ts
interface Env {
  MAX_CONCURRENT: string;
  RUNNER_LABEL: string;
}

type Row = {
  job_id: number;
  run_id: number;
  repo: string;
  sandbox_id: string | null;
  runner_name: string | null;
  label: string | null;
  state: string;
  created_at: number;
  booted_at: number | null;
};
```

- [ ] **Step 2: Add the column to the schema and migrate existing DOs**

Replace the `CREATE TABLE IF NOT EXISTS jobs (...)` body and the migration block:

```ts
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id      INTEGER PRIMARY KEY,
        run_id      INTEGER NOT NULL,
        repo        TEXT NOT NULL,
        sandbox_id  TEXT,
        runner_name TEXT,
        label       TEXT,
        state       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        booted_at   INTEGER
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        seen_at     INTEGER NOT NULL
      );
    `);
    // Migrate DOs created before a column existed: CREATE TABLE IF NOT EXISTS
    // won't add one to a live table. A NULL `label` is a row from before shape
    // labels, which by definition asked for the bare label.
    const cols = this.#sql.exec(`PRAGMA table_info(jobs)`).toArray() as { name: string }[];
    const has = (c: string) => cols.some((col) => col.name === c);
    if (!has("runner_name")) this.#sql.exec(`ALTER TABLE jobs ADD COLUMN runner_name TEXT`);
    if (!has("label")) this.#sql.exec(`ALTER TABLE jobs ADD COLUMN label TEXT`);
```

- [ ] **Step 3: Add the default-label helper and a row→PendingJob mapper**

Insert after `#maxConcurrent()`:

```ts
  /** The label a pre-migration row implicitly asked for. */
  #defaultLabel(): string {
    return this.env.RUNNER_LABEL || "createos";
  }

  #toPending(row: Row): PendingJob {
    return {
      jobId: row.job_id,
      runId: row.run_id,
      repoFullName: row.repo,
      label: row.label ?? this.#defaultLabel(),
    };
  }
```

- [ ] **Step 4: Persist the label in `onQueued`**

```ts
    this.#sql.exec(
      `INSERT INTO jobs (job_id, run_id, repo, sandbox_id, runner_name, label, state, created_at, booted_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
      job.jobId,
      job.runId,
      job.repoFullName,
      job.label,
      state,
      now,
    );
```

- [ ] **Step 5: Return the label from `#dequeuePending`**

Replace its final two lines:

```ts
    this.#sql.exec(`UPDATE jobs SET state = 'provisioning' WHERE job_id = ?`, row.job_id);
    return this.#toPending(row);
```

- [ ] **Step 6: Extend `test/integration/concurrency.test.ts`**

Add this case. It is the regression test for the whole reason the column exists: a shaped job that waits behind the cap must boot at the size it asked for, not the default.

```ts
  it("a job queued at the cap dequeues with its label intact", async () => {
    const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));

    // MAX_CONCURRENT is 2 in vitest.config.ts — fill both slots.
    await co.onQueued({ jobId: 901, runId: 1, repoFullName: "o/r", label: "createos" }, "d-901");
    await co.onQueued({ jobId: 902, runId: 1, repoFullName: "o/r", label: "createos" }, "d-902");

    const third = await co.onQueued(
      { jobId: 903, runId: 1, repoFullName: "o/r", label: "createos-8vcpu-16gb" },
      "d-903",
    );
    expect(third.action).toBe("queued");

    // Free a slot; the promoted job must still carry its shaped label.
    const { nextPending } = await co.onCompleted(901);
    expect(nextPending?.jobId).toBe(903);
    expect(nextPending?.label).toBe("createos-8vcpu-16gb");
  });
```

- [ ] **Step 7: Run the DO tests**

```bash
node_modules/.bin/vitest run test/integration/concurrency.test.ts
```

Expected: PASS. Other suites still fail to typecheck until Task 4.

- [ ] **Step 8: Commit**

```bash
git add src/coordinator.ts test/integration/concurrency.test.ts
git commit -m "feat(coordinator): persist requested label on job rows"
```

---

### Task 4: Wire the label through admission, JIT, provisioning, and the reconciler

This is the task that makes the feature real, and it is where the existing suite goes green again.

**Files:**
- Modify: `src/webhook.ts:97-99` (delete `matchesLabel`)
- Modify: `src/github/client.ts:41-60` (`generateJitConfig`), `:142-150` (`listQueuedJobs`), `:176-192` (`#queuedLabelJobs`)
- Modify: `src/sandbox.ts` (`createRunnerSandbox`)
- Modify: `src/handler.ts:3` (imports), `:77-113` (admission), `:201-229` (reconciler)
- Test: `test/unit/webhook.test.ts`, `test/unit/sandbox.test.ts`, `test/unit/client.test.ts`, `test/integration/*.test.ts` (fixture updates)

**Interfaces:**
- Consumes: `createosLabels`, `shapeForLabel`, `isUsableLabel`, `pickLabel`, `usableShapes` (Task 2); `PendingJob.label` (Tasks 2–3).
- Produces:
  - `generateJitConfig(runnerName: string, label: string): Promise<string>`
  - `listQueuedJobs(usable: Set<string>): Promise<PendingJob[]>`

- [ ] **Step 1: Delete `matchesLabel` from `src/webhook.ts`**

Remove lines 97–99 entirely:

```ts
export function matchesLabel(job: WorkflowJob, label: string): boolean {
  return job.labels.includes(label);
}
```

Its job — "is this ours" — is now `createosLabels(...).length === 1`, which also has to reject ambiguity. Leaving both would let a caller pick the one that skips the ambiguity check.

- [ ] **Step 2: Register the requested label in `src/github/client.ts`**

```ts
  /**
   * Creates a JIT ephemeral org runner config; returns encoded_jit_config.
   *
   * The runner carries exactly the ONE label its job asked for. GitHub
   * AND-matches `runs-on` against a runner's labels, so a runner registered with
   * both `createos` and `createos-8vcpu-16gb` would be eligible for bare
   * `createos` jobs while sitting on an 8 vCPU VM. One label per runner keeps
   * each shape's pool disjoint (ADR-0004).
   */
  async generateJitConfig(runnerName: string, label: string): Promise<string> {
    const res = await this.fetchImpl(
      `${this.config.githubApiUrl}/orgs/${this.config.githubOrg}/actions/runners/generate-jitconfig`,
      {
        method: "POST",
        headers: await this.#headers(),
        body: JSON.stringify({
          name: runnerName,
          runner_group_id: 1,
          labels: [label],
          work_folder: "_work",
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`generate-jitconfig failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { encoded_jit_config: string };
    return body.encoded_jit_config;
  }
```

- [ ] **Step 3: Thread the catalog through `listQueuedJobs` in `src/github/client.ts`**

Add the import at the top of the file:

```ts
import { pickLabel } from "../shapes";
```

Then:

```ts
  /**
   * Every label-matching workflow_job GitHub still reports as `queued` — the
   * reconciler's source of truth for jobs needing a runner, independent of
   * whether we ever saw (or lost) their `queued` webhook. Scans the app's
   * installed repos; a partly-drained matrix run is `in_progress` with its
   * remaining jobs still `queued`, so both run statuses are inspected.
   *
   * `usable` is the shape catalog, fetched once per reconcile tick rather than
   * once per job.
   */
  async listQueuedJobs(usable: Set<string>): Promise<PendingJob[]> {
    const out: PendingJob[] = [];
    for (const repo of await this.#installationRepos()) {
      for (const runId of await this.#activeRunIds(repo)) {
        out.push(...(await this.#queuedLabelJobs(repo, runId, usable)));
      }
    }
    return out;
  }
```

and:

```ts
  async #queuedLabelJobs(
    repoFullName: string,
    runId: number,
    usable: Set<string>,
  ): Promise<PendingJob[]> {
    const jobs = await this.#getPaged<JobLite>(
      `/repos/${repoFullName}/actions/runs/${runId}/jobs?filter=latest`,
      "jobs",
    );
    const out: PendingJob[] = [];
    for (const j of jobs) {
      if (j.status !== "queued" || typeof j.id !== "number") continue;
      const label = pickLabel(j.labels ?? [], usable, this.config);
      if (label) out.push({ jobId: j.id, runId, repoFullName, label });
    }
    return out;
  }
```

- [ ] **Step 4: Derive the shape from the label in `src/sandbox.ts`**

Add to the imports:

```ts
import { shapeForLabel } from "./shapes";
```

In `createRunnerSandbox`, change the JIT call to pass the label:

```ts
  const runnerName = `ghar-${job.jobId}-${attemptId()}`;
  const jitConfig = await github.generateJitConfig(runnerName, job.label);
```

and the `createSandbox` call's `shape`:

```ts
  const sandbox = await c.createSandbox({
    shape: shapeForLabel(job.label, config),
```

Also extend the `createRunnerSandbox` doc comment with a line explaining the new coupling:

```ts
 * The VM's shape comes from the label the job requested (`shapeForLabel`), and
 * the runner registers under that same single label — the two must agree or a
 * job gets a runner of the wrong size.
```

- [ ] **Step 5: Rewrite admission in `src/handler.ts`**

Change the import on line 3 and add one:

```ts
import { verifySignature, parseWorkflowJob } from "./webhook";
import { createosLabels, isUsableLabel, usableShapes } from "./shapes";
```

Replace lines 90–99 (from `const job = parseWorkflowJob(body);` through the `const pending: PendingJob = {...}` block) with:

```ts
  const job = parseWorkflowJob(body);
  if (!job) return new Response("ignored", { status: 202 });

  // "Is this ours" is a pure label question for every action — the catalog is
  // only needed to admit a `queued` job below. Gating teardown on the shapes API
  // would leak every shaped VM during a shapes outage.
  const ours = createosLabels(job.labels, config);
  if (ours.length === 0) return new Response("no-label", { status: 202 });
  if (ours.length > 1) {
    console.warn(`job ${job.jobId} names ${ours.length} createos labels (${ours.join(", ")})`);
    return new Response("ambiguous-label", { status: 202 });
  }
  const label = ours[0]!;

  const co = coordinator(env);
  const pending: PendingJob = {
    jobId: job.jobId,
    runId: job.runId,
    repoFullName: job.repoFullName,
    label,
  };
```

Then, inside `if (job.action === "queued") {`, add the catalog check as the first statement:

```ts
  if (job.action === "queued") {
    if (!(await isUsableLabel(label, config, deps))) {
      return new Response("unknown-shape", { status: 202 });
    }
    const github = new GitHubClient(config);
```

(`isUsableLabel` already warns on both the not-offered and fetch-failed paths, so no second warn here.)

- [ ] **Step 6: Fix the reconciler in `src/handler.ts`**

In `runReconciler`, replace step B's fetch and its `shouldProvision` call:

```ts
  // B. Re-drive every still-queued label job GitHub knows about. The catalog is
  //    fetched once for the whole tick; if it's unavailable we fall back to an
  //    empty set, which still re-drives bare-label jobs.
  let usable: Set<string>;
  try {
    usable = await usableShapes(config, deps);
  } catch (err) {
    console.warn(`reconcile: shape catalog unavailable, bare-label jobs only: ${String(err)}`);
    usable = new Set();
  }

  let queued: PendingJob[];
  try {
    queued = await github.listQueuedJobs(usable);
  } catch (err) {
    console.error(`reconcile: queued-job poll failed: ${String(err)}`);
    return;
  }

  const toProvision: PendingJob[] = [];
  for (const job of queued) {
    const eligible = await shouldProvision(
      config,
      {
        action: "queued",
        jobId: job.jobId,
        runId: job.runId,
        repoFullName: job.repoFullName,
        labels: [job.label],
      },
      () => github.isForkJob(job.repoFullName, job.runId),
    );
```

- [ ] **Step 7: Update the existing tests that the signature changes broke**

`test/unit/webhook.test.ts` — delete the `matchesLabel` describe block; its cases now live in `test/unit/shapes.test.ts` (`createosLabels`, `pickLabel`).

`test/unit/sandbox.test.ts` — every `createRunnerSandbox` call now needs a `label` on its `PendingJob`, and the mocked client needs no `listShapes` (the bare label short-circuits). Add `label: "createos"` to each job fixture, and assert the shape is threaded:

```ts
  it("derives the VM shape from the job's label", async () => {
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1" });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as never;
    const job = { jobId: 7, runId: 1, repoFullName: "o/r", label: "createos-8vcpu-16gb" };

    await createRunnerSandbox(config, github, job, {
      makeClient: () => ({ createSandbox }) as never,
      attemptId: () => "aa",
    });

    expect(createSandbox.mock.calls[0]![0].shape).toBe("s-8vcpu-16gb");
    expect(github.generateJitConfig).toHaveBeenCalledWith("ghar-7-aa", "createos-8vcpu-16gb");
  });
```

`test/unit/client.test.ts` — `generateJitConfig` now takes two args; update its calls to `generateJitConfig("ghar-1-aa", "createos")` and assert the posted body's `labels` is `["createos"]`. Any `listQueuedJobs()` call becomes `listQueuedJobs(new Set(["s-2vcpu-2gb"]))`.

`test/integration/*.test.ts` — every `co.onQueued({...})` fixture needs `label: "createos"`. Every `deps.makeClient` mock used on a **queued** path with a **shaped** label needs `listShapes`; bare-label paths do not (short-circuit). Add `resetShapeCacheForTests()` in a `beforeEach` of any suite that stubs `listShapes`, so the module cache does not leak between cases.

- [ ] **Step 8: Full verification — the suite must be green here**

```bash
node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run && node_modules/.bin/oxlint src test
```

Expected: typecheck clean, all tests pass, lint shows only pre-existing warnings. If `tsc` still reports a missing `label`, a `PendingJob` construction site was missed — find it, do not cast it away.

- [ ] **Step 9: Commit**

```bash
git add src/webhook.ts src/handler.ts src/sandbox.ts src/github/client.ts test/
git commit -m "feat(labels): select VM shape from the runs-on label"
```

---

### Task 5: End-to-end integration tests

**Files:**
- Create: `test/integration/shapes.test.ts`
- Modify: `test/helpers/mocks.ts` (a shapes route helper)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing consumed by later tasks.

These are the three behaviors that only a real DO + real handler can prove, and that the unit tests structurally cannot.

- [ ] **Step 1: Add a catalog helper to `test/helpers/mocks.ts`**

```ts
/** The `listShapes()` half of a mocked createos client. */
export function shapeCatalog(): { id: string; vcpu: number; mem_mib: number; default_disk_mib: number }[] {
  return [
    { id: "s-2vcpu-2gb", vcpu: 2, mem_mib: 2048, default_disk_mib: 10240 },
    { id: "s-4vcpu-4gb", vcpu: 4, mem_mib: 4096, default_disk_mib: 10240 },
    { id: "s-8vcpu-16gb", vcpu: 8, mem_mib: 16384, default_disk_mib: 10240 },
  ];
}
```

- [ ] **Step 2: Create `test/integration/shapes.test.ts`**

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleWebhook } from "../../src/handler";
import { resetShapeCacheForTests } from "../../src/shapes";
import { sign, workflowJobPayload } from "../helpers/fixtures";
import { shapeCatalog } from "../helpers/mocks";

const realFetch = globalThis.fetch;
function patchGitHub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.includes("/access_tokens"))
      return new Response(
        JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() }),
        { status: 201 },
      );
    if (req.url.includes("/generate-jitconfig"))
      return new Response(JSON.stringify({ encoded_jit_config: "BLOB", runner: { id: 1 } }), {
        status: 201,
      });
    return realFetch(input, init);
  }) as typeof fetch;
}

async function post(body: string, delivery: string, deps: object) {
  const req = new Request("https://ctrl.local/webhook", {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": await sign(env.GITHUB_WEBHOOK_SECRET as string, body),
      "X-GitHub-Delivery": delivery,
    },
    body,
  });
  const ctx = createExecutionContext();
  const res = await handleWebhook(req, env as never, ctx, deps);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => {
  resetShapeCacheForTests();
  patchGitHub();
});

describe("shape labels end-to-end", () => {
  it("a shaped label boots a VM of that shape", async () => {
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb_shaped",
      runCommand: vi.fn().mockResolvedValue({ result: { exit_code: 0 } }),
    });
    const deps = {
      makeClient: () => ({ createSandbox, listShapes: async () => shapeCatalog() }) as never,
    };

    const body = workflowJobPayload({
      action: "queued",
      jobId: 700,
      labels: ["createos-8vcpu-16gb"],
    });
    const res = await post(body, "dlv-shaped", deps);

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("provision");
    expect(createSandbox.mock.calls[0]![0].shape).toBe("s-8vcpu-16gb");
  });

  it("a shaped label naming no real shape is refused without burning a slot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const createSandbox = vi.fn();
    const deps = {
      makeClient: () => ({ createSandbox, listShapes: async () => shapeCatalog() }) as never,
    };

    // The DO is a singleton shared across every case in this file, so assert on
    // the delta, not on an absolute count — earlier cases leave rows behind.
    const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
    const before = await co.activeCount();

    const body = workflowJobPayload({
      action: "queued",
      jobId: 701,
      labels: ["createos-99vcpu-1tb"],
    });
    const res = await post(body, "dlv-bogus", deps);

    expect(await res.text()).toBe("unknown-shape");
    expect(createSandbox).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("not offered"))).toBe(true);
    expect(await co.activeCount()).toBe(before);
  });

  it("tears down a shaped job's VM even when the shapes API is down", async () => {
    // Boot it while the catalog is healthy.
    const destroy = vi.fn().mockResolvedValue(undefined);
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb_teardown",
      runCommand: vi.fn().mockResolvedValue({ result: { exit_code: 0 } }),
    });
    const healthy = {
      // Pinned so the runner name below is deterministic: ghar-<jobId>-<attemptId>.
      attemptId: () => "aa",
      makeClient: () =>
        ({
          createSandbox,
          listShapes: async () => shapeCatalog(),
          getSandbox: async () => ({ destroy }),
        }) as never,
    };
    await post(
      workflowJobPayload({ action: "queued", jobId: 702, labels: ["createos-2vcpu-2gb"] }),
      "dlv-t1",
      healthy,
    );

    // Now the catalog is unreachable. `completed` must still destroy the VM:
    // teardown keys on runner identity, never on the shapes API.
    resetShapeCacheForTests();
    const down = {
      makeClient: () =>
        ({
          listShapes: async () => {
            throw new Error("503");
          },
          getSandbox: async () => ({ destroy }),
        }) as never,
    };
    const res = await post(
      workflowJobPayload({
        action: "completed",
        jobId: 702,
        labels: ["createos-2vcpu-2gb"],
        runnerName: "ghar-702-aa",
      }),
      "dlv-t2",
      down,
    );

    expect(await res.text()).toBe("completed");
    expect(destroy).toHaveBeenCalled();
  });
});
```

The third test's `runnerName` (`ghar-702-aa`) must match what `createRunnerSandbox` generated, which is why `healthy` pins `attemptId`. Without it the token is random and `onCompleted` falls back to `job_id` lookup — the test would pass for the wrong reason, never exercising runner-identity teardown.

- [ ] **Step 3: Run the full suite**

```bash
node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run && node_modules/.bin/oxlint src test
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/integration/shapes.test.ts test/helpers/mocks.ts
git commit -m "test(shapes): cover shaped boot, bad label, outage teardown"
```

---

### Task 6: Documentation, ADR, and live smoke coverage

**Files:**
- Create: `docs/adr/0004-shape-labels.md`
- Modify: `CONTEXT.md`, `README.md`, `CLAUDE.md`, `.github/workflows/ghar-test.yml`

- [ ] **Step 1: Write `docs/adr/0004-shape-labels.md`**

Match the house style of `docs/adr/0003-teardown-by-runner-identity.md` (read it first). Content:

- **Context.** One `RUNNER_SHAPE` for the whole org. createos publishes a shape catalog at `GET /v1/shapes`. `runs-on` is the only channel a workflow author has to express intent.
- **Decision.** `runs-on: [createos-<shape suffix>]` selects a shape; bare `createos` means `RUNNER_SHAPE`. The catalog is fetched live and floored by `MIN_RUNNER_MEM_MIB`, so new shapes need no redeploy. A JIT runner registers with **exactly one** label.
- **Consequences.** The label vocabulary is a public interface — renaming it breaks user workflows, which is why this is an ADR. One label per runner keeps shape pools disjoint under GitHub's AND-matching; registering a runner with several createos labels would reintroduce the mis-assignment ADR-0003 fixed for `job_id`. `MAX_CONCURRENT` stays an unweighted slot count, so a burst of large shapes is bounded by the createos plan quota (a `403` → `markProvisionFailed` → alert), not by the controller.

- [ ] **Step 2: Add "shape label" to `CONTEXT.md`**

In the glossary, after the runner/sandbox entries:

```markdown
- **Shape** — a createos VM sizing preset (`s-2vcpu-2gb`), from `GET /v1/shapes`.
- **Shape label** — the `runs-on` label a workflow uses to pick a shape
  (`createos-2vcpu-2gb`). The bare `createos` label means `RUNNER_SHAPE`. Exactly
  one shape label per runner (ADR-0004).
```

- [ ] **Step 3: Document the labels in `README.md`**

Add a section under the setup runbook:

````markdown
## Choosing a runner size

```yaml
jobs:
  build:
    runs-on: [createos]             # RUNNER_SHAPE (default s-4vcpu-4gb)
  big:
    runs-on: [createos-8vcpu-16gb]  # a specific createos shape
```

Available labels are derived live from the createos shape catalog
(`GET /v1/shapes`), so a shape added to the platform is usable without
redeploying this Worker. Shapes below `MIN_RUNNER_MEM_MIB` (default 2048) or
with a fractional-vCPU quota are excluded — an Actions runner cannot work on
them.

Use exactly one `createos*` label. Two (`[createos, createos-2vcpu-2gb]`) is
refused and the job will never get a runner.
````

- [ ] **Step 4: Update `CLAUDE.md`**

Extend the `src/shapes.ts` line into the "File responsibilities" list, and add a gotcha:

```markdown
- `src/createos.ts` — builds the createos SDK client; owns `SandboxDeps`. Exists to break the `sandbox.ts` ↔ `shapes.ts` cycle.
- `src/shapes.ts` — label ↔ shape mapping, the cached (5 min) + floored shape catalog from `GET /v1/shapes`, and label admission. Pure parts (`createosLabels`, `shapeForLabel`, `pickLabel`) never touch the network.
```

Under "Toolchain gotchas":

```markdown
- **The shape catalog is only consulted on `queued`.** A `completed` webhook must never depend on `GET /v1/shapes` — teardown keys on runner identity, and gating it on the catalog would leak every shaped VM during a shapes outage.
- **`src/shapes.ts` holds a module-level cache.** Tests that stub `listShapes` must call `resetShapeCacheForTests()` in `beforeEach` or the first suite's catalog leaks into the next.
```

- [ ] **Step 5: Add a shaped job to `.github/workflows/ghar-test.yml`**

Append a second job so one dispatch exercises both the bare and the shaped path. It asserts the shape actually took effect rather than just running green — `nproc` on a `s-2vcpu-2gb` VM must be 2.

```yaml
  smoke-shaped:
    runs-on: [createos-2vcpu-2gb]
    steps:
      - name: Identify the runner
        run: |
          echo "host: $(hostname)"
          echo "cpus: $(nproc)   mem: $(free -h | awk '/Mem:/{print $2}')"
      - name: Assert the requested shape
        run: |
          test "$(nproc)" -eq 2 || { echo "expected 2 vCPU, got $(nproc)"; exit 1; }
```

- [ ] **Step 6: Commit**

```bash
git add docs/adr/0004-shape-labels.md CONTEXT.md README.md CLAUDE.md .github/workflows/ghar-test.yml
git commit -m "docs(shapes): document shape labels + ADR-0004"
```

---

## Deploy + live verification

Not a code task — run it after Task 6 is merged, and only with the user's go-ahead.

1. `bunx wrangler@latest deploy`
2. `gh workflow run ghar-test.yml --ref main`
3. Confirm both jobs run green, and that the shaped job's VM reports 2 vCPU.
4. Confirm both VMs self-delete within seconds of their jobs completing.

The DO migration (`ALTER TABLE jobs ADD COLUMN label`) runs in the constructor on
the next DO wake. Rows in flight across the deploy read `label = NULL` → the bare
label, which is what they were provisioned with. No manual migration step.
