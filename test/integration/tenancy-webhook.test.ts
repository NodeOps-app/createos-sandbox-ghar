import {
  env,
  runInDurableObject,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleWebhook } from "../../src/handler";
import { resetCredentialSessionsForTests } from "../../src/github/auth";
import { resetShapeCacheForTests } from "../../src/shapes";
import { sign, workflowJobPayload } from "../helpers/fixtures";
import type { TenantRecord } from "../../src/types";
import type { Bindings } from "../../src/index";

// The multi-mode env: TENANCY_MODE flips handleWebhook's queued branch onto
// admitAndDrive. Every other binding (GITHUB_ORG, secrets, DO) stays the
// vitest.config.ts fixture as-is.
const multiEnv = { ...env, TENANCY_MODE: "multi" } as unknown as Bindings;

const singleton = () => env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));

const approvedTenant = (id: number, over: Partial<TenantRecord> = {}): TenantRecord => ({
  installationId: id,
  orgLogin: `acme${id}`,
  status: "approved",
  allowAllRepos: false,
  minuteGrant: 1000,
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

beforeEach(() => {
  resetCredentialSessionsForTests();
  resetShapeCacheForTests();
});

const realFetch = globalThis.fetch;

/** Records GitHub calls this file cares about, and answers them realistically
 * enough for the controller to proceed (token mint, JIT mint, check runs). */
function patchGitHub() {
  const jitUrls: string[] = [];
  let checkRunCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() }),
        { status: 201 },
      );
    }
    if (req.url.includes("/generate-jitconfig")) {
      jitUrls.push(req.url);
      return new Response(JSON.stringify({ encoded_jit_config: "BLOB" }), { status: 201 });
    }
    if (req.url.includes("/check-runs")) {
      checkRunCalls++;
      return new Response("{}", { status: 201 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return {
    jitUrls,
    checkRunCalls: () => checkRunCalls,
  };
}

function sandboxDeps(createSandbox: ReturnType<typeof vi.fn>) {
  return {
    makeClient: () => ({
      createSandbox,
      getSandbox: vi.fn(),
      listShapes: vi.fn(),
      listSandboxes: vi.fn().mockResolvedValue([]),
    }),
  };
}

async function postQueued(
  opts: {
    jobId: number;
    repo: string;
    labels?: string[];
    installationId?: number;
    headSha?: string;
    delivery: string;
  },
  deps: object,
) {
  const body = workflowJobPayload({
    action: "queued",
    jobId: opts.jobId,
    repo: opts.repo,
    labels: opts.labels ?? ["createos"],
    installationId: opts.installationId,
    headSha: opts.headSha,
  });
  const req = new Request("https://ctrl.local/webhook", {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": await sign(multiEnv.GITHUB_WEBHOOK_SECRET as string, body),
      "X-GitHub-Delivery": opts.delivery,
    },
    body,
  });
  const ctx = createExecutionContext();
  const res = await handleWebhook(req, multiEnv, ctx, deps as any);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("multi-mode webhook admission", () => {
  it("unknown org: 202 unknown-tenant, one refusal check run per (repo, day)", async () => {
    const gh = patchGitHub();
    const createSandbox = vi.fn();

    const res1 = await postQueued(
      {
        jobId: 20001,
        repo: "ghost-org/repo1",
        installationId: 88001,
        headSha: "deadbeef",
        delivery: "dlv-20001",
      },
      sandboxDeps(createSandbox),
    );
    expect(res1.status).toBe(202);
    expect(await res1.text()).toBe("unknown-tenant");
    expect(gh.checkRunCalls()).toBe(1);

    // Second delivery, same repo/day, different job — dedup keys on
    // (installation, repo, day), not job id, so this must NOT fire again.
    const res2 = await postQueued(
      {
        jobId: 20002,
        repo: "ghost-org/repo1",
        installationId: 88001,
        headSha: "deadbeef",
        delivery: "dlv-20002",
      },
      sandboxDeps(createSandbox),
    );
    expect(res2.status).toBe(202);
    expect(await res2.text()).toBe("unknown-tenant");
    expect(gh.checkRunCalls()).toBe(1);

    expect(createSandbox).not.toHaveBeenCalled();
    globalThis.fetch = realFetch;
  });

  it("unknown org, no createos label: 202 no-label, check-run route never hit", async () => {
    const gh = patchGitHub();
    const createSandbox = vi.fn();

    const res = await postQueued(
      {
        jobId: 20101,
        repo: "ghost-org/repo2",
        labels: ["ubuntu-latest"],
        installationId: 88002,
        headSha: "deadbeef",
        delivery: "dlv-20101",
      },
      sandboxDeps(createSandbox),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("no-label");
    expect(gh.checkRunCalls()).toBe(0);
    expect(createSandbox).not.toHaveBeenCalled();
    globalThis.fetch = realFetch;
  });

  it("approved tenant + approved repo: provisions with a tenant-scoped JIT client and the community bandwidth quota", async () => {
    const gh = patchGitHub();
    const s = singleton();
    await s.adminUpsertTenant(approvedTenant(20200));
    await s.adminAddProjects(20200, [{ repoFullName: "acme20200/api", repoId: 1 }]);

    const rechargeBandwidth = vi.fn().mockResolvedValue({});
    // Fresh VM carries the 5 GiB account default; the community cap tops up the delta.
    const getBandwidth = vi.fn().mockResolvedValue({ quota_bytes: 5_368_709_120, used_bytes: 0 });
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb_20200",
      runCommand: vi
        .fn()
        .mockResolvedValue({ result: { stdout: "started", stderr: "", exit_code: 0 }, exec_ms: 1 }),
      getBandwidth,
      rechargeBandwidth,
    });

    const res = await postQueued(
      {
        jobId: 20200,
        repo: "acme20200/api",
        installationId: 20200,
        headSha: "deadbeef",
        delivery: "dlv-20200",
      },
      sandboxDeps(createSandbox),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("provision");

    expect(gh.jitUrls).toHaveLength(1);
    expect(gh.jitUrls[0]).toContain("/orgs/acme20200/");

    // The control plane rejects bandwidth_quota_bytes at create; the community
    // cap is topped up post-create via rechargeBandwidth, only the delta over
    // the fresh VM's 5 GiB default.
    expect(createSandbox).toHaveBeenCalledOnce();
    const request = createSandbox.mock.calls[0]![0];
    expect(request.bandwidth_quota_bytes).toBeUndefined();
    expect(rechargeBandwidth).toHaveBeenCalledWith(107_374_182_400 - 5_368_709_120);

    globalThis.fetch = realFetch;
  });

  it("allow_all_repos tenant: provisions with NO bandwidth quota", async () => {
    patchGitHub();
    const s = singleton();
    await s.adminUpsertTenant(approvedTenant(20300, { allowAllRepos: true }));

    const rechargeBandwidth = vi.fn().mockResolvedValue({});
    const getBandwidth = vi.fn().mockResolvedValue({ quota_bytes: 5_368_709_120, used_bytes: 0 });
    const createSandbox = vi.fn().mockResolvedValue({
      id: "sb_20300",
      runCommand: vi
        .fn()
        .mockResolvedValue({ result: { stdout: "started", stderr: "", exit_code: 0 }, exec_ms: 1 }),
      getBandwidth,
      rechargeBandwidth,
    });

    const res = await postQueued(
      {
        jobId: 20300,
        repo: "acme20300/anything",
        installationId: 20300,
        headSha: "deadbeef",
        delivery: "dlv-20300",
      },
      sandboxDeps(createSandbox),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("provision");

    expect(createSandbox).toHaveBeenCalledOnce();
    const request = createSandbox.mock.calls[0]![0];
    expect(request.bandwidth_quota_bytes).toBeUndefined();
    // allow-all tenants are unmetered: no quota recharge
    expect(rechargeBandwidth).not.toHaveBeenCalled();

    globalThis.fetch = realFetch;
  });

  it("shaped label above max_shape: 202 shape-over-ceiling, no job row inserted", async () => {
    const gh = patchGitHub();
    const s = singleton();
    await s.adminUpsertTenant(approvedTenant(20400, { maxShape: "s-4vcpu-8gb" }));
    await s.adminAddProjects(20400, [{ repoFullName: "acme20400/api", repoId: 1 }]);

    const createSandbox = vi.fn();
    const res = await postQueued(
      {
        jobId: 20400,
        repo: "acme20400/api",
        labels: ["createos-8vcpu-16gb"],
        installationId: 20400,
        headSha: "deadbeef",
        delivery: "dlv-20400",
      },
      sandboxDeps(createSandbox),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("shape-over-ceiling");
    expect(createSandbox).not.toHaveBeenCalled();
    expect(gh.checkRunCalls()).toBe(1); // refusal notice posted

    await runInDurableObject(s, async (_i, state) => {
      const rows = state.storage.sql
        .exec(`SELECT COUNT(*) AS n FROM jobs WHERE job_id = ?`, 20400)
        .toArray() as { n: number }[];
      expect(rows[0]!.n).toBe(0);
    });

    globalThis.fetch = realFetch;
  });

  it("usage at or over the monthly grant: 202 quota-exhausted", async () => {
    const gh = patchGitHub();
    const s = singleton();
    await s.adminUpsertTenant(approvedTenant(20500, { minuteGrant: 10 }));
    await s.adminAddProjects(20500, [{ repoFullName: "acme20500/api", repoId: 1 }]);
    await runInDurableObject(s, async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO usage (installation_id, month, repo_full_name, weighted_minutes, egress_bytes)
         VALUES (20500, ?, '', 10, 0)`,
        new Date().toISOString().slice(0, 7),
      );
    });

    const createSandbox = vi.fn();
    const res = await postQueued(
      {
        jobId: 20500,
        repo: "acme20500/api",
        installationId: 20500,
        headSha: "deadbeef",
        delivery: "dlv-20500",
      },
      sandboxDeps(createSandbox),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("quota-exhausted");
    expect(createSandbox).not.toHaveBeenCalled();
    expect(gh.checkRunCalls()).toBe(1);

    globalThis.fetch = realFetch;
  });
});
