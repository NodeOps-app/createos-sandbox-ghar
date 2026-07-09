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
      // Pinned only for a realistic runnerName in the completed payload below;
      // this file has one row per job, so job_id and runner_name lookups would
      // resolve identically either way — this test isn't distinguishing them.
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
    // the teardown path never consults the shape catalog, so a shapes-API
    // outage can't leak this VM.
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
