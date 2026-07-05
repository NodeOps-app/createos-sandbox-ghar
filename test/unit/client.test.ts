import { describe, it, expect } from "vitest";
import { GitHubClient } from "../../src/github/client";
import { mockFetch, githubRoutes } from "../helpers/mocks";
import type { Config } from "../../src/types";

async function cfg(): Promise<Config> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const p8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  let bin = "";
  for (const b of new Uint8Array(p8)) bin += String.fromCharCode(b);
  return {
    githubOrg: "nodeops-app",
    githubAppId: "1",
    githubAppPrivateKeyPkcs8: `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`,
    githubInstallationId: "2",
    githubWebhookSecret: "s",
    createosBaseUrl: "https://c",
    createosApiKey: "k",
    runnerLabel: "createos",
    runnerTemplate: "ghar-runner",
    runnerShape: "s-4vcpu-4gb",
    runnerDiskMib: 30720,
    maxConcurrent: 0,
    provisionPolicy: "org-wide",
    repoAllowlist: [],
    reaperMaxAgeMs: 3_600_000,
  };
}

describe("GitHubClient.generateJitConfig", () => {
  it("returns encoded_jit_config", async () => {
    const client = new GitHubClient(await cfg(), mockFetch(githubRoutes()));
    expect(await client.generateJitConfig("ghar-100")).toBe("ENCODED_JIT_BLOB");
  });
  it("throws on failure", async () => {
    const routes = githubRoutes({ "POST /generate-jitconfig": () => new Response("bad", { status: 422 }) });
    const client = new GitHubClient(await cfg(), mockFetch(routes));
    await expect(client.generateJitConfig("x")).rejects.toThrow(/422/);
  });
});
