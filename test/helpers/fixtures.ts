const enc = new TextEncoder();

/** HMAC-SHA256 sign a body the way GitHub does; returns the header value. */
export async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

export function workflowJobPayload(overrides: {
  action?: string;
  jobId?: number;
  runId?: number;
  repo?: string;
  labels?: string[];
  runnerName?: string;
}): string {
  return JSON.stringify({
    action: overrides.action ?? "queued",
    workflow_job: {
      id: overrides.jobId ?? 100,
      run_id: overrides.runId ?? 200,
      labels: overrides.labels ?? ["createos"],
      runner_name: overrides.runnerName ?? "",
    },
    repository: { full_name: overrides.repo ?? "nodeops-app/api" },
  });
}
