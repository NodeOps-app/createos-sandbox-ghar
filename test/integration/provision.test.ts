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

const ids = (r: { toDestroy: { sandboxId: string }[] }) => r.toDestroy.map((t) => t.sandboxId);
const singleton = () => env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
// A DO instance separate from the singleton, for spawn-timeline setup rows that
// must land in `provisioning` regardless of the singleton's shared cross-case
// state under the MAX_CONCURRENT=2 cap.
const iso = () => env.COORDINATOR.get(env.COORDINATOR.idFromName("spawn-timeline"));
const pending = (jobId: number) => ({
  jobId,
  runId: 1,
  repoFullName: "nodeops-app/api",
  label: "createos",
});

/** POSTs a signed `queued` webhook for `jobId` and drains the waitUntil work. */
async function postQueued(jobId: number, deps: object) {
  const body = workflowJobPayload({ action: "queued", jobId });
  const req = new Request("https://ctrl.local/webhook", {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": await sign(env.GITHUB_WEBHOOK_SECRET as string, body),
      "X-GitHub-Delivery": `dlv-${jobId}`,
    },
    body,
  });
  const ctx = createExecutionContext();
  const res = await handleWebhook(req, env as any, ctx, deps as any);
  await waitOnExecutionContext(ctx);
  return res;
}

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
      makeClient: () => ({
        createSandbox,
        getSandbox: vi.fn(),
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
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
      makeClient: () => ({
        createSandbox,
        getSandbox: vi.fn(),
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
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

/**
 * Once createSandbox returns, a VM EXISTS — and its runner has not launched, so
 * it will never self-delete. Every failure from that point on must still dispose
 * of it. These drive the real webhook path and assert on the destroy call, so a
 * regression that drops the sandbox id shows up as a VM nobody destroyed.
 */
describe("a provision that fails after the VM exists never leaks it", () => {
  it("destroys the VM when the runner fails to launch", async () => {
    patchGitHub();
    const destroy = vi.fn().mockResolvedValue({ id: "sb_launchfail", status: "destroying" });
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb_launchfail",
      runCommand: vi.fn().mockRejectedValue(new Error("exec refused")),
    });
    const getSandbox = vi.fn().mockResolvedValue({ destroy });

    await postQueued(510, {
      makeClient: () => ({
        createSandbox,
        getSandbox,
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    });

    expect(createSandbox).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce(); // the VM is gone, not orphaned
    expect(await singleton().liveJobIds()).not.toContain(510); // teardown confirmed → row cleared
    globalThis.fetch = realFetch;
  });

  it("keeps a destroying row for the reaper when the destroy ALSO fails", async () => {
    patchGitHub();
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb_stuck",
      runCommand: vi.fn().mockRejectedValue(new Error("exec refused")),
    });
    // Both the launch and the compensating destroy fail — the worst case, and the
    // one that used to leak: the row was deleted and the VM left running.
    const getSandbox = vi.fn().mockRejectedValue(new Error("createos down"));

    await postQueued(511, {
      makeClient: () => ({
        createSandbox,
        getSandbox,
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    });

    // The VM survives as a durable teardown task, so the next sweep retries it.
    expect(ids(await singleton().sweep(Date.now(), 3_600_000))).toContain("sb_stuck");
  });

  it("destroys the VM when the job is cancelled mid-create", async () => {
    patchGitHub();
    const destroy = vi.fn().mockResolvedValue({ id: "sb_cancelled", status: "destroying" });
    const getSandbox = vi.fn().mockResolvedValue({ destroy });
    // The job completes WHILE createSandbox is in flight — so by the time we go to
    // record the VM, its row is already gone. The VM is real and must still die.
    const createSandbox = vi.fn().mockImplementation(async () => {
      await singleton().onCompleted(512);
      return { id: "sb_cancelled", runCommand: vi.fn() };
    });

    await postQueued(512, {
      makeClient: () => ({
        createSandbox,
        getSandbox,
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    });

    expect(destroy).toHaveBeenCalled();
    globalThis.fetch = realFetch;
  });
});

/**
 * The `in_progress` webhook is the real queued→started signal (a runner accepted
 * the job). It used to no-op; now it stamps `job_started_at` once and logs the
 * spawn phase timeline. These assert the stamping contract at the DO seam plus
 * the webhook wiring — the log line itself is Worker-side observability.
 */
describe("spawn timeline (markJobStarted / in_progress)", () => {
  it("stamps job_started_at once and returns the phase timestamps", async () => {
    const co = iso();
    await co.onQueued(pending(600), "dlv-600");
    await co.recordSandboxCreated(600, "sb_600", "cos-600-aa");
    await co.markRunning(600);

    const t = await co.markJobStarted(600, "cos-600-aa");
    expect(t).not.toBeNull();
    expect(t!.jobId).toBe(600);
    expect(t!.runnerName).toBe("cos-600-aa");
    expect(t!.provisionStartedAt).toBe(t!.createdAt); // booted immediately → no cap wait
    expect(t!.bootedAt).toBeGreaterThanOrEqual(t!.provisionStartedAt!);
    expect(t!.jobStartedAt).toBeGreaterThanOrEqual(t!.bootedAt!);

    // Redelivery: already stamped → null, so the Worker logs exactly one line.
    expect(await co.markJobStarted(600, "cos-600-aa")).toBeNull();
  });

  it("attributes timing by runner identity, not the provisioning job id", async () => {
    const co = iso();
    await co.onQueued(pending(601), "dlv-601");
    await co.recordSandboxCreated(601, "sb_601", "cos-601-bb");
    await co.markRunning(601);

    // Under backlog GitHub can dispatch a different queued job to our runner; the
    // in_progress it sends carries that other id but our runner's name.
    const t = await co.markJobStarted(999999, "cos-601-bb");
    expect(t?.jobId).toBe(601);
  });

  it("returns null for a job it holds no row for", async () => {
    expect(await iso().markJobStarted(424242)).toBeNull();
  });

  it("in_progress webhook stamps the timeline and no longer no-ops", async () => {
    const co = singleton();
    await co.onQueued(pending(602), "dlv-602");
    await co.recordSandboxCreated(602, "sb_602", "cos-602-cc");
    await co.markRunning(602);

    const body = workflowJobPayload({
      action: "in_progress",
      jobId: 602,
      runnerName: "cos-602-cc",
    });
    const req = new Request("https://ctrl.local/webhook", {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await sign(env.GITHUB_WEBHOOK_SECRET as string, body),
        "X-GitHub-Delivery": "dlv-inprogress-602",
      },
      body,
    });
    const ctx = createExecutionContext();
    const res = await handleWebhook(req, env as any, ctx, {} as any);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("in_progress"); // was "noop" before wiring
    expect(await co.markJobStarted(602, "cos-602-cc")).toBeNull(); // webhook already stamped it
  });
});
