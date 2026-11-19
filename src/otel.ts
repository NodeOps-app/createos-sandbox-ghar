/**
 * Per-run telemetry tokens for the OTEL beta collector. A runner VM runs tenant
 * code, so the credential it carries must be worth as little as possible: each
 * token names ONE runner (so one attempt of one job), expires, and is signed with
 * a key that never leaves the Worker and the collector's verifier. Import-free on
 * purpose (Web Crypto only): the Worker mints, scripts/otel-auth-proxy.ts verifies,
 * and both must agree byte for byte.
 */
import type { Config } from "./types";

export const OTEL_TOKEN_HEADER = "x-ghar-token";
/** GitHub caps a job at 6h; one more hour covers boot + teardown skew. */
export const OTEL_TOKEN_TTL_S = 7 * 3600;

const enc = new TextEncoder();

const hmacKey = (key: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string) =>
  new Uint8Array((hex.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));

/** `<runnerName>.<expiryEpochSeconds>.<hmac-sha256 hex>` — no dots in a runner name. */
export async function mintOtelToken(
  key: string,
  runnerName: string,
  nowMs: number,
  ttlS = OTEL_TOKEN_TTL_S,
): Promise<string> {
  const payload = `${runnerName}.${Math.floor(nowMs / 1000) + ttlS}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), enc.encode(payload));
  return `${payload}.${toHex(sig)}`;
}

export type OtelTokenCheck =
  | { ok: true; runnerName: string }
  | { ok: false; reason: "malformed" | "expired" | "bad-signature" };

export async function verifyOtelToken(
  key: string,
  token: string,
  nowMs: number,
): Promise<OtelTokenCheck> {
  const m = /^([A-Za-z0-9-]+)\.(\d+)\.([0-9a-f]{64})$/.exec(token);
  if (!m) return { ok: false, reason: "malformed" };
  const [, runnerName, exp, sig] = m;
  // verify() compares in constant time; a string compare of hex would not.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(key, "verify"),
    fromHex(sig!),
    enc.encode(`${runnerName}.${exp}`),
  );
  if (!valid) return { ok: false, reason: "bad-signature" };
  if (Number(exp) * 1000 < nowMs) return { ok: false, reason: "expired" };
  return { ok: true, runnerName: runnerName! };
}

/**
 * Env a runner VM gets so `otel-cli` (baked into the template) reaches the beta
 * collector. Empty unless this Tenant is on the beta allowlist — the default for
 * every other tenant, and for the whole fleet while OTEL_* is unset, is "nothing
 * injected".
 */
export async function otelRunnerEnvs(
  otel: Config["otel"],
  installationId: number | undefined,
  runnerName: string,
  nowMs = Date.now(),
): Promise<Record<string, string>> {
  if (!otel || installationId === undefined || !otel.installationIds.includes(installationId)) {
    return {};
  }
  const token = await mintOtelToken(otel.tokenKey, runnerName, nowMs);
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: otel.endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_HEADERS: `${OTEL_TOKEN_HEADER}=${token}`,
  };
}
