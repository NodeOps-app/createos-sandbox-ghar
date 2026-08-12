const enc = new TextEncoder();

/** base64url without padding. */
function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof data === "string"
      ? enc.encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strips PEM armor + newlines, returns the DER bytes. Key MUST be PKCS#8. */
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Mints a GitHub App JWT (RS256). GitHub's key is PKCS#1; it MUST be converted
 * to PKCS#8 before storage (openssl pkcs8 -topk8 -nocrypt) — Web Crypto only
 * imports PKCS#8. `nowSec` is injectable for deterministic tests.
 */
export async function appJwt(
  appId: string,
  privateKeyPkcs8Pem: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 600, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}
