import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreateosSandboxValidationError } from "@nodeops-createos/sandbox";
import { handleWebhook } from "../../src/handler";
import { runReconciler } from "../../src/reconcile";
import type { SandboxDeps } from "../../src/createos";
import { resetShapeCacheForTests } from "../../src/shapes";
import { sign, workflowJobPayload } from "../helpers/fixtures";
import { shapeCatalog, runnerName, mockFetch, githubRoutes } from "../helpers/mocks";

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

async function post(body: string, delivery: string, deps: SandboxDeps, envOverride: unknown = env) {
  const req = new Request("https://ctrl.local/webhook", {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": await sign(env.GITHUB_WEBHOOK_SECRET as string, body),
      "X-GitHub-Delivery": delivery,
    },
    body,
  });
  const ctx = createExecutionContext();
  const res = await handleWebhook(req, envOverride as never, ctx, deps);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => {
  resetShapeCacheForTests();
  patchGitHub();
});

describe("shape labels end-to-end", () => {
  // Test 1 (job 700) and test 3 (job 702) each hold one provisioning/running
  // slot in the shared singleton Coordinator DO for the run of the file — this
  // file needs at least 2 free concurrency slots. MAX_CONCURRENT is 2 in
  // vitest.config.ts, so together they exactly saturate it.
  it("a shaped label boots a VM of that shape", async () => {
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb_shaped",
      runCommand: vi.fn().mockResolvedValue({ result: { exit_code: 0 } }),
    });
    const deps = {
      makeClient: () => ({
        createSandbox,
        listShapes: async () => shapeCatalog(),
        getSandbox: vi.fn(),
        listSandboxes: async () => [],
      }),
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
      makeClient: () => ({
        createSandbox,
        listShapes: async () => shapeCatalog(),
        getSandbox: vi.fn(),
        listSandboxes: async () => [],
      }),
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
      // Pinned only for a realistic runnerName in the completed payload below;
      // this file has one row per job, so job_id and runner_name lookups would
      // resolve identically either way — this test isn't distinguishing them.
      attemptId: () => "aa",
      makeClient: () => ({
        createSandbox,
        listShapes: async () => shapeCatalog(),
        getSandbox: async () => ({ destroy }),
        listSandboxes: async () => [],
      }),
    };
    await post(
      workflowJobPayload({ action: "queued", jobId: 702, labels: ["createos-2vcpu-2gb"] }),
      "dlv-t1",
      healthy,
    );

    // Now the catalog is unreachable. `completed` must still destroy the VM:
    // the teardown path never consults the shape catalog, so a shapes-API
    // outage can't leak this VM.
    resetShapeCacheForTests();
    const downCreate = vi.fn();
    const down = {
      makeClient: () => ({
        // Inert: a `completed` webhook must never provision. Asserted below.
        createSandbox: downCreate,
        listShapes: async () => {
          throw new Error("503");
        },
        getSandbox: async () => ({ destroy }),
        listSandboxes: async () => [],
      }),
    };
    const res = await post(
      workflowJobPayload({
        action: "completed",
        jobId: 702,
        labels: ["createos-2vcpu-2gb"],
        runnerName: runnerName(702),
      }),
      "dlv-t2",
      down,
    );

    expect(await res.text()).toBe("completed");
    expect(destroy).toHaveBeenCalled();
    expect(downCreate).not.toHaveBeenCalled();
  });

  // Fix 4: a shaped job admitted while its shape existed can be promoted later
  // (its shape having since vanished from the platform) with no re-validation
  // by design — the SDK's createSandbox rejects the unknown shape, and that
  // must fail the provision safely rather than boot a wrong-size VM.
  it("a promoted shaped job whose shape vanished fails safely, not with a wrong-size VM", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));

    const fillerCreate = vi.fn().mockResolvedValue({
      id: "sb_filler",
      runCommand: vi.fn().mockResolvedValue({ result: { exit_code: 0 } }),
    });
    const fillerDeps = {
      makeClient: () => ({
        createSandbox: fillerCreate,
        listShapes: async () => shapeCatalog(),
        getSandbox: vi.fn(),
        listSandboxes: async () => [],
      }),
    };

    // Saturate MAX_CONCURRENT (2) with filler bare-label jobs, regardless of
    // however much capacity earlier cases in this file already left occupied.
    const fillers: number[] = [];
    let nextId = 810;
    while ((await co.activeCount()) < 2) {
      const id = nextId++;
      fillers.push(id);
      await post(
        workflowJobPayload({ action: "queued", jobId: id, labels: ["createos"] }),
        `dlv-filler-${id}`,
        fillerDeps,
      );
    }
    expect(await co.activeCount()).toBe(2);

    // Park our shaped job behind the cap — admitted now (its shape exists),
    // but no free slot to boot into.
    const shapedJobId = nextId++;
    const shapedRes = await post(
      workflowJobPayload({ action: "queued", jobId: shapedJobId, labels: ["createos-2vcpu-2gb"] }),
      `dlv-shaped-${shapedJobId}`,
      fillerDeps,
    );
    expect(await shapedRes.text()).toBe("queued");

    // Park a second job behind it, so a successful promotion after the shaped
    // job's failure is observable.
    const behindJobId = nextId++;
    await post(
      workflowJobPayload({ action: "queued", jobId: behindJobId, labels: ["createos"] }),
      `dlv-behind-${behindJobId}`,
      fillerDeps,
    );

    // Free one slot by completing the first filler (job_id lookup — the
    // completed payload carries no runner_name, same as a job that never
    // registered a runner). The DO promotes the oldest pending row — our
    // shaped job — into the freed slot.
    const destroy = vi.fn().mockResolvedValue(undefined);
    const promoteCreate = vi.fn(async (opts: { shape: string }) => {
      if (opts.shape === "s-2vcpu-2gb") {
        throw new CreateosSandboxValidationError(
          "unknown shape",
          new Response(null, { status: 422 }),
        );
      }
      return {
        id: "sb_promoted",
        runCommand: vi.fn().mockResolvedValue({ result: { exit_code: 0 } }),
      };
    });
    const completeDeps = {
      makeClient: () => ({
        getSandbox: async () => ({ destroy }),
        createSandbox: promoteCreate,
        listShapes: async () => shapeCatalog(),
        listSandboxes: async () => [],
      }),
    };
    const completedRes = await post(
      workflowJobPayload({ action: "completed", jobId: fillers[0]! }),
      `dlv-complete-${fillers[0]}`,
      completeDeps,
    );
    expect(await completedRes.text()).toBe("completed");

    // The shaped job's createSandbox rejected (shape gone) → provisionAndRecord
    // caught it → failProvision ran: logged + alerted, freed the slot, and
    // promoted the job behind it with ITS OWN shape — never falling back to a
    // default-size VM for the job whose shape vanished.
    expect(promoteCreate).toHaveBeenCalledWith(expect.objectContaining({ shape: "s-2vcpu-2gb" }));
    expect(promoteCreate).toHaveBeenCalledWith(expect.objectContaining({ shape: "s-4vcpu-4gb" }));
    expect(
      error.mock.calls.some((c) => String(c[0]).includes(`provision failed job=${shapedJobId}`)),
    ).toBe(true);

    const rows = await runInDurableObject(co, (_instance, state) =>
      state.storage.sql
        .exec<{ job_id: number; state: string }>(
          `SELECT job_id, state FROM jobs WHERE job_id IN (?, ?)`,
          shapedJobId,
          behindJobId,
        )
        .toArray(),
    );
    expect(rows.find((r) => r.job_id === shapedJobId)).toBeUndefined(); // slot freed, row gone
    expect(rows.find((r) => r.job_id === behindJobId)?.state).toBe("running"); // promoted + booted
  });

  it("a shaped label is refused with catalog-unavailable when the shapes API is down, burning no slot", async () => {
    const createSandbox = vi.fn();
    const deps = {
      makeClient: () => ({
        createSandbox,
        listShapes: async () => {
          throw new Error("503");
        },
        getSandbox: vi.fn(),
        listSandboxes: async () => [],
      }),
    };

    // Delta, not absolute — see the note on test 2 above.
    const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
    const before = await co.activeCount();

    const body = workflowJobPayload({
      action: "queued",
      jobId: 703,
      labels: ["createos-2vcpu-2gb"],
    });
    const res = await post(body, "dlv-catalog-down", deps);

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("catalog-unavailable");
    expect(createSandbox).not.toHaveBeenCalled();
    expect(await co.activeCount()).toBe(before);
  });

  // Fix 1: policy must be evaluated before the shape catalog is fetched. A
  // job blocked by repo-allowlist must never reach the shapes API — and it
  // must report policy-skip, not whatever the (never-attempted) catalog
  // fetch would have said.
  it("a repo-allowlist-blocked job carrying a shaped label returns policy-skip and never calls listShapes", async () => {
    const createSandbox = vi.fn();
    const listShapes = vi.fn().mockResolvedValue(shapeCatalog());
    const deps = {
      makeClient: () => ({
        createSandbox,
        listShapes,
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    };
    const blockedEnv = {
      ...env,
      PROVISION_POLICY: "repo-allowlist",
      REPO_ALLOWLIST: "someone/else",
    };

    const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
    const before = await co.activeCount();

    const body = workflowJobPayload({
      action: "queued",
      jobId: 704,
      labels: ["createos-2vcpu-2gb"],
    });
    const res = await post(body, "dlv-policy-blocked", deps, blockedEnv);

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("policy-skip");
    expect(listShapes).not.toHaveBeenCalled();
    expect(createSandbox).not.toHaveBeenCalled();
    expect(await co.activeCount()).toBe(before);
  });

  // Fix 3: a job that is BOTH policy-blocked AND names an unknown shape must
  // report policy-skip — the permanent rejection — not unknown-shape, which
  // is irrelevant to a job that will never run regardless of its shape. It
  // must also never reach the catalog to find out the shape is unknown:
  // policy runs first.
  it("a repo-allowlist-blocked job naming an unknown shape returns policy-skip, not unknown-shape", async () => {
    const createSandbox = vi.fn();
    const listShapes = vi.fn().mockResolvedValue(shapeCatalog());
    const deps = {
      makeClient: () => ({
        createSandbox,
        listShapes,
        getSandbox: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    };
    const blockedEnv = {
      ...env,
      PROVISION_POLICY: "repo-allowlist",
      REPO_ALLOWLIST: "someone/else",
    };

    const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
    const before = await co.activeCount();

    const body = workflowJobPayload({
      action: "queued",
      jobId: 705,
      labels: ["createos-99vcpu-1tb"],
    });
    const res = await post(body, "dlv-policy-unknown-shape", deps, blockedEnv);

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("policy-skip");
    expect(listShapes).not.toHaveBeenCalled();
    expect(createSandbox).not.toHaveBeenCalled();
    expect(await co.activeCount()).toBe(before);
  });

  it("returns the same refusal for shaped webhook and Reconciler intake", async () => {
    // Both intake paths run the one admission module, so a shapes outage must
    // refuse a shaped job identically from either. The two listShapes calls are
    // intentional: a failed catalog read is not cached, so the webhook and the
    // later Reconciler tick each attempt it once.
    const listShapes = vi.fn().mockRejectedValue(new Error("catalog down"));
    const deps: SandboxDeps = {
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

    await runReconciler(env as never, deps);
    expect(listShapes).toHaveBeenCalledTimes(2);
  });
});
