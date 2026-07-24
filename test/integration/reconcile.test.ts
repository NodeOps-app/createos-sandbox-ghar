import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runReconciler, runReaper } from "../../src/reconcile";
import { resetShapeCacheForTests } from "../../src/shapes";
import { resetCredentialSessionsForTests } from "../../src/github/auth";
import { shapeCatalog, runnerName } from "../helpers/mocks";
import type { Bindings } from "../../src/index";
import type { TenantRecord } from "../../src/types";

// Both caches are module-level and outlive any single test. The shapes catalog:
// without the reset, whichever suite runs first decides what every later case
// silently exercises. The credential session: a warm session created by one
// case's patched fetch would otherwise serve its cached token to the next.
beforeEach(() => {
  resetShapeCacheForTests();
  resetCredentialSessionsForTests();
});

type Stub = ReturnType<typeof env.COORDINATOR.get>;
const stub = (name: string) => env.COORDINATOR.get(env.COORDINATOR.idFromName(name));
const job = (id: number) => ({
  jobId: id,
  runId: id,
  repoFullName: "nodeops-app/api",
  label: "createos",
  tenant: null,
});
async function boot(s: Stub, jobId: number, sandboxId: string) {
  await s.recordSandboxCreated(jobId, sandboxId, runnerName(jobId));
  await s.markRunning(jobId);
}

describe("reapUnregistered (runner-identity liveness)", () => {
  it("spares a running row whose runner is online", async () => {
    const s = stub("ru-online-" + Math.random());
    await s.onQueued(job(8001), "d1");
    await boot(s, 8001, "sb8001");
    const res = await s.reapUnregistered(Date.now() + 1, [runnerName(8001)], 0);
    expect(res.toDestroy).toEqual([]);
    expect(await s.activeCount()).toBe(1);
  });

  it("reaps a running row whose runner is absent past grace", async () => {
    const s = stub("ru-gone-" + Math.random());
    await s.onQueued(job(8002), "d2");
    await boot(s, 8002, "sb8002");
    const res = await s.reapUnregistered(Date.now() + 1, [], 0);
    expect(res.toDestroy).toContainEqual({ jobId: 8002, sandboxId: "sb8002", tenantId: null });
    expect(await s.activeCount()).toBe(0); // flipped to destroying → off the cap
  });

  it("drops a provisioning row that never booted a VM", async () => {
    const s = stub("ru-novm-" + Math.random());
    await s.onQueued(job(8003), "d3"); // provisioning, no sandbox_id yet
    const res = await s.reapUnregistered(Date.now() + 1, [], 0);
    expect(res.toDestroy).toEqual([]);
    expect(await s.activeCount()).toBe(0); // row deleted outright
  });

  it("spares a freshly booted runner still inside the grace window", async () => {
    const s = stub("ru-fresh-" + Math.random());
    await s.onQueued(job(8004), "d4");
    await boot(s, 8004, "sb8004");
    const res = await s.reapUnregistered(Date.now(), [], 3_600_000); // 1h grace, row is fresh
    expect(res.toDestroy).toEqual([]);
    expect(await s.activeCount()).toBe(1);
  });

  it("promotes a pending job into the slot a reaped runner-less VM frees", async () => {
    const s = stub("ru-promote-" + Math.random()); // test env cap MAX_CONCURRENT=2
    await s.onQueued(job(8101), "d5");
    await boot(s, 8101, "sb8101"); // running
    await s.onQueued(job(8102), "d6");
    await boot(s, 8102, "sb8102"); // running → at cap
    expect((await s.onQueued(job(8103), "d7")).action).toBe("queued"); // 8103 parked pending

    // 8101's runner is gone; 8102 still online → only 8101 reaped, freeing one slot.
    const res = await s.reapUnregistered(Date.now() + 1, [runnerName(8102)], 0);
    expect(res.toDestroy).toContainEqual({ jobId: 8101, sandboxId: "sb8101", tenantId: null });
    expect(res.nextPending).toContainEqual(job(8103)); // pending pulled into the freed slot
    expect(await s.activeCount()).toBe(2); // 8102 running + 8103 now provisioning
  });
});

const realFetch = globalThis.fetch;
type MockRunner = { id: number; name: string; status: string; busy?: boolean };
/**
 * Routes the GitHub reads runReconciler makes; everything else 404s. Returns the
 * ids the reconciler DELETEd, which is how the orphaned-runner sweep is asserted.
 */
function patchGitHub(
  over: {
    runners?: MockRunner[];
    jobs?: { id: number; status: string; labels: string[] }[];
    // Multi-repo installations: which repos the app sees, and each repo's own
    // queued jobs. Falls back to the single-repo `jobs` list above when
    // omitted — every existing case in this file stays on that flat path.
    repos?: string[];
    jobsByRepo?: Record<string, { id: number; status: string; labels: string[] }[]>;
  } = {},
): { deleted: number[] } {
  const runners = over.runners ?? [];
  const repos = over.repos ?? ["nodeops-app/api"];
  const jobs = over.jobs ?? [];
  const deleted: number[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = req.url;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("/access_tokens"))
      return json({ token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() }, 201);
    if (u.includes("generate-jitconfig")) return json({ encoded_jit_config: "BLOB" }, 201);
    if (req.method === "DELETE" && u.includes("/actions/runners/")) {
      deleted.push(Number(u.split("/actions/runners/")[1]));
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET" && u.includes("/actions/runners")) return json({ runners });
    if (u.includes("/installation/repositories"))
      return json({ repositories: repos.map((full_name) => ({ full_name })) });
    if (u.includes("/jobs")) {
      const repo = repos.find((r) => u.includes(`/repos/${r}/`));
      return json({ jobs: (repo && over.jobsByRepo?.[repo]) ?? jobs });
    }
    if (u.includes("/actions/runs"))
      return json({ workflow_runs: [{ id: 9000, status: "in_progress" }] });
    return new Response("unmocked " + u, { status: 404 });
  }) as typeof fetch;
  return { deleted };
}

/** A VM as createos lists it. Named `gha-ci-<jobId>` — see the sandbox-sweep suite. */
const vmName = (jobId: number) => `gha-ci-${jobId}`;
const vm = (name: string, status = "running") => ({
  id: `sb_${name}`,
  name,
  status,
  destroy: vi.fn().mockResolvedValue({ id: `sb_${name}`, status: "destroying" }),
});
const depsWith = (sandboxes: ReturnType<typeof vm>[]) => ({
  makeClient: () => ({
    createSandbox: vi.fn(),
    listShapes: vi.fn().mockResolvedValue(shapeCatalog()),
    getSandbox: vi
      .fn()
      .mockResolvedValue({ destroy: vi.fn(), getBandwidth: async () => ({ used_bytes: 0 }) }),
    listSandboxes: vi.fn().mockResolvedValue(sandboxes),
  }),
});

describe("runReconciler", () => {
  it("provisions a job GitHub reports queued but the DO never tracked", async () => {
    patchGitHub({ jobs: [{ id: 9001, status: "queued", labels: ["createos"] }] });
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb9001",
      runCommand: vi.fn().mockResolvedValue({ result: { stdout: "started" }, exec_ms: 1 }),
    });
    const ctx = createExecutionContext();
    // Every candidate this tick is the bare `createos` label, so runReconciler
    // must never fetch the shape catalog for it (isShapedLabel is false for
    // the bare label, so needsCatalog never trips) — the assertion below is
    // the proof.
    // listShapes/getSandbox/listSandboxes are still supplied so the makeClient
    // factory typechecks against CreateosClient's full surface, even though
    // none of them is called at runtime here.
    const listShapes = vi.fn().mockResolvedValue(shapeCatalog());
    await runReconciler(env as any, {
      makeClient: () => ({
        createSandbox,
        listShapes,
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    });
    await waitOnExecutionContext(ctx);
    expect(createSandbox).toHaveBeenCalledOnce();
    expect(listShapes).not.toHaveBeenCalled();
    globalThis.fetch = realFetch;
  });

  it("does not re-provision a job it is already tracking", async () => {
    const singleton = stub("singleton");
    await singleton.onQueued(job(9102), "seed");
    await boot(singleton, 9102, "sb9102"); // fresh running row
    patchGitHub({ jobs: [{ id: 9102, status: "queued", labels: ["createos"] }] });
    const createSandbox = vi.fn();
    const listShapes = vi.fn().mockResolvedValue(shapeCatalog());
    await runReconciler(env as any, {
      makeClient: () => ({
        createSandbox,
        listShapes,
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    });
    expect(createSandbox).not.toHaveBeenCalled();
    expect(listShapes).not.toHaveBeenCalled();
    globalThis.fetch = realFetch;
  });

  // Bug #1 (deferred from the security-audit backlog, closed by Task 9): a per-
  // job admission throw used to escape runReconciler entirely, skipping steps
  // C/D and — because index.ts awaits runReconciler then runReaper sequentially
  // — the reaper too. This single test proves the whole chain: the throwing
  // job is skipped (not the tick), the earlier job still admits, and step D +
  // the reaper (called the same way index.ts's `scheduled` calls them) both
  // still run in the same tick.
  it("an admission throw skips only that job — the earlier job still admits, and step D + the reaper still run", async () => {
    // fork-gated admission does a GitHub fork check per job. Run 9601's job
    // admits cleanly; run 9602's fork lookup returns a 200 with a non-JSON
    // body, so isForkJob's res.json() rejects and admission throws for THAT
    // job only. Runners list 500s so step A/C are skipped (unrelated to this
    // fix) and cannot themselves move the active count.
    const singleton = stub("singleton");
    const before = await singleton.activeCount();

    // A row already parked in `destroying` (onCompleted before its teardown
    // confirmed) — the reaper's sweep picks these up regardless of cutoff, the
    // same fixture reaper.test.ts uses for a deterministic reaper effect.
    await singleton.onQueued(job(96099), "d-96099");
    await boot(singleton, 96099, "sb96099");
    await singleton.onCompleted(96099, runnerName(96099));

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const u = req.url;
      if (u.includes("/access_tokens"))
        return new Response(
          JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() }),
          { status: 201 },
        );
      if (u.includes("/generate-jitconfig"))
        return new Response(JSON.stringify({ encoded_jit_config: "BLOB" }), { status: 201 });
      if (req.method === "GET" && u.includes("/actions/runners"))
        return new Response("boom", { status: 500 });
      if (u.includes("/installation/repositories"))
        return new Response(JSON.stringify({ repositories: [{ full_name: "nodeops-app/api" }] }));
      if (u.includes("/actions/runs/9601/jobs"))
        return new Response(
          JSON.stringify({ jobs: [{ id: 96011, status: "queued", labels: ["createos"] }] }),
        );
      if (u.includes("/actions/runs/9602/jobs"))
        return new Response(
          JSON.stringify({ jobs: [{ id: 96022, status: "queued", labels: ["createos"] }] }),
        );
      if (u.includes("status=queued"))
        return new Response(JSON.stringify({ workflow_runs: [{ id: 9601 }, { id: 9602 }] }));
      if (u.includes("status=in_progress"))
        return new Response(JSON.stringify({ workflow_runs: [] }));
      if (u.includes("/actions/runs/9602")) return new Response("<<not json>>", { status: 200 });
      if (u.includes("/actions/runs/9601"))
        return new Response(
          JSON.stringify({ head_repository: { fork: false, owner: { login: "nodeops-app" } } }),
        );
      return new Response("unmocked " + u, { status: 404 });
    }) as typeof fetch;

    const orphan = vm(vmName(9805)); // step D target: no Coordinator row owns it
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb96011",
      runCommand: vi.fn().mockResolvedValue({ result: { stdout: "started" }, exec_ms: 1 }),
    });
    const destroyReaped = vi.fn().mockResolvedValue({ id: "sb96099", status: "destroying" });
    const getSandbox = vi
      .fn()
      .mockResolvedValue({ destroy: destroyReaped, getBandwidth: async () => ({ used_bytes: 0 }) });
    const deps = {
      makeClient: () => ({
        createSandbox,
        listShapes: vi.fn().mockResolvedValue(shapeCatalog()),
        getSandbox,
        listSandboxes: vi.fn().mockResolvedValue([orphan]),
      }),
    };

    await expect(
      runReconciler({ ...env, PROVISION_POLICY: "fork-gated" } as any, deps),
    ).resolves.toBeUndefined();

    // 96011 admitted and provisioned — NOT swallowed by 96022's throw.
    expect(createSandbox).toHaveBeenCalledOnce();
    expect(await singleton.activeCount()).toBe(before + 1);
    // 96022's admission failure never reached the Coordinator — no row exists.
    await runInDurableObject(singleton, async (_i, state) => {
      const rows = state.storage.sql
        .exec(`SELECT COUNT(*) AS n FROM jobs WHERE job_id = ?`, 96022)
        .toArray() as { n: number }[];
      expect(rows[0]!.n).toBe(0);
    });
    // Step D ran despite the mid-tick throw: the GitHub-independent orphaned-
    // sandbox sweep destroyed the unowned VM.
    expect(orphan.destroy).toHaveBeenCalledOnce();

    // Mirrors index.ts's `scheduled`: the reaper runs right after the
    // reconciler, unconditionally. It still tears down 96099's parked row.
    await expect(runReaper(env as any, deps)).resolves.toBeUndefined();
    expect(destroyReaped).toHaveBeenCalledOnce();

    globalThis.fetch = realFetch;
  });

  it("skips the runner sweep when the runner list is unavailable", async () => {
    const singleton = stub("singleton");
    await singleton.onQueued(job(9200), "seed2");
    await boot(singleton, 9200, "sb9200");
    // Backdate is impossible here; instead prove a 500 on the runners list does
    // not throw and does not reap — reconciler still completes.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/access_tokens"))
        return new Response(
          JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() }),
          { status: 201 },
        );
      if (req.method === "GET" && req.url.includes("/actions/runners"))
        return new Response("boom", { status: 500 });
      if (req.url.includes("/installation/repositories"))
        return new Response(JSON.stringify({ repositories: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await expect(runReconciler(env as any, {})).resolves.toBeUndefined();
    expect(await singleton.activeCount()).toBe(1); // 9200 not reaped
    globalThis.fetch = realFetch;
  });

  it("provisions a shaped-label job, fetching the shape catalog once for the whole tick", async () => {
    // Two queued jobs (bare + shaped): if the catalog were fetched per job
    // instead of once for the tick, listShapes would show 2 calls, not 1.
    patchGitHub({
      jobs: [
        { id: 9401, status: "queued", labels: ["createos"] },
        { id: 9402, status: "queued", labels: ["createos-2vcpu-2gb"] },
      ],
    });
    const listShapes = vi
      .fn()
      .mockResolvedValue([{ id: "s-2vcpu-2gb", vcpu: 2, mem_mib: 2048, default_disk_mib: 10240 }]);
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb9402",
      runCommand: vi.fn().mockResolvedValue({ result: { stdout: "started" }, exec_ms: 1 }),
    });
    // No completions/reaping in this test, so getSandbox is never actually
    // called — but runReconciler's teardown path still requires it typewise.
    await runReconciler(env as any, {
      makeClient: () => ({
        listShapes,
        createSandbox,
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    });

    expect(createSandbox).toHaveBeenCalledTimes(2);
    expect(createSandbox).toHaveBeenCalledWith(expect.objectContaining({ shape: "s-2vcpu-2gb" }));
    expect(listShapes).toHaveBeenCalledTimes(1);
    globalThis.fetch = realFetch;
  });

  // Fix 1: policy must be evaluated before the shape catalog is fetched. A
  // tick whose only shaped candidates are all policy-blocked must never
  // touch the shapes API.
  it("skips the shape catalog entirely when every shaped candidate is policy-blocked", async () => {
    patchGitHub({
      jobs: [{ id: 9501, status: "queued", labels: ["createos-2vcpu-2gb"] }],
    });
    const listShapes = vi.fn().mockResolvedValue(shapeCatalog());
    const createSandbox = vi.fn();
    const blockedEnv = {
      ...env,
      PROVISION_POLICY: "repo-allowlist",
      REPO_ALLOWLIST: "someone/else",
    };

    await runReconciler(blockedEnv as any, {
      makeClient: () => ({
        listShapes,
        createSandbox,
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    });

    expect(listShapes).not.toHaveBeenCalled();
    expect(createSandbox).not.toHaveBeenCalled();
    globalThis.fetch = realFetch;
  });

  // Fix 2: the previous two tests cover "all shaped candidates blocked" and
  // "bare + shaped, both eligible" separately, but never a tick with both an
  // eligible and a blocked shaped candidate together. The catalog must still
  // be fetched exactly once (for the eligible one), and only the eligible
  // job's createSandbox must fire — the blocked one must never reach it.
  it("fetches the catalog once and boots only the eligible job when one of two shaped candidates is policy-blocked", async () => {
    patchGitHub({
      repos: ["nodeops-app/api", "nodeops-app/other"],
      jobsByRepo: {
        "nodeops-app/api": [{ id: 9601, status: "queued", labels: ["createos-2vcpu-2gb"] }],
        "nodeops-app/other": [{ id: 9602, status: "queued", labels: ["createos-2vcpu-2gb"] }],
      },
    });
    const listShapes = vi.fn().mockResolvedValue(shapeCatalog());
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb9601",
      runCommand: vi.fn().mockResolvedValue({ result: { stdout: "started" }, exec_ms: 1 }),
    });
    const blockedEnv = {
      ...env,
      PROVISION_POLICY: "repo-allowlist",
      REPO_ALLOWLIST: "nodeops-app/api",
    };

    await runReconciler(blockedEnv as any, {
      makeClient: () => ({
        listShapes,
        createSandbox,
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    });

    expect(listShapes).toHaveBeenCalledTimes(1);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(createSandbox).toHaveBeenCalledWith(expect.objectContaining({ shape: "s-2vcpu-2gb" }));
    globalThis.fetch = realFetch;
  });
});

/**
 * The sweep deletes GitHub runner registrations for jobs that never completed
 * one — GitHub only auto-removes an ephemeral runner that finished a job, so
 * without this they pile up `offline` forever.
 *
 * It runs against the SINGLETON Coordinator (that is the DO runReconciler talks
 * to), so these seed `stub("singleton")`. Job ids are 97xx to stay clear of the
 * rows earlier tests in this file leave behind on that same singleton.
 */
describe("runReconciler — orphaned runner sweep", () => {
  const deps = () => ({
    makeClient: () => ({
      createSandbox: vi.fn(),
      listShapes: vi.fn().mockResolvedValue(shapeCatalog()),
      getSandbox: vi
        .fn()
        .mockResolvedValue({ destroy: vi.fn(), getBandwidth: async () => ({ used_bytes: 0 }) }),
      listSandboxes: vi.fn().mockResolvedValue([]),
    }),
  });

  it("deletes an offline runner whose job the DO no longer tracks", async () => {
    // No row for 9701 anywhere → nothing is coming to claim this registration.
    const gh = patchGitHub({
      runners: [{ id: 41, name: runnerName(9701), status: "offline" }],
    });
    await runReconciler(env as any, deps());
    expect(gh.deleted).toEqual([41]);
    globalThis.fetch = realFetch;
  });

  it("spares an offline runner whose job the DO still tracks — the mid-boot window", async () => {
    // THE safety property. onQueued inserts the row before the JIT is minted, and
    // the VM takes ~30s to boot, so a perfectly healthy runner looks exactly like
    // an orphan to GitHub (offline, not busy) for that whole window. Only the DO
    // row tells them apart. Get this wrong and the sweeper eats live boots.
    const singleton = stub("singleton");
    await singleton.onQueued(job(9702), "sweep-inflight"); // provisioning, no VM yet
    const gh = patchGitHub({
      runners: [{ id: 42, name: runnerName(9702, "bb"), status: "offline" }],
    });
    await runReconciler(env as any, deps());
    expect(gh.deleted).toEqual([]);
    globalThis.fetch = realFetch;
  });

  it("never deletes a runner it did not mint", async () => {
    // An ARC runner (or any hand-registered box) is offline and untracked — it
    // passes every test except ownership. The name is the only thing standing
    // between it and deletion, so this is the guard that keeps us out of other
    // people's runner pools.
    const gh = patchGitHub({
      runners: [
        { id: 43, name: "arc-runner-set-bvlbx-runner-c7n4v", status: "offline" },
        { id: 44, name: "some-bare-metal-box", status: "offline" },
        { id: 45, name: `not-a-job-id`, status: "offline" },
        { id: 46, name: runnerName(9703, "cc"), status: "offline" }, // ours → the control
      ],
    });
    await runReconciler(env as any, deps());
    expect(gh.deleted).toEqual([46]);
    globalThis.fetch = realFetch;
  });

  it("spares online and busy runners", async () => {
    const gh = patchGitHub({
      runners: [
        { id: 47, name: runnerName(9704, "dd"), status: "online" },
        { id: 48, name: runnerName(9705, "ee"), status: "offline", busy: true },
      ],
    });
    await runReconciler(env as any, deps());
    expect(gh.deleted).toEqual([]);
    globalThis.fetch = realFetch;
  });
});

/**
 * The orphaned-SANDBOX sweep: the last line of defence against a leaked VM, and
 * the only teardown path that still works when the DO is what failed. Every other
 * path records a `destroying` row first, which needs the Coordinator reachable at
 * the moment of the failure. This one re-derives ownership from the VM's name.
 *
 * It matters more than the runner sweep: a leaked registration is clutter, but a
 * leaked VM never self-deletes (its runner never launched) and burns capacity for
 * as long as it lives.
 *
 * VM names come from SANDBOX_NAME_PREFIX (`gha-ci` in wrangler.toml, which the
 * test env loads), so a VM is named `gha-ci-<jobId>` — NOT after its runner.
 */
describe("runReconciler — orphaned sandbox sweep", () => {
  it("destroys a VM the DO holds no row for", async () => {
    patchGitHub();
    const orphan = vm(vmName(9801));
    await runReconciler(env as any, depsWith([orphan]));
    expect(orphan.destroy).toHaveBeenCalledOnce();
    globalThis.fetch = realFetch;
  });

  it("spares a VM whose job the DO still tracks — the mid-boot window", async () => {
    // THE safety property, same as the runner sweep: onQueued inserts the row
    // BEFORE createRunnerSandbox creates the VM, so a VM that is merely booting
    // always has a live row. Drop this check and the sweep eats live jobs.
    const singleton = stub("singleton");
    await singleton.onQueued(job(9802), "sb-sweep-inflight");
    patchGitHub();
    const booting = vm(vmName(9802));
    await runReconciler(env as any, depsWith([booting]));
    expect(booting.destroy).not.toHaveBeenCalled();
    globalThis.fetch = realFetch;
  });

  it("never destroys a VM it did not create", async () => {
    // The createos account also holds hand-made boxes and other projects' VMs.
    // The name is the only thing standing between them and a destroy call.
    patchGitHub();
    const strangers = [
      vm("friendly-heyrovsky"),
      vm("cos-tuntest"),
      vm("staging-db-123"),
      vm("ghar-runner"),
    ];
    await runReconciler(env as any, depsWith(strangers));
    for (const s of strangers) expect(s.destroy).not.toHaveBeenCalled();
    globalThis.fetch = realFetch;
  });

  it("ignores VMs that are already gone", async () => {
    patchGitHub();
    const dead = vm(vmName(9803), "destroyed");
    await runReconciler(env as any, depsWith([dead]));
    expect(dead.destroy).not.toHaveBeenCalled();
    globalThis.fetch = realFetch;
  });

  it("still runs when GitHub is down — the leaks it cleans up are not GitHub's", async () => {
    // Steps A/B/C all depend on GitHub reads. This one must not: a VM leaked by a
    // failed DO call has nothing to do with GitHub, and capacity keeps burning
    // during an outage.
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const orphan = vm(vmName(9804));
    await runReconciler(env as any, depsWith([orphan]));
    expect(orphan.destroy).toHaveBeenCalledOnce();
    globalThis.fetch = realFetch;
  });
});

/**
 * Multi-tenant reconciler (Task 9): `runReconciler` behind TENANCY_MODE=multi.
 * Recovery re-enters every discovered job through `admitAndDrive` — the same
 * gate ladder the webhook uses (see tenancy-webhook.test.ts) — so these cases
 * focus on what's NEW here: per-tenant rotation, the all-or-nothing runner
 * union, and the shared cross-tenant subrequest budget.
 *
 * All three tests share the file's one singleton Coordinator (`coordinator()`
 * always resolves the same DO name), so each test revokes the tenants it
 * created before returning — otherwise a later test's `adminListTenants()`
 * would see them too and its subrequest-budget arithmetic would be off by
 * however many extra (empty-repo) tenants leaked in.
 */
describe("runReconciler — multi-tenant mode", () => {
  const multiEnv = (over: Record<string, unknown> = {}) =>
    ({ ...env, TENANCY_MODE: "multi", ...over }) as unknown as Bindings;

  const approvedTenant = (id: number, over: Partial<TenantRecord> = {}): TenantRecord => ({
    installationId: id,
    orgLogin: `mt-org-${id}`,
    status: "approved",
    allowAllRepos: false,
    minuteGrant: 100_000,
    concurrencyCap: 5,
    maxShape: "s-4vcpu-8gb",
    jobTtlMs: 1_800_000,
    runnerGroupId: 42,
    contact: null,
    notes: null,
    approvedAt: 1,
    approvedBy: "op",
    ...over,
  });

  // Reuses the file-level MockRunner type (identical shape) — see line 91.
  type MockJob = { id: number; status: string; labels: string[] };

  /**
   * Routes GitHub calls for N tenants keyed by installation id. The token
   * endpoint is installation-scoped by URL, so the mint mock ties the minted
   * token to the requesting installation; every other call (runners, repo
   * list, run/job listings) is then resolved off THAT bearer token, because
   * `/installation/repositories` carries no org or repo in its URL — the
   * token is the only thing distinguishing tenants there.
   */
  function patchMultiGitHub(
    tenants: Record<
      number,
      {
        org: string;
        runners?: MockRunner[] | number; // number = simulate this HTTP status
        repos?: string[];
        reposStatus?: number; // simulate installation/repositories failing
        jobsByRepo?: Record<string, MockJob[]>;
      }
    >,
  ): { deleted: number[] } {
    const deleted: number[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const u = req.url;
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

      const tokenMatch = u.match(/\/app\/installations\/(\d+)\/access_tokens/);
      if (tokenMatch) {
        return json(
          {
            token: `tok-${tokenMatch[1]}`,
            expires_at: new Date(Date.now() + 3.6e6).toISOString(),
          },
          201,
        );
      }
      const instId = Number((req.headers.get("Authorization") ?? "").replace("Bearer tok-", ""));
      const t = tenants[instId];

      if (u.includes("generate-jitconfig")) return json({ encoded_jit_config: "BLOB" }, 201);
      if (req.method === "DELETE" && u.includes("/actions/runners/")) {
        deleted.push(Number(u.split("/actions/runners/")[1]));
        return new Response(null, { status: 204 });
      }
      if (req.method === "GET" && u.includes("/actions/runners")) {
        if (typeof t?.runners === "number") return new Response("boom", { status: t.runners });
        return json({ runners: t?.runners ?? [] });
      }
      if (u.includes("/installation/repositories")) {
        if (typeof t?.reposStatus === "number")
          return new Response("boom", { status: t.reposStatus });
        return json({ repositories: (t?.repos ?? []).map((full_name) => ({ full_name })) });
      }
      if (u.includes("/jobs")) {
        const repo = (t?.repos ?? []).find((r) => u.includes(`/repos/${r}/`));
        return json({ jobs: (repo && t?.jobsByRepo?.[repo]) ?? [] });
      }
      if (u.includes("/actions/runs")) {
        if (u.includes("status=in_progress")) return json({ workflow_runs: [] });
        // status=queued: only fabricate an active run for a repo that actually
        // has jobs configured, so cursor-only tests (no jobsByRepo) cost
        // exactly 2 subrequests/repo (both status reads, no job fetch).
        const repo = (t?.repos ?? []).find((r) => u.includes(`/repos/${r}/`));
        const hasJobs = repo !== undefined && (t?.jobsByRepo?.[repo]?.length ?? 0) > 0;
        return json({ workflow_runs: hasJobs ? [{ id: 9000, status: "queued" }] : [] });
      }
      return new Response("unmocked " + u, { status: 404 });
    }) as typeof fetch;
    return { deleted };
  }

  it("recovery admits a queued job from an approved project and refuses one from an unapproved repo", async () => {
    const s = stub("singleton");
    await s.adminUpsertTenant(approvedTenant(40001));
    await s.adminAddProjects(40001, [{ repoFullName: "mt-org-40001/api", repoId: 1 }]);

    patchMultiGitHub({
      40001: {
        org: "mt-org-40001",
        repos: ["mt-org-40001/api", "mt-org-40001/other"],
        jobsByRepo: {
          "mt-org-40001/api": [{ id: 400011, status: "queued", labels: ["createos"] }],
          "mt-org-40001/other": [{ id: 400022, status: "queued", labels: ["createos"] }],
        },
      },
    });

    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb400011",
      runCommand: vi.fn().mockResolvedValue({ result: { stdout: "started" }, exec_ms: 1 }),
    });
    await runReconciler(multiEnv(), {
      makeClient: () => ({
        createSandbox,
        listShapes: vi.fn().mockResolvedValue(shapeCatalog()),
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    });

    // mt-org-40001/api is an approved project → admits and provisions.
    expect(createSandbox).toHaveBeenCalledOnce();
    await runInDurableObject(s, async (_i, state) => {
      const approved = state.storage.sql
        .exec(`SELECT COUNT(*) AS n FROM jobs WHERE job_id = ?`, 400011)
        .toArray() as { n: number }[];
      expect(approved[0]!.n).toBe(1);
      // mt-org-40001/other was never added as a project → repo-not-approved,
      // refused before admitAndDrive ever calls onQueued — no row inserted.
      const refused = state.storage.sql
        .exec(`SELECT COUNT(*) AS n FROM jobs WHERE job_id = ?`, 400022)
        .toArray() as { n: number }[];
      expect(refused[0]!.n).toBe(0);
    });

    await s.adminSetTenantStatus(40001, "revoked"); // keep later tests' tenant list clean
    globalThis.fetch = realFetch;
  });

  it("step A is all-or-nothing: one tenant's listRunners failure spares every tenant's stale row", async () => {
    const s = stub("singleton");
    await s.adminUpsertTenant(approvedTenant(40101));
    await s.adminUpsertTenant(approvedTenant(40102));

    await s.onQueued(job(97001), "d-97001");
    await boot(s, 97001, "sb97001"); // running; its runner is NOT in tenant A's online list below

    patchMultiGitHub({
      40101: { org: "mt-org-40101", runners: [{ id: 1, name: "someone-else", status: "online" }] },
      40102: { org: "mt-org-40102", runners: 500 }, // tenant B's list fails
    });

    await expect(runReconciler(multiEnv(), {})).resolves.toBeUndefined();
    // A partial union would read 97001's runner as absent (it's not in tenant
    // A's list, and tenant B's list never loaded) and reap it. The whole step
    // must be skipped instead — 97001 survives.
    expect(await s.activeCount()).toBe(1);

    await s.adminSetTenantStatus(40101, "revoked");
    await s.adminSetTenantStatus(40102, "revoked");
    globalThis.fetch = realFetch;
  });

  it("recovery cursor round-trips across tenants: tick 1 stops mid-tenant-A, tick 2 resumes A then covers B", async () => {
    const s = stub("singleton");
    await s.adminUpsertTenant(approvedTenant(40201));
    await s.adminUpsertTenant(approvedTenant(40202));
    patchMultiGitHub({
      40201: { org: "mt-org-40201", repos: ["mt-org-40201/r1", "mt-org-40201/r2"] },
      40202: { org: "mt-org-40202", repos: ["mt-org-40202/r1"] },
    });

    // Cost per repo here is 2 subrequests (activeRunIds' two status reads; no
    // jobsByRepo means queuedJobs is never reached) plus 1 for the tenant's
    // own installationRepos() call. Budget=3 covers tenant A's r1 (spent: 1 +
    // 2 = 3) and hits the boundary check (3 >= 3) before r2 — budget-bound at
    // tenant A, tenant B never reached this tick.
    await runReconciler(multiEnv({ RECOVERY_SUBREQUEST_BUDGET: "3" }), {});
    expect(await s.recoveryCursor()).toBe(
      JSON.stringify({ installationId: 40201, repo: "mt-org-40201/r1" }),
    );

    // Tick 2: rotation resumes AT tenant A (per its stored repo cursor, so it
    // picks up r2), a generous budget lets it finish A's remaining repo AND
    // roll into tenant B, which the persisted cursor now reflects.
    await runReconciler(multiEnv({ RECOVERY_SUBREQUEST_BUDGET: "20" }), {});
    expect(await s.recoveryCursor()).toBe(
      JSON.stringify({ installationId: 40202, repo: "mt-org-40202/r1" }),
    );

    await s.adminSetTenantStatus(40201, "revoked");
    await s.adminSetTenantStatus(40202, "revoked");
    globalThis.fetch = realFetch;
  });

  // Bug 4: a per-tenant discovery throw used to escape runMultiTenantReconciler
  // entirely, taking steps C and D down with it. Tenant A's installationRepos()
  // read 500s (discoverQueuedJobs throws); tenant B must still get its recovery
  // turn, and step D — GitHub-independent by design — must still run.
  it("a per-tenant discovery throw skips only that tenant — recovery continues and step D still runs", async () => {
    const s = stub("singleton");
    await s.adminUpsertTenant(approvedTenant(50301));
    await s.adminUpsertTenant(approvedTenant(50302));
    await s.adminAddProjects(50302, [{ repoFullName: "mt-org-50302/api", repoId: 1 }]);

    patchMultiGitHub({
      50301: { org: "mt-org-50301", runners: [], reposStatus: 500 },
      50302: {
        org: "mt-org-50302",
        runners: [],
        repos: ["mt-org-50302/api"],
        jobsByRepo: {
          "mt-org-50302/api": [{ id: 503021, status: "queued", labels: ["createos"] }],
        },
      },
    });

    const orphan = vm(vmName(50399));
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb503021",
      runCommand: vi.fn().mockResolvedValue({ result: { stdout: "started" }, exec_ms: 1 }),
    });
    const deps = {
      makeClient: () => ({
        createSandbox,
        listShapes: vi.fn().mockResolvedValue(shapeCatalog()),
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([orphan]),
      }),
    };

    await expect(runReconciler(multiEnv(), deps)).resolves.toBeUndefined();

    // Tenant B's recovery still ran despite tenant A's discovery throw.
    expect(createSandbox).toHaveBeenCalledOnce();
    // Step D — never gated on GitHub — still ran despite the mid-loop throw.
    expect(orphan.destroy).toHaveBeenCalledOnce();

    await s.adminSetTenantStatus(50301, "revoked");
    await s.adminSetTenantStatus(50302, "revoked");
    globalThis.fetch = realFetch;
  });

  // Bug 5: recovery used to hand provisioning to a synthetic ctx with no real
  // ExecutionContext behind it, so it was never actually awaited inside the
  // invocation. createSandbox resolves after a real macrotask delay here — if
  // the provision were still fire-and-forgotten, `await runReconciler` could
  // return before this delayed call ever fires.
  it("a recovery-admitted job's provision completes within the reconciler invocation", async () => {
    const s = stub("singleton");
    await s.adminUpsertTenant(approvedTenant(50401));
    await s.adminAddProjects(50401, [{ repoFullName: "mt-org-50401/api", repoId: 1 }]);

    patchMultiGitHub({
      50401: {
        org: "mt-org-50401",
        runners: [],
        repos: ["mt-org-50401/api"],
        jobsByRepo: {
          "mt-org-50401/api": [{ id: 504011, status: "queued", labels: ["createos"] }],
        },
      },
    });

    const createSandbox = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                id: "sb504011",
                runCommand: vi
                  .fn()
                  .mockResolvedValue({ result: { stdout: "started" }, exec_ms: 1 }),
              }),
            5,
          ),
        ),
    );
    const deps = {
      makeClient: () => ({
        createSandbox,
        listShapes: vi.fn().mockResolvedValue(shapeCatalog()),
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    };

    await runReconciler(multiEnv(), deps);

    expect(createSandbox).toHaveBeenCalledOnce();

    await s.adminSetTenantStatus(50401, "revoked");
    globalThis.fetch = realFetch;
  });

  // Bug 6: MAX_RUNNER_DELETES_PER_TICK must be a budget SHARED across tenants,
  // not applied independently per tenant — otherwise N tenants multiply it into
  // N×10 DELETE subrequests in one tick.
  it("the orphaned-runner delete cap is shared across tenants, not per-tenant", async () => {
    const s = stub("singleton");
    await s.adminUpsertTenant(approvedTenant(50501));
    await s.adminUpsertTenant(approvedTenant(50502));

    const orphansFor = (base: number, count: number): MockRunner[] =>
      Array.from({ length: count }, (_, i) => ({
        id: base + i,
        name: runnerName(base + i),
        status: "offline",
      }));

    const gh = patchMultiGitHub({
      50501: { org: "mt-org-50501", runners: orphansFor(60001, 12) },
      50502: { org: "mt-org-50502", runners: orphansFor(60101, 12) },
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runReconciler(multiEnv(), {})).resolves.toBeUndefined();

    // 24 orphans exist across both tenants, but only MAX_RUNNER_DELETES_PER_TICK
    // (10) may be spent this tick — shared, not 10 per tenant.
    expect(gh.deleted.length).toBe(10);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("shared orphaned-runner delete budget")),
    ).toBe(true);
    warn.mockRestore();

    await s.adminSetTenantStatus(50501, "revoked");
    await s.adminSetTenantStatus(50502, "revoked");
    globalThis.fetch = realFetch;
  });
});
