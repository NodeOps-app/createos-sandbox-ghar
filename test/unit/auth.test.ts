import { describe, it, expect, vi } from "vitest";
import { TokenCache } from "../../src/github/auth";
import { mockFetch, githubRoutes, jitToken } from "../helpers/mocks";

// Minimal valid PKCS#8 key generated once for token tests.
async function pem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
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
    const c = new TokenCache("1", await pem(), "2", fetchImpl);
    expect(await c.token()).toBe(jitToken);
    expect(await c.token()).toBe(jitToken);
    expect(spy).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it("throws on non-ok", async () => {
    const fetchImpl = mockFetch({ "POST /access_tokens": () => new Response("nope", { status: 403 }) });
    const c = new TokenCache("1", await pem(), "2", fetchImpl);
    await expect(c.token()).rejects.toThrow(/403/);
  });
});
