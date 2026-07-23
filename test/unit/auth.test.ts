import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TokenCache,
  credentialSession,
  resetCredentialSessionsForTests,
} from "../../src/github/auth";
import { mockFetch, githubRoutes, jitToken } from "../helpers/mocks";
import type { Config } from "../../src/types";

// Minimal valid PKCS#8 key generated once for token tests.
async function pem(): Promise<string> {
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
  return `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
}

describe("TokenCache", () => {
  it("fetches then caches within expiry", async () => {
    const spy = vi.fn(githubRoutes()["POST /access_tokens"]!);
    const fetchImpl = mockFetch({ "POST /access_tokens": spy });
    const c = new TokenCache("1", await pem(), "2", "https://api.github.com", fetchImpl);
    expect(await c.token()).toBe(jitToken);
    expect(await c.token()).toBe(jitToken);
    expect(spy).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it("throws on non-ok", async () => {
    const fetchImpl = mockFetch({
      "POST /access_tokens": () => new Response("nope", { status: 403 }),
    });
    const c = new TokenCache("1", await pem(), "2", "https://api.github.com", fetchImpl);
    await expect(c.token()).rejects.toThrow(/403/);
  });

  it("coalesces concurrent cold callers into a single mint", async () => {
    let calls = 0;
    const fetchImpl = mockFetch({
      "POST /access_tokens": (req) => {
        calls++;
        return githubRoutes()["POST /access_tokens"]!(req);
      },
    });
    const c = new TokenCache("1", await pem(), "2", "https://api.github.com", fetchImpl);
    // A burst racing the same cold window must mint ONCE, not once each.
    const [a, b, d] = await Promise.all([c.token(), c.token(), c.token()]);
    expect([a, b, d]).toEqual([jitToken, jitToken, jitToken]);
    expect(calls).toBe(1);
  });

  it("does not cache a rejected mint — the next call retries", async () => {
    let calls = 0;
    const fetchImpl = mockFetch({
      "POST /access_tokens": (req) => {
        calls++;
        return calls === 1
          ? new Response("nope", { status: 500 })
          : githubRoutes()["POST /access_tokens"]!(req);
      },
    });
    const c = new TokenCache("1", await pem(), "2", "https://api.github.com", fetchImpl);
    await expect(c.token()).rejects.toThrow(/500/);
    expect(await c.token()).toBe(jitToken); // retried with a fresh sign, not a cached failure
    expect(calls).toBe(2);
  });
});

// credentialSession only reads these four fields, so a cast keeps the fixture
// focused on the identity that keys the registry.
const cfg = (over: Partial<Config> = {}): Config =>
  ({
    githubAppId: "app",
    githubInstallationId: "inst",
    githubApiUrl: "https://api.github.com",
    githubAppPrivateKeyPkcs8: "key",
    ...over,
  }) as Config;

describe("credentialSession registry", () => {
  beforeEach(() => resetCredentialSessionsForTests());

  it("shares one session per credential identity", () => {
    expect(credentialSession(cfg())).toBe(credentialSession(cfg()));
  });

  it("never shares a session across installations", () => {
    expect(credentialSession(cfg({ githubInstallationId: "a" }))).not.toBe(
      credentialSession(cfg({ githubInstallationId: "b" })),
    );
  });

  it("keys installations apart by app id and API host too", () => {
    const base = credentialSession(cfg());
    expect(credentialSession(cfg({ githubAppId: "other" }))).not.toBe(base);
    expect(credentialSession(cfg({ githubApiUrl: "https://ghe.example/api/v3" }))).not.toBe(base);
  });

  it("drops warm sessions on reset", () => {
    const first = credentialSession(cfg());
    resetCredentialSessionsForTests();
    expect(credentialSession(cfg())).not.toBe(first);
  });

  it("keys the session on the installation id override, not config's", () => {
    // A tenant client mints under ITS installation, so two overrides must be
    // distinct sessions even though `cfg()`'s own installationId never changes.
    const a = credentialSession(cfg(), fetch, "111");
    const b = credentialSession(cfg(), fetch, "222");
    expect(a).not.toBe(b);
  });

  it("shares a session for the same installation id override", () => {
    const a = credentialSession(cfg(), fetch, "111");
    const b = credentialSession(cfg(), fetch, "111");
    expect(a).toBe(b);
  });
});
