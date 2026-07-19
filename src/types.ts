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
  // GitHub runner group the JIT runner registers into. Default 1 = the org-wide
  // "Default" group. Which repos may actually schedule onto the runner is that
  // GROUP's GitHub policy (selected/all repos), not the controller's
  // repo-allowlist — so the allowlist is a COST control (which repos we spend a
  // VM on) until this points at a group whose policy scopes it to them.
  runnerGroupId: number;
  runnerTemplate: string; // template id/name
  sandboxNamePrefix: string; // createos VM name prefix (cosmetic, e.g. "gha-ci"); "" = none
  runnerShape: string; // "s-4vcpu-4gb" — the shape the bare `createos` label means
  minRunnerMemMib: number; // 2048 — shapes below this are never offered as labels
  runnerDiskMib: number; // 30720
  maxConcurrent: number; // 0 = unlimited
  provisionPolicy: ProvisionPolicy;
  repoAllowlist: string[]; // full names, e.g. "nodeops-app/api"
  reaperMaxAgeMs: number; // orphan cutoff, e.g. 3_600_000
  reconcileGraceMs: number; // reconciler boot grace before a runner-less VM is reaped, e.g. 180_000
  // Max GitHub subrequests the recovery scan may spend per cron tick before it
  // defers the rest to a later tick (cursor-resumed). Bounds the O(installed-repos)
  // read fan-out so it stays under the Free-plan 50-subrequest invocation cap.
  recoverySubrequestBudget: number; // e.g. 30

  alertWebhookUrl?: string; // optional Slack-style webhook for failure alerts
}

/** The subset of a workflow_job webhook the controller acts on. */
export interface WorkflowJob {
  action: "queued" | "in_progress" | "completed" | "waiting";
  jobId: number; // workflow_job.id — the idempotency key
  runId: number; // workflow_job.run_id — for fork lookup
  repoFullName: string; // repository.full_name, "nodeops-app/api"
  labels: string[]; // workflow_job.labels
  runnerName?: string; // workflow_job.runner_name — the runner assigned the job (set once a runner picks it up: in_progress and completed)
}

/** DO → Worker decision for a queued job. */
export interface QueuedDecision {
  action: "provision" | "queued" | "ignore";
  jobId: number;
}

/**
 * An org self-hosted runner as GitHub reports it. `status`/`busy` are the
 * reconciler's liveness oracle; `id` is what deleting an orphaned registration
 * keys on (the name is how we tell ours from anyone else's — see
 * `jobIdFromRunnerName`).
 */
export interface Runner {
  id: number;
  name: string;
  status: string; // "online" | "offline"
  busy: boolean;
}

/**
 * A queued workflow_job as GitHub reports it. Raw labels; no policy applied —
 * `GitHubClient.listQueuedJobs` is transport, not an admission decision, so it
 * hands back exactly what GitHub said and lets the caller (label selection)
 * decide which jobs are ours and what shape they name.
 */
export interface QueuedJob {
  jobId: number;
  runId: number;
  repoFullName: string;
  labels: string[];
}

/** DO → Worker: a job to boot (returned by onCompleted/sweep when a slot frees). */
export interface PendingJob {
  jobId: number;
  runId: number;
  repoFullName: string;
  /**
   * The single createos label the job asked for ("createos", or a shaped
   * "createos-2vcpu-2gb"). Persisted on the row: a job that queues behind the
   * concurrency cap must boot at the size it requested, and its JIT runner must
   * register under exactly this label (see ADR-0004).
   */
  label: string;
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
  /** Set when the failure left a live VM behind — destroy it, then confirm. */
  toDestroy: TeardownTask | null;
  nextPending: PendingJob | null;
}

/** DO → Worker on completion: which VM to destroy + what to boot next. */
export interface CompletedResult {
  toDestroy: TeardownTask | null;
  nextPending: PendingJob | null;
}

/**
 * DO → Worker after markJobStarted: the phase timestamps of one spawn, returned
 * once when the `in_progress` webhook first lands so the Worker can log the
 * queued→started timeline. A null start marks a phase that did not happen (a job
 * that never queued behind the cap has provisionStartedAt === createdAt, not a
 * distinct wait). Pure observation — the Worker only logs it.
 */
export interface SpawnTimeline {
  jobId: number;
  runnerName: string | null;
  createdAt: number;
  provisionStartedAt: number | null;
  bootedAt: number | null;
  jobStartedAt: number;
}

/**
 * DO → Worker on sweep/reap: orphan / retry VMs to destroy, plus any pending
 * jobs promoted into the slots those teardowns freed (the reaper/reconciler can
 * vacate several slots at once, so this is a list, not a single job).
 */
export interface ReapResult {
  toDestroy: TeardownTask[];
  nextPending: PendingJob[];
}
