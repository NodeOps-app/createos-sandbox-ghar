import { env, SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { handleWebhook } from "../../src/handler";
import { sign, workflowJobPayload } from "../helpers/fixtures";
import worker from "../../src/index";

describe("scaffold", () => {
  it("health route returns ok", async () => {
    const res = await SELF.fetch("https://ctrl.local/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("coordinator DO responds", async () => {
    const id = env.COORDINATOR.idFromName("singleton");
    const stub = env.COORDINATOR.get(id);
    expect(await stub.activeCount()).toBe(0);
  });
});

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

describe("full provision flow", () => {
  it("queued → boots a sandbox and records it running", async () => {
    patchGitHub();
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb_1",
      runCommand: vi
        .fn()
        .mockResolvedValue({ result: { stdout: "started", stderr: "", exit_code: 0 }, exec_ms: 1 }),
    });
    // handleWebhook's deps type spans every path it can take — the catalog
    // fetch (listShapes) and teardown (getSandbox) — even though this job's
    // bare label and happy-path boot never reach either at runtime.
    const deps = {
      makeClient: () => ({ createSandbox, getSandbox: vi.fn(), listShapes: vi.fn() }),
    };

    const body = workflowJobPayload({ action: "queued", jobId: 500 });
    const req = new Request("https://ctrl.local/webhook", {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await sign(env.GITHUB_WEBHOOK_SECRET as string, body),
        "X-GitHub-Delivery": "dlv-1",
      },
      body,
    });
    const ctx = createExecutionContext();
    const res = await handleWebhook(req, env as any, ctx, deps);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("provision");
    expect(createSandbox).toHaveBeenCalledOnce();

    globalThis.fetch = realFetch;
  });

  it("refuses a job naming two createos labels — no sandbox, no slot used", async () => {
    const co = env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
    const before = await co.activeCount();

    const createSandbox = vi.fn();
    // Ambiguous-label short-circuits before any client call, but the type
    // still requires the full capability set handleWebhook can reach.
    const deps = {
      makeClient: () => ({ createSandbox, getSandbox: vi.fn(), listShapes: vi.fn() }),
    };

    const body = workflowJobPayload({
      action: "queued",
      jobId: 501,
      labels: ["createos", "createos-2vcpu-2gb"],
    });
    const req = new Request("https://ctrl.local/webhook", {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await sign(env.GITHUB_WEBHOOK_SECRET as string, body),
        "X-GitHub-Delivery": "dlv-ambiguous",
      },
      body,
    });
    const ctx = createExecutionContext();
    const res = await handleWebhook(req, env as any, ctx, deps);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("ambiguous-label");
    expect(createSandbox).not.toHaveBeenCalled();
    expect(await co.activeCount()).toBe(before); // delta, not absolute — DO is shared across cases
  });

  it("rejects a bad signature", async () => {
    const body = workflowJobPayload({});
    const req = new Request("https://ctrl.local/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha256=00", "X-GitHub-Delivery": "x" },
      body,
    });
    const res = await worker.fetch(req, env as any, createExecutionContext());
    expect(res.status).toBe(401);
  });
});
