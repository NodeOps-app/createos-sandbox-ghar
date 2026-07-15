# Coordinator Row Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every public Coordinator transition use one private implementation for “persist Destroying with a Sandbox, otherwise delete the Job row.”

**Architecture:** Add `#retireRow` inside the existing deep Coordinator module; do not create a new public module or change any Durable Object method interface. Completion, provision failure, unregistered-Runner reaping, age reaping, and Destroying retries call the same private function, while their distinct row-selection and pending-promotion rules remain in their public methods.

**Tech Stack:** TypeScript 6.0.3, Cloudflare Durable Objects SQLite, Bun, Vitest 3.2.4, `@cloudflare/vitest-pool-workers` 0.8.71, oxlint, oxfmt.

## Global Constraints

- Execute after the Job admission plan or rebase onto the same green baseline; this plan changes no admission code.
- **Implement, then test — no TDD.** Preserve all existing behavior before adding regression coverage.
- Prefix every shell command and command-chain segment with `rtk`.
- Keep the Coordinator passive: SQL and state decisions only, no network I/O.
- Do not change the SQLite schema, `ROW_AGE`, `ACTIVE_STATES`, public method names, or result shapes.
- A Destroying row must retain its Sandbox id until `markDestroyed` confirms external teardown.
- A VM-less row must be deleted rather than left in Destroying.
- An existing Destroying row remains idempotent and reappears in `sweep` until confirmation.
- Run `rtk oxfmt --write` on every changed TypeScript file.
- Conventional Commits, imperative subject, at most 50 characters.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/coordinator.ts` | modify | Add and use canonical private row retirement |
| `test/integration/retirement.test.ts` | create | Exercise the same retirement contract through all public entry paths |

---

### Task 1: Add canonical private row retirement

**Files:**
- Modify: `src/coordinator.ts:145-165, 251-271, 282-299, 361-420`

**Interfaces:**
- Consumes: private `Row`, `TeardownTask`, and `#sql`.
- Produces: private `#retireRow(row, sandboxId?): TeardownTask | null`.
- Public Coordinator interface: unchanged.

- [ ] **Step 1: Add `#retireRow` after `#rowByRunner`**

```ts
  /**
   * Canonical Job-row retirement. A row with a live VM becomes Destroying and
   * returns the durable teardown effect; a VM-less row is deleted immediately.
   * Reapplying this to an existing Destroying row is idempotent.
   */
  #retireRow(row: Row, sandboxId: string | null = row.sandbox_id): TeardownTask | null {
    if (!sandboxId) {
      this.#sql.exec(`DELETE FROM jobs WHERE job_id = ?`, row.job_id);
      return null;
    }
    this.#sql.exec(
      `UPDATE jobs SET state = 'destroying', sandbox_id = ? WHERE job_id = ?`,
      sandboxId,
      row.job_id,
    );
    return { jobId: row.job_id, sandboxId };
  }
```

- [ ] **Step 2: Rewrite `markProvisionFailed` to use `#retireRow`**

Replace its implementation with:

```ts
  async markProvisionFailed(jobId: number, sandboxId?: string): Promise<ProvisionFailedResult> {
    const row = this.#rowByJob(jobId);
    let toDestroy: TeardownTask | null = null;
    const vm = sandboxId ?? row?.sandbox_id ?? null;

    if (row && row.state !== "destroying") {
      toDestroy = this.#retireRow(row, vm);
    } else if (!row && vm) {
      // No row can persist this teardown; the Worker must destroy immediately,
      // with the Orphaned Sandbox sweep as its final backstop.
      toDestroy = { jobId, sandboxId: vm };
    }
    return { toDestroy, nextPending: this.#dequeuePending() };
  }
```

- [ ] **Step 3: Rewrite `onCompleted` retirement**

Replace its local `toDestroy` branch with:

```ts
    const toDestroy = this.#retireRow(row);
    return { toDestroy, nextPending: this.#dequeuePending() };
```

Keep the existing missing-row/Destroying early return and runner-name-first row selection unchanged.

- [ ] **Step 4: Rewrite `reapUnregistered` retirement**

Replace the Sandbox/delete branch inside its loop with:

```ts
      const task = this.#retireRow(r);
      if (task) toDestroy.push(task);
```

Keep the online-Runner skip, `ROW_AGE` query, and final `#drainPending()` unchanged.

- [ ] **Step 5: Rewrite both `sweep` loops**

Use this for existing Destroying rows:

```ts
    for (const row of this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE state = 'destroying'`)
      .toArray()) {
      const task = this.#retireRow(row);
      if (task) toDestroy.push(task);
    }
```

Use this for stale active rows:

```ts
    for (const row of this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE state IN ${ACTIVE_STATES} AND ${ROW_AGE} < ?`, cutoff)
      .toArray()) {
      const task = this.#retireRow(row);
      if (task) toDestroy.push(task);
    }
```

Keep pending expiry, delivery expiry, and the final `#drainPending()` unchanged.

- [ ] **Step 6: Format and run the existing Coordinator suites**

```bash
rtk oxfmt --write src/coordinator.ts
rtk bun run test test/integration/concurrency.test.ts test/integration/idempotency.test.ts test/integration/teardown.test.ts test/integration/reaper.test.ts test/integration/reconcile.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: all suites pass with the public Coordinator results unchanged; typecheck and lint exit 0.

- [ ] **Step 7: Commit the private implementation refactor**

```bash
rtk git add src/coordinator.ts
rtk git commit -m "refactor: centralize row retirement"
```

### Task 2: Add one retirement contract across public entry paths

**Files:**
- Create: `test/integration/retirement.test.ts`

**Interfaces:**
- Consumes: public Coordinator methods only.
- Produces: a parameterized contract proving every entry path returns the same teardown effect and retains the Destroying row for retry.

- [ ] **Step 1: Create `test/integration/retirement.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runnerName } from "../helpers/mocks";

type Stub = ReturnType<typeof env.COORDINATOR.get>;

const job = (jobId: number) => ({
  jobId,
  runId: jobId,
  repoFullName: "nodeops-app/api",
  label: "createos",
});

async function seeded(jobId: number, sandboxId: string): Promise<Stub> {
  const stub = env.COORDINATOR.get(
    env.COORDINATOR.idFromName(`retirement-${jobId}-${Math.random()}`),
  );
  await stub.onQueued(job(jobId), `delivery-${jobId}`);
  await stub.recordSandboxCreated(jobId, sandboxId, runnerName(jobId));
  return stub;
}

async function expectDestroyingRetry(
  stub: Stub,
  jobId: number,
  sandboxId: string,
): Promise<void> {
  expect(await stub.activeCount()).toBe(0);
  expect(await stub.liveJobIds()).toContain(jobId);
  const retry = await stub.sweep(Date.now(), 3_600_000);
  expect(retry.toDestroy).toContainEqual({ jobId, sandboxId });
  await stub.markDestroyed(jobId);
  expect(await stub.liveJobIds()).not.toContain(jobId);
}

describe("canonical Coordinator row retirement", () => {
  it("retires completion through runner identity", async () => {
    const stub = await seeded(960, "sb-960");
    await stub.markRunning(960);

    const result = await stub.onCompleted(960, runnerName(960));

    expect(result.toDestroy).toEqual({ jobId: 960, sandboxId: "sb-960" });
    await expectDestroyingRetry(stub, 960, "sb-960");
  });

  it("retires a provision failure with a recorded VM", async () => {
    const stub = await seeded(961, "sb-961");

    const result = await stub.markProvisionFailed(961);

    expect(result.toDestroy).toEqual({ jobId: 961, sandboxId: "sb-961" });
    await expectDestroyingRetry(stub, 961, "sb-961");
  });

  it("retires an unregistered Runner after grace", async () => {
    const stub = await seeded(962, "sb-962");
    await stub.markRunning(962);

    const result = await stub.reapUnregistered(Date.now() + 1, [], 0);

    expect(result.toDestroy).toContainEqual({ jobId: 962, sandboxId: "sb-962" });
    await expectDestroyingRetry(stub, 962, "sb-962");
  });

  it("retires an active row after maximum age", async () => {
    const stub = await seeded(963, "sb-963");
    await stub.markRunning(963);

    const result = await stub.sweep(Date.now() + 1, 0);

    expect(result.toDestroy).toContainEqual({ jobId: 963, sandboxId: "sb-963" });
    await expectDestroyingRetry(stub, 963, "sb-963");
  });

  it("deletes a VM-less row without inventing teardown", async () => {
    const stub = env.COORDINATOR.get(
      env.COORDINATOR.idFromName(`retirement-empty-${Math.random()}`),
    );
    await stub.onQueued(job(964), "delivery-964");

    const result = await stub.markProvisionFailed(964);

    expect(result.toDestroy).toBeNull();
    expect(await stub.liveJobIds()).not.toContain(964);
  });
});
```

- [ ] **Step 2: Format and run the contract**

```bash
rtk oxfmt --write test/integration/retirement.test.ts
rtk bun run test test/integration/retirement.test.ts test/integration/teardown.test.ts test/integration/reaper.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: all retirement paths emit their expected teardown task, retain retry state, and disappear only after `markDestroyed`.

- [ ] **Step 3: Commit the contract tests**

```bash
rtk git add test/integration/retirement.test.ts
rtk git commit -m "test: unify retirement expectations"
```

### Task 3: Complete full verification

**Files:**
- Modify: none.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: a verified behavior-preserving Coordinator refactor.

- [ ] **Step 1: Run the definition of done**

```bash
rtk bun run lint
rtk bun run typecheck
rtk bun run test
rtk git diff --check
```

Expected: all commands exit 0 with no new warnings.

- [ ] **Step 2: Confirm the public interface did not change**

```bash
rtk git diff HEAD~2 -- src/types.ts src/coordinator.ts
```

Expected: `src/types.ts` is unchanged; only private implementation in `src/coordinator.ts` changed.

- [ ] **Step 3: Confirm no migration or network call was added**

```bash
rtk proxy rg -n "ALTER TABLE|fetch\(|GitHubClient|CreateosSandboxClient" src/coordinator.ts
```

Expected: only the pre-existing additive migration lines match; there is no `fetch`, GitHub client, or CreateOS client construction.
