import type { WorkflowJob } from "./types";

const enc = new TextEncoder();

/** Constant-time compare of two equal-length ArrayBuffers. */
export function timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Verifies GitHub's `X-Hub-Signature-256: sha256=<hex>` HMAC over the raw body.
 * Returns false on any malformed input rather than throwing.
 */
export async function verifySignature(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = hexToBytes(header.slice("sha256=".length));
  if (provided.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return timingSafeEqual(mac, provided.buffer as ArrayBuffer);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Extracts the fields the controller acts on. This is the trust boundary that
 * mints DO keys and GitHub API paths, so every field is validated: bad types
 * (missing id, non-numeric run_id, empty repo name) yield null, not a
 * malformed key. Returns null if not an actionable workflow_job.
 */
export function parseWorkflowJob(body: string): WorkflowJob | null {
  let p: unknown;
  try {
    p = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(p)) return null;
  const wj = p.workflow_job;
  const repository = p.repository;
  if (!isObject(wj) || !isObject(repository)) return null;

  const action = p.action;
  if (
    action !== "queued" &&
    action !== "in_progress" &&
    action !== "completed" &&
    action !== "waiting"
  ) {
    return null;
  }

  if (!isPosInt(wj.id) || !isPosInt(wj.run_id)) return null;
  if (!isNonEmptyString(repository.full_name)) return null;

  const labels = Array.isArray(wj.labels)
    ? wj.labels.filter((l): l is string => typeof l === "string")
    : [];
  // runner_name is "" (or absent) until a runner picks up the job; only carry a
  // real name. On completed it identifies the sandbox that actually ran the job.
  const runnerName = isNonEmptyString(wj.runner_name) ? wj.runner_name : undefined;

  return {
    action,
    jobId: wj.id,
    runId: wj.run_id,
    repoFullName: repository.full_name,
    labels,
    runnerName,
  };
}
