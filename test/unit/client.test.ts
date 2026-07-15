import { describe, it, expect } from "vitest";
import { GitHubClient } from "../../src/github/client";
import { mockFetch, githubRoutes, runnerName } from "../helpers/mocks";
import type { Config } from "../../src/types";

async function cfg(): Promise<Config> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const p8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  let bin = "";
  for (const b of new Uint8Array(p8)) bin += String.fromCharCode(b);
  return {
    githubOrg: "nodeops-app",
    githubApiUrl: "https://api.github.com",
    githubAppId: "1",
    githubAppPrivateKeyPkcs8: `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`,
    githubInstallationId: "2",
    githubWebhookSecret: "s",
    createosBaseUrl: "https://c",
    createosApiKey: "k",
    runnerLabel: "createos",
    runnerGroupId: 1,
    runnerTemplate: "ghar-runner",
    sandboxNamePrefix: "gha-ci",
    runnerShape: "s-4vcpu-4gb",
    minRunnerMemMib: 2048,
    runnerDiskMib: 30720,
    maxConcurrent: 0,
    provisionPolicy: "org-wide",
    repoAllowlist: [],
    reaperMaxAgeMs: 3_600_000,
    reconcileGraceMs: 180_000,
  };
}

describe("GitHubClient.generateJitConfig", () => {
  it("returns encoded_jit_config and registers the runner under the requested label", async () => {
    let body: unknown;
    const routes = githubRoutes({
      "POST /generate-jitconfig": async (req) => {
        body = await req.json();
        return new Response(JSON.stringify({ encoded_jit_config: "ENCODED_JIT_BLOB" }), {
          status: 201,
        });
      },
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    expect(await client.generateJitConfig(runnerName(1), "createos")).toBe("ENCODED_JIT_BLOB");
    expect((body as { labels: string[] }).labels).toEqual(["createos"]);
    expect((body as { runner_group_id: number }).runner_group_id).toBe(1); // default group
  });
  it("registers the runner into the configured runner group", async () => {
    // The group is the GitHub-side execution boundary; the controller's policy is
    // not. A non-default RUNNER_GROUP_ID must reach generate-jitconfig verbatim.
    let body: unknown;
    const routes = githubRoutes({
      "POST /generate-jitconfig": async (req) => {
        body = await req.json();
        return new Response(JSON.stringify({ encoded_jit_config: "X" }), { status: 201 });
      },
    });
    const client = new GitHubClient({ ...(await cfg()), runnerGroupId: 7 }, mockFetch(routes));
    await client.generateJitConfig(runnerName(1), "createos");
    expect((body as { runner_group_id: number }).runner_group_id).toBe(7);
  });
  it("throws on failure", async () => {
    const routes = githubRoutes({
      "POST /generate-jitconfig": () => new Response("bad", { status: 422 }),
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    await expect(client.generateJitConfig("x", "createos")).rejects.toThrow(/422/);
  });
});

describe("GitHubClient.deleteRunner", () => {
  it("DELETEs the org-scoped runner id", async () => {
    let seen = "";
    const routes = githubRoutes({
      "DELETE /actions/runners/": (req) => {
        seen = new URL(req.url).pathname;
        return new Response(null, { status: 204 });
      },
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    await expect(client.deleteRunner(41)).resolves.toBeUndefined();
    expect(seen).toBe("/orgs/nodeops-app/actions/runners/41");
  });

  it("treats 404 as success", async () => {
    // GitHub auto-removes a runner the moment it completes a job, so the sweep
    // routinely races a registration that is already gone. Idempotent or the
    // reaper alerts on its own healthy no-ops.
    const routes = githubRoutes({
      "DELETE /actions/runners/": () => new Response("Not Found", { status: 404 }),
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    await expect(client.deleteRunner(41)).resolves.toBeUndefined();
  });

  it("throws on a real failure", async () => {
    const routes = githubRoutes({
      "DELETE /actions/runners/": () => new Response("nope", { status: 403 }),
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    await expect(client.deleteRunner(41)).rejects.toThrow(/403/);
  });
});

describe("GitHubClient.listRunners", () => {
  it("returns id, name, status and busy", async () => {
    const routes = githubRoutes({
      "GET /actions/runners": () =>
        new Response(
          JSON.stringify({
            runners: [
              { id: 1, name: runnerName(7), status: "online", busy: true },
              { id: 2, name: runnerName(8, "bb"), status: "offline" }, // busy omitted → false
            ],
          }),
          { status: 200 },
        ),
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    expect(await client.listRunners()).toEqual([
      { id: 1, name: runnerName(7), status: "online", busy: true },
      { id: 2, name: runnerName(8, "bb"), status: "offline", busy: false },
    ]);
  });

  it("refuses a malformed record rather than under-reporting a live runner", async () => {
    // The liveness oracle tests for ABSENCE: a dropped or offline-defaulted live
    // runner reads as "gone" and reapUnregistered destroys its VM mid-job. A
    // record missing id/name/status must fail the whole read, like a truncated
    // page — never a silent drop or a defaulted status.
    const listWith = async (rec: unknown) =>
      new GitHubClient(
        await cfg(),
        mockFetch(
          githubRoutes({
            "GET /actions/runners": () =>
              new Response(JSON.stringify({ runners: [rec] }), { status: 200 }),
          }),
        ),
      ).listRunners();
    await expect(listWith({ name: "n", status: "online" })).rejects.toThrow(/malformed/); // no id
    await expect(listWith({ id: 1, status: "online" })).rejects.toThrow(/malformed/); // no name
    await expect(listWith({ id: 1, name: "n" })).rejects.toThrow(/malformed/); // no status
    // A status that isn't online/offline would fail step A's `=== "online"` and
    // read as absent → must throw, not pass through as not-online.
    await expect(listWith({ id: 1, name: "n", status: "provisioning" })).rejects.toThrow(
      /malformed/,
    );
    // A truthy non-string name can't equal any stored runner name, so a live
    // runner carrying one reads as absent → throw, don't pass it through.
    await expect(listWith({ id: 1, name: 123, status: "online" })).rejects.toThrow(/malformed/);
  });

  it("refuses a page whose runners key is missing or not an array", async () => {
    // #getPaged coercing a keyless 200 to [] would read as "no runners at all"
    // and reap every live VM at once — the widest-blast-radius form of the same
    // under-report. Strict callers must throw, not return an empty list.
    const listBody = async (body: unknown) =>
      new GitHubClient(
        await cfg(),
        mockFetch(
          githubRoutes({
            "GET /actions/runners": () => new Response(JSON.stringify(body), { status: 200 }),
          }),
        ),
      ).listRunners();
    await expect(listBody({ total_count: 0 })).rejects.toThrow(/under-report/); // no runners key
    await expect(listBody({ runners: null })).rejects.toThrow(/under-report/);
    await expect(listBody({ runners: "nope" })).rejects.toThrow(/under-report/);
    await expect(listBody({ total_count: 0, runners: [] })).resolves.toEqual([]); // real empty list
  });

  it("refuses a page that returns fewer runners than it declares", async () => {
    // `{total_count:1, runners:[]}` is a well-formed array that still proves a
    // runner was omitted — every tracked VM would read as absent. The declared
    // total is the only evidence of the omission, so a shortfall must throw.
    const client = async (body: unknown) =>
      new GitHubClient(
        await cfg(),
        mockFetch(
          githubRoutes({
            "GET /actions/runners": () => new Response(JSON.stringify(body), { status: 200 }),
          }),
        ),
      ).listRunners();
    await expect(client({ total_count: 1, runners: [] })).rejects.toThrow(/1 declared/);
    // Collecting MORE than declared (a runner registered mid-scan) is not a
    // teardown risk and must NOT throw.
    await expect(
      client({ total_count: 0, runners: [{ id: 1, name: "cos-1-aa", status: "online" }] }),
    ).resolves.toHaveLength(1);
  });

  it("fails closed when offset pagination shrinks mid-scan", async () => {
    // 101 runners: page 1 returns r1–r100 (total 101). A runner deregisters, so
    // page 2 comes back empty with total 100 — still-live r101 shifted into an
    // already-read page and is now omitted. Keying on the LAST total (100 ≥ 100)
    // would rubber-stamp that omission and reap r101's VM; keying on the MAX
    // (101) makes the short read throw.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: runnerName(i + 1),
      status: "online",
    }));
    const routes = githubRoutes({
      "GET /actions/runners": (req) => {
        const page = new URL(req.url).searchParams.get("page");
        return page === "1"
          ? new Response(JSON.stringify({ total_count: 101, runners: page1 }), { status: 200 })
          : new Response(JSON.stringify({ total_count: 100, runners: [] }), { status: 200 });
      },
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    await expect(client.listRunners()).rejects.toThrow(/100 of 101 declared/);
  });

  it("KNOWN RESIDUAL: balanced mid-scan turnover is not caught by count alone", async () => {
    // Documents the boundary loudly (no silent bound). id 1 leaves AND id 102
    // joins between pages, so the total stays 101 while live id 101 shifts out of
    // page 1 and is omitted. Count equality can't see it, and no amount of
    // list-level parsing can — it is structural to offset pagination over a
    // mutating set. Closing it belongs to the REAP path, which must confirm a
    // specific runner's absence against GitHub before destroying (one subrequest
    // per candidate — the subrequest-budget redesign's call). This asserts the
    // current, inherent under-catch so the boundary is executable, not silent.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: runnerName(i + 1),
      status: "online",
    }));
    const routes = githubRoutes({
      "GET /actions/runners": (req) => {
        const page = new URL(req.url).searchParams.get("page");
        return page === "1"
          ? new Response(JSON.stringify({ total_count: 101, runners: page1 }), { status: 200 })
          : new Response(
              JSON.stringify({
                total_count: 101,
                runners: [{ id: 102, name: runnerName(102), status: "online" }],
              }),
              { status: 200 },
            );
      },
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    const got = await client.listRunners();
    expect(got).toHaveLength(101); // passes despite omitting live id 101 — the residual
    expect(got.some((r) => r.name === runnerName(101))).toBe(false);
  });

  it("refuses a truncated read rather than under-reporting live runners", async () => {
    // The liveness oracle tests for ABSENCE: a runner missing from a truncated
    // page reads as "runner gone", and reapUnregistered would destroy its VM
    // mid-job. A full page at the cap must fail the whole read, not half-answer.
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: runnerName(i),
      status: "online",
    }));
    const routes = githubRoutes({
      "GET /actions/runners": () =>
        new Response(JSON.stringify({ runners: full }), { status: 200 }),
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    await expect(client.listRunners()).rejects.toThrow(/MAX_PAGES/);
  });
});

describe("GitHubClient.isForkJob", () => {
  const run =
    (body: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(body), { status });

  it("queries the repo-qualified run URL and clears a same-org, non-fork run", async () => {
    let seen = "";
    const routes = githubRoutes({
      "GET /actions/runs/": (req) => {
        seen = new URL(req.url).pathname;
        return run({ head_repository: { fork: false, owner: { login: "NodeOps-App" } } })();
      },
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    expect(await client.isForkJob("nodeops-app/api", 200)).toBe(false);
    expect(seen).toBe("/repos/nodeops-app/api/actions/runs/200"); // owner/repo, not just org
  });

  it("flags a forked head repo", async () => {
    const routes = githubRoutes({ "GET /actions/runs/": run({ head_repository: { fork: true } }) });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    expect(await client.isForkJob("nodeops-app/api", 1)).toBe(true);
  });

  it("flags a head repo owned outside the org", async () => {
    const routes = githubRoutes({
      "GET /actions/runs/": run({
        head_repository: { fork: false, owner: { login: "someforker" } },
      }),
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    expect(await client.isForkJob("nodeops-app/api", 1)).toBe(true);
  });

  it("fails closed when the run lookup errors", async () => {
    const routes = githubRoutes({ "GET /actions/runs/": run({}, 404) });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    expect(await client.isForkJob("nodeops-app/api", 1)).toBe(true);
  });

  // A 200 that never names the head owner used to read as "same org" and admit
  // the job — the one unknown in this function that failed OPEN.
  it("fails closed when the head owner is unreadable", async () => {
    const client = async (head: unknown) =>
      new GitHubClient(
        await cfg(),
        mockFetch(githubRoutes({ "GET /actions/runs/": run({ head_repository: head }) })),
      );
    expect(await (await client({ fork: false })).isForkJob("nodeops-app/api", 1)).toBe(true);
    expect(await (await client({ fork: false, owner: {} })).isForkJob("nodeops-app/api", 1)).toBe(
      true,
    );
  });
});
