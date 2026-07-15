# Job Admission Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated webhook/Reconciler label-policy-catalog choreography with one functional Job admission interface.

**Architecture:** `src/admission.ts` identifies the requested Runner label, applies Provisioning policy before any Shape catalog read, lazily shares one catalog promise across every Job admitted by the same factory, and returns explicit domain outcomes. `src/shapes.ts` retains Shape mapping and catalog caching; `handler.ts` translates admission outcomes into webhook responses or Reconciler logs without reconstructing the rule.

**Tech Stack:** TypeScript 6.0.3, Bun, Cloudflare Workers, Vitest 3.2.4, oxlint, oxfmt.

## Global Constraints

- Begin from commit `03575a8` or a descendant, after `rtk bun run lint`, `rtk bun run typecheck`, and `rtk bun run test` are green.
- **Implement, then test — no TDD.** Write implementation first, then its tests.
- Prefix every shell command and command-chain segment with `rtk`.
- Preserve ADR-0004: exactly one Shape label, policy before catalog, bare `createos` never fetches the catalog, and completed teardown never depends on the catalog or current policy.
- `fetchCatalog` remains in the Worker; the Coordinator stays passive.
- No new dependency and no config/schema change.
- Run `rtk oxfmt --write` on every changed TypeScript file.
- Conventional Commits, imperative subject, at most 50 characters.
- Before merging, capture the active Worker version; after deployment, run `ghar-test` and confirm the Sandbox disappears.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/admission.ts` | create | Job identification and ordered admission; one lazy Shape catalog per factory |
| `src/shapes.ts` | modify | Shape mapping and cached catalog only; delete admission primitives |
| `src/policy.ts` | modify | Accept the minimal Job fields policy actually consumes |
| `src/handler.ts` | modify | Call admission from webhook and Reconciler paths |
| `test/unit/admission.test.ts` | create | Admission decision table and catalog-call invariants |
| `test/unit/shapes.test.ts` | modify | Remove tests moved to the admission interface |
| `test/integration/shapes.test.ts` | modify | Assert webhook/Reconciler parity through external effects |
| `CONTEXT.md` | modify | Define Job admission as a domain term |

---

### Task 1: Create the functional Job admission module

**Files:**
- Create: `src/admission.ts`
- Modify: `src/policy.ts:1-25`
- Modify: `src/shapes.ts:142-227`
- Test: `test/unit/admission.test.ts`
- Test: `test/unit/shapes.test.ts:210-310`

**Interfaces:**
- Consumes: `Config`, `PendingJob`, `Catalog`, `shapeForLabel`, `shouldProvision`.
- Produces:
  - `interface JobCandidate { jobId; runId; repoFullName; labels }`
  - `type IdentifiedJob`
  - `type AdmissionDecision`
  - `interface AdmissionDeps`
  - `identifyJob(candidate, config): IdentifiedJob`
  - `createJobAdmission(config, deps): (candidate) => Promise<AdmissionDecision>`

- [ ] **Step 1: Narrow the Provisioning policy input**

Replace `src/policy.ts` with:

```ts
import type { Config } from "./types";

export interface PolicyJob {
  repoFullName: string;
}

/**
 * Decides whether a job is eligible for a Sandbox. `isFork` is lazy and is
 * awaited only by fork-gated policy, so org-wide admission stays network-free.
 */
export async function shouldProvision(
  config: Config,
  job: PolicyJob,
  isFork: () => Promise<boolean>,
): Promise<boolean> {
  const [org] = job.repoFullName.split("/");
  if (org?.toLowerCase() !== config.githubOrg.toLowerCase()) return false;

  switch (config.provisionPolicy) {
    case "org-wide":
      return true;
    case "repo-allowlist":
      return config.repoAllowlist.includes(job.repoFullName);
    case "fork-gated":
      return !(await isFork());
  }
}
```

- [ ] **Step 2: Create `src/admission.ts`**

```ts
import { shouldProvision } from "./policy";
import { shapeForLabel, type Catalog } from "./shapes";
import type { Config, PendingJob } from "./types";

export interface JobCandidate {
  jobId: number;
  runId: number;
  repoFullName: string;
  labels: string[];
}

export type IdentifiedJob =
  | { kind: "none" }
  | { kind: "ambiguous"; labels: string[] }
  | { kind: "identified"; job: PendingJob };

export type AdmissionDecision =
  | { kind: "admitted"; job: PendingJob }
  | { kind: "refused"; reason: "no-label" }
  | { kind: "refused"; reason: "ambiguous-label"; labels: string[] }
  | { kind: "refused"; reason: "policy-skip" }
  | { kind: "refused"; reason: "catalog-unavailable"; label: string }
  | { kind: "refused"; reason: "unknown-shape"; label: string; shape: string };

export interface AdmissionDeps {
  isForkJob(repoFullName: string, runId: number): Promise<boolean>;
  loadCatalog(): Promise<Catalog>;
}

export function identifyJob(candidate: JobCandidate, config: Config): IdentifiedJob {
  const shapedPrefix = `${config.runnerLabel}-`;
  const requested = candidate.labels.filter(
    (label) => label === config.runnerLabel || label.startsWith(shapedPrefix),
  );
  if (requested.length === 0) return { kind: "none" };
  if (requested.length > 1) return { kind: "ambiguous", labels: requested };
  return {
    kind: "identified",
    job: {
      jobId: candidate.jobId,
      runId: candidate.runId,
      repoFullName: candidate.repoFullName,
      label: requested[0]!,
    },
  };
}

export function createJobAdmission(
  config: Config,
  deps: AdmissionDeps,
): (candidate: JobCandidate) => Promise<AdmissionDecision> {
  let catalogPromise: Promise<Catalog> | undefined;
  const catalog = (): Promise<Catalog> => (catalogPromise ??= deps.loadCatalog());

  return async (candidate) => {
    const identified = identifyJob(candidate, config);
    if (identified.kind === "none") return { kind: "refused", reason: "no-label" };
    if (identified.kind === "ambiguous") {
      return { kind: "refused", reason: "ambiguous-label", labels: identified.labels };
    }

    const eligible = await shouldProvision(config, candidate, () =>
      deps.isForkJob(candidate.repoFullName, candidate.runId),
    );
    if (!eligible) return { kind: "refused", reason: "policy-skip" };

    const { job } = identified;
    if (job.label === config.runnerLabel) return { kind: "admitted", job };

    const loaded = await catalog();
    if (!loaded.ok) {
      return { kind: "refused", reason: "catalog-unavailable", label: job.label };
    }
    const shape = shapeForLabel(job.label, config);
    if (!loaded.usable.has(shape)) {
      return { kind: "refused", reason: "unknown-shape", label: job.label, shape };
    }
    return { kind: "admitted", job };
  };
}
```

- [ ] **Step 3: Delete shallow admission exports from `src/shapes.ts`**

Delete `createosLabels`, `RequestedLabel`, `resolveRequestedLabel`, `isShapedLabel`, `ShapeCheck`, and `validateShape`. Keep these public exports unchanged:

```ts
export function resetShapeCacheForTests(): void;
export function shapeForLabel(label: string, config: Config): string;
export function usableShapes(
  config: Config,
  deps: SandboxDeps,
  nowMs?: number,
): Promise<Set<string>>;
export type Catalog = { ok: true; usable: Set<string> } | { ok: false };
export function fetchCatalog(config: Config, deps: SandboxDeps): Promise<Catalog>;
```

- [ ] **Step 4: Add the admission decision table**

Create `test/unit/admission.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createJobAdmission, identifyJob, type JobCandidate } from "../../src/admission";
import { loadConfig } from "../../src/config";
import type { Catalog } from "../../src/shapes";

const config = loadConfig({
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

const candidate = (overrides: Partial<JobCandidate> = {}): JobCandidate => ({
  jobId: 101,
  runId: 201,
  repoFullName: "nodeops-app/api",
  labels: ["self-hosted", "createos"],
  ...overrides,
});

const healthy: Catalog = {
  ok: true,
  usable: new Set(["s-2vcpu-2gb", "s-4vcpu-4gb"]),
};

describe("identifyJob", () => {
  it("identifies none, ambiguity, and one requested label", () => {
    expect(identifyJob(candidate({ labels: ["ubuntu-latest"] }), config)).toEqual({
      kind: "none",
    });
    expect(
      identifyJob(candidate({ labels: ["createos", "createos-2vcpu-2gb"] }), config),
    ).toEqual({
      kind: "ambiguous",
      labels: ["createos", "createos-2vcpu-2gb"],
    });
    expect(identifyJob(candidate(), config)).toEqual({
      kind: "identified",
      job: {
        jobId: 101,
        runId: 201,
        repoFullName: "nodeops-app/api",
        label: "createos",
      },
    });
  });
});

describe("createJobAdmission", () => {
  it("admits a bare label without loading the Shape catalog", async () => {
    const loadCatalog = vi.fn<() => Promise<Catalog>>().mockResolvedValue(healthy);
    const admit = createJobAdmission(config, {
      isForkJob: vi.fn().mockResolvedValue(false),
      loadCatalog,
    });

    await expect(admit(candidate())).resolves.toMatchObject({ kind: "admitted" });
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("applies policy before loading the Shape catalog", async () => {
    const blocked = { ...config, provisionPolicy: "repo-allowlist" as const, repoAllowlist: [] };
    const loadCatalog = vi.fn<() => Promise<Catalog>>().mockResolvedValue(healthy);
    const admit = createJobAdmission(blocked, {
      isForkJob: vi.fn().mockResolvedValue(false),
      loadCatalog,
    });

    await expect(
      admit(candidate({ labels: ["createos-2vcpu-2gb"] })),
    ).resolves.toEqual({ kind: "refused", reason: "policy-skip" });
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("shares one lazy catalog across a batch", async () => {
    const loadCatalog = vi.fn<() => Promise<Catalog>>().mockResolvedValue(healthy);
    const admit = createJobAdmission(config, {
      isForkJob: vi.fn().mockResolvedValue(false),
      loadCatalog,
    });

    await expect(
      admit(candidate({ jobId: 102, labels: ["createos-2vcpu-2gb"] })),
    ).resolves.toMatchObject({ kind: "admitted" });
    await expect(
      admit(candidate({ jobId: 103, labels: ["createos-4vcpu-4gb"] })),
    ).resolves.toMatchObject({ kind: "admitted" });
    expect(loadCatalog).toHaveBeenCalledOnce();
  });

  it("distinguishes unavailable and unknown Shapes", async () => {
    const unavailable = createJobAdmission(config, {
      isForkJob: vi.fn().mockResolvedValue(false),
      loadCatalog: vi.fn().mockResolvedValue({ ok: false }),
    });
    await expect(
      unavailable(candidate({ labels: ["createos-2vcpu-2gb"] })),
    ).resolves.toEqual({
      kind: "refused",
      reason: "catalog-unavailable",
      label: "createos-2vcpu-2gb",
    });

    const unknown = createJobAdmission(config, {
      isForkJob: vi.fn().mockResolvedValue(false),
      loadCatalog: vi.fn().mockResolvedValue(healthy),
    });
    await expect(
      unknown(candidate({ labels: ["createos-99vcpu-1tb"] })),
    ).resolves.toEqual({
      kind: "refused",
      reason: "unknown-shape",
      label: "createos-99vcpu-1tb",
      shape: "s-99vcpu-1tb",
    });
  });
});
```

- [ ] **Step 5: Remove moved tests from `test/unit/shapes.test.ts`**

Delete the `resolveRequestedLabel` and `validateShape` import names and their `describe` blocks. Retain the `shapeForLabel`, `usableShapes`, `fetchCatalog`, cache-coalescing, warning, and catalog-failure tests.

- [ ] **Step 6: Format and run the focused tests**

```bash
rtk oxfmt --write src/admission.ts src/policy.ts src/shapes.ts test/unit/admission.test.ts test/unit/shapes.test.ts
rtk bun run test test/unit/admission.test.ts test/unit/policy.test.ts test/unit/shapes.test.ts
rtk bun run lint
```

Expected: the focused tests pass and lint exits 0. Do not run or commit the full typecheck yet: `handler.ts` still imports the admission exports removed from `shapes.ts`; the next phase rewires both callers before this task reaches its review gate.

#### Call-site phase: Route webhook and Reconciler intake through admission

**Files:**
- Modify: `src/handler.ts:1-217, 405-504`
- Test: `test/integration/shapes.test.ts`
- Test: `test/integration/reconcile.test.ts`

**Interfaces:**
- Consumes: `identifyJob` and `createJobAdmission` from Task 1.
- Produces: both Job sources use the same admission decision; completed actions use identification only.

- [ ] **Step 1: Replace the admission imports in `src/handler.ts`**

Use:

```ts
import { createJobAdmission, identifyJob, type AdmissionDecision } from "./admission";
import { fetchCatalog } from "./shapes";
```

Remove imports of `resolveRequestedLabel`, `isShapedLabel`, `validateShape`, `shapeForLabel`, and `Catalog` from `./shapes`, and remove the direct `shouldProvision` import.

- [ ] **Step 2: Add one refusal logger in `src/handler.ts`**

Place this above `handleWebhook`:

```ts
function warnAdmission(scope: string, candidate: { jobId: number; repoFullName: string }, decision: AdmissionDecision): void {
  if (decision.kind === "admitted" || decision.reason === "no-label" || decision.reason === "policy-skip") {
    return;
  }
  if (decision.reason === "ambiguous-label") {
    console.warn(
      `${scope}job ${candidate.jobId} (${candidate.repoFullName}) names ${decision.labels.length} createos labels (${decision.labels.join(", ")})`,
    );
    return;
  }
  if (decision.reason === "unknown-shape") {
    console.warn(
      `${scope}job ${candidate.jobId} (${candidate.repoFullName}): label "${decision.label}" names shape "${decision.shape}", which is not offered`,
    );
    return;
  }
  console.warn(`${scope}job ${candidate.jobId} (${candidate.repoFullName}): catalog-unavailable`);
}
```

- [ ] **Step 3: Replace queued webhook admission**

Immediately after parsing the webhook Job, branch queued actions through:

```ts
  const co = coordinator(env);

  if (job.action === "queued") {
    const github = new GitHubClient(config);
    const admit = createJobAdmission(config, {
      isForkJob: (repoFullName, runId) => github.isForkJob(repoFullName, runId),
      loadCatalog: () => fetchCatalog(config, deps),
    });
    const admission = await admit(job);
    if (admission.kind === "refused") {
      warnAdmission("", job, admission);
      return new Response(admission.reason, { status: 202 });
    }

    const decision = await co.onQueued(admission.job, delivery);
    if (decision.action === "provision") {
      ctx.waitUntil(provisionAndRecord(env, admission.job, deps));
    }
    return new Response(decision.action, { status: 202 });
  }
```

Then handle non-queued actions without policy or catalog:

```ts
  const identified = identifyJob(job, config);
  if (identified.kind === "none") return new Response("no-label", { status: 202 });
  if (identified.kind === "ambiguous") {
    const refusal: AdmissionDecision = {
      kind: "refused",
      reason: "ambiguous-label",
      labels: identified.labels,
    };
    warnAdmission("", job, refusal);
    return new Response("ambiguous-label", { status: 202 });
  }

  if (job.action === "completed") {
    const result = await co.onCompleted(job.jobId, job.runnerName);
    ctx.waitUntil(
      (async () => {
        if (result.toDestroy) await destroyAndConfirm(env, config, result.toDestroy, deps);
        if (result.nextPending) await provisionAndRecord(env, result.nextPending, deps);
      })(),
    );
    return new Response("completed", { status: 202 });
  }

  return new Response("noop", { status: 202 });
```

- [ ] **Step 4: Replace Reconciler admission loops**

Delete the `candidates`, `eligible`, `needsCatalog`, `catalog`, and Shape-validation loops. Replace them with:

```ts
  const admit = createJobAdmission(config, {
    isForkJob: (repoFullName, runId) => github.isForkJob(repoFullName, runId),
    loadCatalog: () => fetchCatalog(config, deps),
  });
  const toProvision: PendingJob[] = [];

  for (const candidate of queued) {
    const admission = await admit(candidate);
    if (admission.kind === "refused") {
      warnAdmission("reconcile: ", candidate, admission);
      continue;
    }
    const decision = await co.onQueued(
      admission.job,
      `reconcile-${admission.job.jobId}`,
    );
    if (decision.action === "provision") toProvision.push(admission.job);
  }

  await Promise.allSettled(toProvision.map((pending) => provisionAndRecord(env, pending, deps)));
```

This factory is created once per Reconciler tick, so every policy-eligible shaped Job shares one catalog promise.

- [ ] **Step 5: Add an external parity assertion**

In `test/integration/shapes.test.ts`, add:

```ts
  it("returns the same refusal for shaped webhook and Reconciler intake", async () => {
    const listShapes = vi.fn().mockRejectedValue(new Error("catalog down"));
    const deps = {
      makeClient: () => ({
        createSandbox: vi.fn(),
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
        listShapes,
      }),
    };

    const webhook = await post(
      workflowJobPayload({ action: "queued", jobId: 790, labels: ["createos-2vcpu-2gb"] }),
      "admission-parity-webhook",
      deps,
    );
    expect(await webhook.text()).toBe("catalog-unavailable");

    globalThis.fetch = mockFetch({
      ...githubRoutes(),
      "GET /actions/runners": () => new Response(JSON.stringify({ runners: [] })),
      "GET /installation/repositories": () =>
        new Response(JSON.stringify({ repositories: [{ full_name: "nodeops-app/api" }] })),
      "GET /actions/runs?status=queued": () =>
        new Response(JSON.stringify({ workflow_runs: [{ id: 990 }] })),
      "GET /actions/runs?status=in_progress": () =>
        new Response(JSON.stringify({ workflow_runs: [] })),
      "GET /actions/runs/990/jobs": () =>
        new Response(
          JSON.stringify({
            jobs: [{ id: 791, status: "queued", labels: ["createos-2vcpu-2gb"] }],
          }),
        ),
    });

    await runReconciler(env as any, deps);
    expect(listShapes).toHaveBeenCalledTimes(2);
  });
```

The two calls are intentional: failed catalog reads are not cached across the webhook and later Reconciler invocation; only concurrent or same-factory shaped Jobs share one promise.

Keep the suite's existing `beforeEach` reset for the Shape cache and global fetch restoration.

- [ ] **Step 6: Format and verify intake behavior**

```bash
rtk oxfmt --write src/handler.ts test/integration/shapes.test.ts test/integration/reconcile.test.ts
rtk bun run test test/integration/shapes.test.ts test/integration/reconcile.test.ts test/integration/provision.test.ts test/integration/teardown.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: queued webhook and Reconciler tests pass; completed teardown during a catalog outage remains green; typecheck and lint exit 0.

- [ ] **Step 7: Commit the complete Job admission module**

```bash
rtk git add src/admission.ts src/policy.ts src/shapes.ts src/handler.ts test/unit/admission.test.ts test/unit/shapes.test.ts test/integration/shapes.test.ts test/integration/reconcile.test.ts
rtk git commit -m "refactor: deepen job admission"
```

### Task 2: Record the domain term and complete verification

**Files:**
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: the completed Job admission module.
- Produces: one canonical glossary entry for future architecture work.

- [ ] **Step 1: Add Job admission to `CONTEXT.md`**

Insert after **Provisioning policy**:

```md
- **Job admission** — the ordered decision that turns a queued GitHub Job into a Pending Job the Coordinator may track: identify exactly one Runner label, apply Provisioning policy, then validate a shaped label against the lazily-loaded Shape catalog. Bare-label Jobs never consult the catalog. Webhook intake and the Reconciler use the same admission module; completed Jobs use label identification only, so teardown never depends on current policy or the catalog.
```

- [ ] **Step 2: Run the full repository checks**

```bash
rtk bun run lint
rtk bun run typecheck
rtk bun run test
rtk git diff --check
```

Expected: all commands exit 0 with no new warnings or whitespace errors.

- [ ] **Step 3: Commit the glossary update**

```bash
rtk git add CONTEXT.md
rtk git commit -m "docs: define job admission"
```

- [ ] **Step 4: Prepare the production smoke gate**

```bash
rtk bunx wrangler@latest deployments list
rtk gh workflow view ghar-test.yml
```

Expected: record the active version id and verify `ghar-test` is available. After the normal merge-to-main deployment, run the workflow, require green, and confirm its Sandbox is destroyed.
