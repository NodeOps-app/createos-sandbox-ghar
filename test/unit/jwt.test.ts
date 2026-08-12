import { describe, it, expect } from "vitest";
import { appJwt } from "../../src/github/jwt";

const enc = new TextEncoder();

async function genPkcs8Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  let bin = "";
  for (const b of new Uint8Array(pkcs8)) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("appJwt", () => {
  it("produces a verifiable RS256 JWT with correct claims", async () => {
    const { pem, publicKey } = await genPkcs8Pem();
    const now = 1_000_000;
    const jwt = await appJwt("42", pem, now);

    const [h, p, sig] = jwt.split(".") as [string, string, string];
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({ iat: now - 60, exp: now + 600, iss: "42" });

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64urlToBytes(sig),
      enc.encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("rejects a non-PKCS#8 (PKCS#1) key", async () => {
    const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";
    await expect(appJwt("1", pkcs1)).rejects.toThrow();
  });
});
