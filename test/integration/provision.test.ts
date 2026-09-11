import {
  env,
  SELF,
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreateosSandboxServerError } from "@nodeops-createos/sandbox";
import { handleWebhook } from "../../src/handler";
import { resetCredentialSessionsForTests } from "../../src/github/auth";
import { sign, workflowJobPayload } from "../helpers/fixtures";
import worker from "../../src/index";

// The credential session is module-level and warm across invocations; drop it
// between cases so one case's patched GitHub fetch can't serve its cached token
// to the next.
beforeEach(() => {
  resetCredentialSessionsForTests();
});

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
  tenant: null,
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

  // HMAC needs the exact bytes, so the body has to be buffered BEFORE any
  // credential is checked — on an endpoint anyone who learns the URL can POST
  // to, against a 128 MB isolate shared with whatever else it is serving.
  it("refuses an oversize body before buffering it, credential or not", async () => {
    const req = new Request("https://ctrl.local/webhook", {
      method: "POST",
      headers: { "X-GitHub-Delivery": "huge" },
      body: "x".repeat(1_048_577),
    });
    const res = await worker.fetch(req, env as any, createExecutionContext());
    expect(res.status).toBe(413);
  });

  it("enforces the cap while READING, not just on Content-Length", async () => {
    // A chunked request declares no length, which is exactly how the declared
    // size would be omitted. The read itself is the bound: an endless body is
    // cancelled once it passes the cap.
    let chunks = 0;
    const body = new ReadableStream({
      pull(c) {
        chunks++;
        c.enqueue(new Uint8Array(256 * 1024));
      },
    });
    const req = new Request("https://ctrl.local/webhook", {
      method: "POST",
      headers: { "X-GitHub-Delivery": "chunked" },
      body,
      duplex: "half",
    } as RequestInit);
    const res = await worker.fetch(req, env as any, createExecutionContext());
    expect(res.status).toBe(413);
    expect(req.headers.get("content-length")).toBeNull();
    // Cancelled, not drained: the cap binds after ~1 MiB, not at the end of an
    // endless stream.
    expect(chunks).toBeLessThan(16);
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
    const getSandbox = vi
      .fn()
      .mockResolvedValue({ destroy, getBandwidth: async () => ({ used_bytes: 0 }) });

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

  // The alert used to be awaited BEFORE markProvisionFailed, which put a
  // third-party webhook in front of capacity release, the compensating destroy,
  // and the next pending job — inside a 30s execution budget. A Slack URL that
  // accepts the connection and never answers is not a caught failure, so the
  // catch in notify() could not save it.
  it("frees the slot and persists the failure before the alert webhook answers", async () => {
    patchGitHub();
    let releaseAlert!: () => void;
    let alertSeen!: () => void;
    const alertInFlight = new Promise<void>((resolve) => {
      alertSeen = resolve;
    });
    const inner = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.includes("hooks.example")) {
        alertSeen();
        return new Promise<Response>((resolve) => {
          releaseAlert = () => resolve(new Response("ok"));
        });
      }
      return inner(input, init);
    }) as typeof fetch;

    const createSandbox = vi.fn().mockRejectedValue(new Error("createos refused"));
    const body = workflowJobPayload({ action: "queued", jobId: 513 });
    const req = new Request("https://ctrl.local/webhook", {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await sign(env.GITHUB_WEBHOOK_SECRET as string, body),
        "X-GitHub-Delivery": "dlv-513",
      },
      body,
    });
    // A hand-rolled ctx: the real one cannot be drained here, because the
    // provisioning promise is deliberately still holding the pending alert.
    const background: Promise<unknown>[] = [];
    const res = await handleWebhook(
      req,
      { ...env, ALERT_WEBHOOK_URL: "https://hooks.example/x" } as any,
      { waitUntil: (p: Promise<unknown>) => background.push(p) } as any,
      {
        makeClient: () => ({
          createSandbox,
          getSandbox: vi.fn(),
          listShapes: vi.fn(),
          listSandboxes: vi.fn().mockResolvedValue([]),
        }),
      } as any,
    );
    expect(res.status).toBe(202);
    await alertInFlight; // the alert is in flight and will not answer on its own

    const row = async () =>
      (
        await runInDurableObject(singleton(), (_i, state) =>
          state.storage.sql
            .exec<{ state: string; attempts: number }>(
              `SELECT state, attempts FROM jobs WHERE job_id = ?`,
              513,
            )
            .toArray(),
        )
      )[0];
    // Re-queued for retry with its slot released, all while Slack hangs.
    await vi.waitFor(async () => expect((await row())?.state).toBe("pending"));
    expect(createSandbox).toHaveBeenCalledOnce();
    expect((await row())!.attempts).toBe(1);

    // And the alert is still TRACKED — an untracked promise in waitUntil is
    // killed without a trace, so the alert must be awaited, just not first.
    releaseAlert();
    await Promise.all(background);
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
    const getSandbox = vi
      .fn()
      .mockResolvedValue({ destroy, getBandwidth: async () => ({ used_bytes: 0 }) });
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
    await co.recordSandboxCreated(600, "sb_600", "cos-600-aa", "default");
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
    await co.recordSandboxCreated(601, "sb_601", "cos-601-bb", "default");
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
    await co.recordSandboxCreated(602, "sb_602", "cos-602-cc", "default");
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

/**
 * Region failover end-to-end: CREATEOS_REGIONS=us,eu — the primary's
 * createSandbox 503s (capacity exhausted surfaces as a bare 503), so the VM
 * boots in eu; the row learns `region = eu`; and the completed webhook's
 * teardown dials the eu control plane — never the us one, whose 404 would
 * read as "already destroyed" and leak the VM.
 */
describe("region failover (us 503s → eu boots, teardown dials eu)", () => {
  it("queued → boots in eu on us 503 → completed destroys via the eu client", async () => {
    patchGitHub();
    const usCreate = vi
      .fn()
      .mockRejectedValue(
        new CreateosSandboxServerError("service unavailable", new Response(null, { status: 503 })),
      );
    const euCreate = vi.fn().mockResolvedValue({
      id: "sb_eu",
      runCommand: vi
        .fn()
        .mockResolvedValue({ result: { stdout: "started", stderr: "", exit_code: 0 }, exec_ms: 1 }),
    });
    const usGet = vi.fn();
    const euDestroy = vi.fn().mockResolvedValue({ id: "sb_eu", status: "destroying" });
    const euGet = vi
      .fn()
      .mockResolvedValue({ destroy: euDestroy, getBandwidth: async () => ({ used_bytes: 0 }) });
    const deps = {
      makeClient: (_config: unknown, region?: { name: string }) => ({
        createSandbox: region?.name === "eu" ? euCreate : usCreate,
        getSandbox: region?.name === "eu" ? euGet : usGet,
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    };
    const regionalEnv = {
      ...env,
      CREATEOS_REGIONS: "us=https://api-us.local,eu=https://api-eu.local",
    };

    // Queued: the us create 503s, eu boots the VM.
    const body = workflowJobPayload({ action: "queued", jobId: 700 });
    const req = new Request("https://ctrl.local/webhook", {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await sign(env.GITHUB_WEBHOOK_SECRET as string, body),
        "X-GitHub-Delivery": "dlv-700",
      },
      body,
    });
    const ctx = createExecutionContext();
    const res = await handleWebhook(req, regionalEnv as any, ctx, deps as any);
    await waitOnExecutionContext(ctx);

    expect(await res.text()).toBe("provision");
    expect(usCreate).toHaveBeenCalledOnce();
    expect(euCreate).toHaveBeenCalledOnce();

    // Completed webhook: teardown runs through the eu client end-to-end. The
    // row having learned `region = eu` is exactly what euGet being dialed (and
    // usGet NEVER being dialed) proves.
    const body2 = workflowJobPayload({ action: "completed", jobId: 700 });
    const req2 = new Request("https://ctrl.local/webhook", {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": await sign(env.GITHUB_WEBHOOK_SECRET as string, body2),
        "X-GitHub-Delivery": "dlv-700c",
      },
      body: body2,
    });
    const ctx2 = createExecutionContext();
    await handleWebhook(req2, regionalEnv as any, ctx2, deps as any);
    await waitOnExecutionContext(ctx2);

    expect(euGet).toHaveBeenCalledWith("sb_eu");
    expect(euDestroy).toHaveBeenCalledOnce();
    expect(usGet).not.toHaveBeenCalled();

    globalThis.fetch = realFetch;
  });
});
