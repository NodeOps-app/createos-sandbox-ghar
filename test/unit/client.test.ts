import { describe, it, expect } from "vitest";
import { GitHubClient } from "../../src/github/client";
import { mockFetch, githubRoutes } from "../helpers/mocks";
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
    expect(await client.generateJitConfig("ghar-1-aa", "createos")).toBe("ENCODED_JIT_BLOB");
    expect((body as { labels: string[] }).labels).toEqual(["createos"]);
  });
  it("throws on failure", async () => {
    const routes = githubRoutes({
      "POST /generate-jitconfig": () => new Response("bad", { status: 422 }),
    });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    await expect(client.generateJitConfig("x", "createos")).rejects.toThrow(/422/);
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
});
