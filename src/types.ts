export type ProvisionPolicy = "org-wide" | "repo-allowlist" | "fork-gated";

/** Parsed, validated env — produced by loadConfig(), consumed everywhere. */
export interface Config {
  githubOrg: string;
  githubApiUrl: string; // "https://api.github.com" (override for GHES)
  githubAppId: string;
  githubAppPrivateKeyPkcs8: string; // PEM "-----BEGIN PRIVATE KEY-----"
  githubInstallationId: string;
  githubWebhookSecret: string;
  createosBaseUrl: string;
  createosApiKey: string;
  runnerLabel: string; // "createos"
  runnerTemplate: string; // template id/name
  runnerShape: string; // "s-4vcpu-4gb"
  runnerDiskMib: number; // 30720
  maxConcurrent: number; // 0 = unlimited
  provisionPolicy: ProvisionPolicy;
  repoAllowlist: string[]; // full names, e.g. "nodeops-app/api"
  reaperMaxAgeMs: number; // orphan cutoff, e.g. 3_600_000
  alertWebhookUrl?: string; // optional Slack-style webhook for failure alerts
}

/** The subset of a workflow_job webhook the controller acts on. */
export interface WorkflowJob {
  action: "queued" | "in_progress" | "completed" | "waiting";
  jobId: number; // workflow_job.id — the idempotency key
  runId: number; // workflow_job.run_id — for fork lookup
  repoFullName: string; // repository.full_name, "nodeops-app/api"
  labels: string[]; // workflow_job.labels
  runnerName?: string; // workflow_job.runner_name — the runner that ran the job (set on completed)
}

/** DO → Worker decision for a queued job. */
export interface QueuedDecision {
  action: "provision" | "queued" | "ignore";
  jobId: number;
}

/** DO → Worker: a job to boot (returned by onCompleted/sweep when a slot frees). */
export interface PendingJob {
  jobId: number;
  runId: number;
  repoFullName: string;
}

/**
 * A sandbox the Worker must destroy, paired with the DO row that owns it. The
 * row stays in `destroying` until the Worker confirms the destroy via
 * markDestroyed(jobId), so a failed teardown leaves retry state for the reaper.
 */
export interface TeardownTask {
  jobId: number;
  sandboxId: string;
}

/**
 * DO → Worker after recordSandboxCreated: `launch` the runner, or `destroy`
 * the just-created sandbox because the job already completed/cancelled during
 * the create window (its row is gone) — prevents leaking an orphan VM.
 */
export interface SandboxRecordDecision {
  action: "launch" | "destroy";
}

/** DO → Worker after a provision failure: the next pending job to boot, if any. */
export interface ProvisionFailedResult {
  nextPending: PendingJob | null;
}

/** DO → Worker on completion: which VM to destroy + what to boot next. */
export interface CompletedResult {
  toDestroy: TeardownTask | null;
  nextPending: PendingJob | null;
}

/** DO → Worker on sweep: orphan / retry VMs to destroy. */
export interface ReapResult {
  toDestroy: TeardownTask[];
}
