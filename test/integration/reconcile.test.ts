import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runReconciler } from "../../src/handler";
import { resetShapeCacheForTests } from "../../src/shapes";
import { shapeCatalog } from "../helpers/mocks";

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
  await s.recordSandboxCreated(jobId, sandboxId, `ghar-${jobId}`);
  await s.markRunning(jobId);
}

describe("reapUnregistered (runner-identity liveness)", () => {
  it("spares a running row whose runner is online", async () => {
    const s = stub("ru-online-" + Math.random());
    await s.onQueued(job(8001), "d1");
    await boot(s, 8001, "sb8001");
    const res = await s.reapUnregistered(Date.now() + 1, ["ghar-8001"], 0);
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
    const res = await s.reapUnregistered(Date.now() + 1, ["ghar-8102"], 0);
    expect(res.toDestroy).toContainEqual({ jobId: 8101, sandboxId: "sb8101" });
    expect(res.nextPending).toContainEqual(job(8103)); // pending pulled into the freed slot
    expect(await s.activeCount()).toBe(2); // 8102 running + 8103 now provisioning
  });
});

const realFetch = globalThis.fetch;
/** Routes the GitHub reads runReconciler makes; everything else 404s. */
function patchGitHub(
  over: {
    runners?: { name: string; status: string }[];
    jobs?: { id: number; status: string; labels: string[] }[];
  } = {},
) {
  const runners = over.runners ?? [];
  const jobs = over.jobs ?? [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = req.url;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("/access_tokens"))
      return json({ token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() }, 201);
    if (u.includes("generate-jitconfig")) return json({ encoded_jit_config: "BLOB" }, 201);
    if (req.method === "GET" && u.includes("/actions/runners")) return json({ runners });
    if (u.includes("/installation/repositories"))
      return json({ repositories: [{ full_name: "nodeops-app/api" }] });
    if (u.includes("/jobs")) return json({ jobs });
    if (u.includes("/actions/runs"))
      return json({ workflow_runs: [{ id: 9000, status: "in_progress" }] });
    return new Response("unmocked " + u, { status: 404 });
  }) as typeof fetch;
}

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
    // listShapes/getSandbox are still supplied so the makeClient factory
    // typechecks against CreateosClient's full surface, even though neither is
    // called at runtime here.
    const listShapes = vi.fn().mockResolvedValue(shapeCatalog());
    await runReconciler(env as any, {
      makeClient: () => ({ createSandbox, listShapes, getSandbox: vi.fn() }),
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
      makeClient: () => ({ createSandbox, listShapes, getSandbox: vi.fn() }),
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
      makeClient: () => ({ listShapes, createSandbox, getSandbox: vi.fn() }),
    });

    expect(createSandbox).toHaveBeenCalledTimes(2);
    expect(createSandbox).toHaveBeenCalledWith(expect.objectContaining({ shape: "s-2vcpu-2gb" }));
    expect(listShapes).toHaveBeenCalledTimes(1);
    globalThis.fetch = realFetch;
  });
});
