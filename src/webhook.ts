import type { WorkflowJob } from "./types";

const enc = new TextEncoder();

/** Constant-time compare of two equal-length ArrayBuffers. */
function timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
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

/** Extracts the fields the controller acts on. Returns null if not a workflow_job. */
export function parseWorkflowJob(body: string): WorkflowJob | null {
  let p: unknown;
  try {
    p = JSON.parse(body);
  } catch {
    return null;
  }
  const o = p as Record<string, any>;
  const wj = o.workflow_job;
  if (!wj || !o.repository) return null;
  const action = o.action;
  if (!["queued", "in_progress", "completed", "waiting"].includes(action)) return null;
  return {
    action,
    jobId: wj.id,
    runId: wj.run_id,
    repoFullName: o.repository.full_name,
    labels: Array.isArray(wj.labels) ? wj.labels : [],
  };
}

export function matchesLabel(job: WorkflowJob, label: string): boolean {
  return job.labels.includes(label);
}
