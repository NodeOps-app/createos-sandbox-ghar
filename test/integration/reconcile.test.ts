import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runReconciler } from "../../src/handler";
import { resetShapeCacheForTests } from "../../src/shapes";
import { shapeCatalog, runnerName } from "../helpers/mocks";

// The shapes.ts catalog cache is module-level and outlives any single test —
// without this, whichever suite runs first (bare-label fallback here vs. a
// real catalog elsewhere) decides what every later case silently exercises.
beforeEach(() => {
  resetShapeCacheForTests();
});

type Stub = ReturnType<typeof env.COORDINATOR.get>;
const stub = (name: string) => env.COORDINATOR.get(env.COORDINATOR.idFromName(name));
const job = (id: number) => ({
  jobId: id,
  runId: id,
  repoFullName: "nodeops-app/api",
  label: "createos",
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
    expect(res.toDestroy).toContainEqual({ jobId: 8002, sandboxId: "sb8002" });
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
    expect(res.toDestroy).toContainEqual({ jobId: 8101, sandboxId: "sb8101" });
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
    getSandbox: vi.fn().mockResolvedValue({ destroy: vi.fn() }),
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
      getSandbox: vi.fn().mockResolvedValue({ destroy: vi.fn() }),
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
