import { DurableObject } from "cloudflare:workers";
import type {
  QueuedDecision,
  PendingJob,
  CompletedResult,
  ReapResult,
  SandboxRecordDecision,
  ProvisionFailedResult,
  SpawnTimeline,
  TeardownTask,
} from "./types";

interface Env {
  MAX_CONCURRENT: string;
  RUNNER_LABEL: string;
}

type Row = {
  job_id: number;
  run_id: number;
  repo: string;
  sandbox_id: string | null;
  runner_name: string | null;
  label: string | null;
  state: string;
  created_at: number;
  provision_started_at: number | null;
  booted_at: number | null;
  job_started_at: number | null;
};

/**
 * Row lifecycle (`state`):
 *   pending      — at cap, waiting for a slot. No VM.
 *   provisioning — committed to boot; VM being created + runner launched.
 *   running      — VM up, runner launched.
 *   destroying   — job done (or reaped); VM teardown pending confirmation.
 *
 * `provisioning` + `running` count against the concurrency cap; `pending` and
 * `destroying` do not (a completed job frees its slot immediately, even while
 * its VM is still being torn down). A `destroying` row survives until the
 * Worker confirms the destroy via markDestroyed — so a failed teardown leaves
 * retry state the reaper can pick up.
 */
const ACTIVE_STATES = "('provisioning','running')";

/**
 * How old a VM-bearing row is, for BOTH destructive age tests (reconcile grace,
 * reaper max-age) — measured from the moment the row was committed to boot, not
 * from when its job was first seen.
 *
 * `created_at` is queue-entry time and is wrong here: a job that sits `pending`
 * at the cap keeps it, so promoting it to `provisioning` yields a row that is
 * already "old" the instant it starts booting. With RECONCILE_GRACE_MS=180s a
 * job that waited >3 min for a slot would be reaped mid-boot (its runner cannot
 * be online yet), the reconciler would re-drive it off GitHub's still-`queued`
 * view, and it would be reaped again — a livelock that only bites under exactly
 * the backlog the queue exists to absorb. The hour-scale reaper has the same
 * flaw: a job that waited 55 min then ran for 5 would be destroyed mid-job.
 *
 * COALESCE keeps rows written by the previous schema (NULL column) on their old
 * created_at behaviour rather than reading them as age zero, so a deploy that
 * rolls back mid-flight degrades to what shipped before instead of stranding
 * live rows. `created_at` stays the FIFO key and the pending-expiry key.
 */
const ROW_AGE = "COALESCE(provision_started_at, created_at)";

export class Coordinator extends DurableObject<Env> {
  #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id               INTEGER PRIMARY KEY,
        run_id               INTEGER NOT NULL,
        repo                 TEXT NOT NULL,
        sandbox_id           TEXT,
        runner_name          TEXT,
        label                TEXT,
        state                TEXT NOT NULL,
        created_at           INTEGER NOT NULL,
        provision_started_at INTEGER,
        booted_at            INTEGER,
        job_started_at       INTEGER
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        seen_at     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    // Migrate DOs created before a column existed: CREATE TABLE IF NOT EXISTS
    // won't add one to a live table. A NULL `label` is a row from before shape
    // labels, which by definition asked for the bare label; a NULL
    // `provision_started_at` is a row from before ROW_AGE, which COALESCEs it
    // back to created_at; a NULL `job_started_at` is a row whose in_progress
    // signal was never recorded (pre-migration, or a job that never started) and
    // only feeds the spawn-timeline log, so old code ignoring it is harmless. All
    // migrations are additive, so a Worker rollback (which does NOT revert DO
    // SQLite) leaves the old code reading rows it still understands.
    const cols = this.#sql.exec(`PRAGMA table_info(jobs)`).toArray() as { name: string }[];
    const has = (c: string) => cols.some((col) => col.name === c);
    if (!has("runner_name")) this.#sql.exec(`ALTER TABLE jobs ADD COLUMN runner_name TEXT`);
    if (!has("label")) this.#sql.exec(`ALTER TABLE jobs ADD COLUMN label TEXT`);
    if (!has("provision_started_at")) {
      this.#sql.exec(`ALTER TABLE jobs ADD COLUMN provision_started_at INTEGER`);
    }
    if (!has("job_started_at")) {
      this.#sql.exec(`ALTER TABLE jobs ADD COLUMN job_started_at INTEGER`);
    }
  }

  /**
   * The repo full-name the recovery scan last covered, or null. Passive state
   * only — the scan itself runs in the Worker; the DO never makes a GitHub call.
   * Lets a budget-bounded scan resume where it left off so coverage rotates
   * across ticks instead of forever re-scanning the head of the repo list.
   */
  async recoveryCursor(): Promise<string | null> {
    const row = this.#sql
      .exec<{ value: string | null }>(`SELECT value FROM meta WHERE key = 'recovery_cursor'`)
      .toArray()[0];
    return row?.value ?? null;
  }

  async setRecoveryCursor(cursor: string | null): Promise<void> {
    if (cursor === null) {
      this.#sql.exec(`DELETE FROM meta WHERE key = 'recovery_cursor'`);
      return;
    }
    this.#sql.exec(
      `INSERT INTO meta (key, value) VALUES ('recovery_cursor', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      cursor,
    );
  }

  #maxConcurrent(): number {
    return Number(this.env.MAX_CONCURRENT ?? "0") || 0;
  }

  /** The label a pre-migration row implicitly asked for. */
  #defaultLabel(): string {
    return this.env.RUNNER_LABEL || "createos";
  }

  #toPending(row: Row): PendingJob {
    return {
      jobId: row.job_id,
      runId: row.run_id,
      repoFullName: row.repo,
      label: row.label ?? this.#defaultLabel(),
    };
  }

  #active(): number {
    const r = this.#sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE state IN ${ACTIVE_STATES}`)
      .one();
    return r.n;
  }

  async activeCount(): Promise<number> {
    return this.#active();
  }

  /**
   * Every job id the Coordinator holds a row for, in ANY state — the runner
   * sweeper's safety oracle.
   *
   * onQueued inserts the row BEFORE the Worker mints that job's JIT runner
   * (handler → provisionAndRecord → createRunnerSandbox), so a runner that is
   * merely mid-boot — offline to GitHub for the ~30s its VM takes to come up —
   * always has a row here. A runner name whose job id is absent therefore has no
   * VM coming for it and never will: its registration is garbage and can be
   * deleted. Any row at all (even `pending`, even `destroying`) means hands off.
   */
  async liveJobIds(): Promise<number[]> {
    return this.#sql
      .exec<{ job_id: number }>(`SELECT job_id FROM jobs`)
      .toArray()
      .map((r) => r.job_id);
  }

  #rowByJob(jobId: number): Row | undefined {
    return this.#sql.exec<Row>(`SELECT * FROM jobs WHERE job_id = ?`, jobId).toArray()[0];
  }

  #rowByRunner(runnerName: string): Row | undefined {
    return this.#sql.exec<Row>(`SELECT * FROM jobs WHERE runner_name = ?`, runnerName).toArray()[0];
  }

  /**
   * Canonical Job-row retirement. A row with a live VM becomes Destroying and
   * returns the durable teardown effect; a VM-less row is deleted immediately.
   * Reapplying this to an existing Destroying row is idempotent.
   */
  #retireRow(row: Row, sandboxId: string | null = row.sandbox_id): TeardownTask | null {
    if (!sandboxId) {
      this.#sql.exec(`DELETE FROM jobs WHERE job_id = ?`, row.job_id);
      return null;
    }
    this.#sql.exec(
      `UPDATE jobs SET state = 'destroying', sandbox_id = ? WHERE job_id = ?`,
      sandboxId,
      row.job_id,
    );
    return { jobId: row.job_id, sandboxId };
  }

  /** Deduplicates by webhook delivery id. Returns true if this delivery is new. */
  #firstSeen(deliveryId: string, nowMs: number): boolean {
    const cur = this.#sql.exec(
      `INSERT OR IGNORE INTO deliveries (delivery_id, seen_at) VALUES (?, ?)`,
      deliveryId,
      nowMs,
    );
    return cur.rowsWritten > 0;
  }

  /**
   * A job queued. Idempotent on job_id AND delivery id. Decides provision-now
   * (slot free) vs pending (at cap). Returns the decision for the Worker to act.
   */
  async onQueued(job: PendingJob, deliveryId: string): Promise<QueuedDecision> {
    const now = Date.now();
    this.#firstSeen(deliveryId, now);

    if (this.#rowByJob(job.jobId)) {
      return { action: "ignore", jobId: job.jobId }; // already tracked (redelivery)
    }

    const cap = this.#maxConcurrent();
    const atCap = cap > 0 && this.#active() >= cap;
    const state = atCap ? "pending" : "provisioning";
    // A row that boots immediately starts its provisioning clock now; one that
    // queues has no clock until #dequeuePending promotes it (see ROW_AGE).
    this.#sql.exec(
      `INSERT INTO jobs (job_id, run_id, repo, sandbox_id, runner_name, label, state, created_at, provision_started_at, booted_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)`,
      job.jobId,
      job.runId,
      job.repoFullName,
      job.label,
      state,
      now,
      atCap ? null : now,
    );
    return { action: atCap ? "queued" : "provision", jobId: job.jobId };
  }

  /**
   * Records the created VM + runner name BEFORE the runner is launched, closing
   * the window where a `completed` arriving mid-boot would leak the VM. If the
   * job already completed/cancelled during creation (its row is gone or is
   * already being torn down), tells the Worker to destroy this orphan now.
   */
  async recordSandboxCreated(
    jobId: number,
    sandboxId: string,
    runnerName: string,
  ): Promise<SandboxRecordDecision> {
    const row = this.#rowByJob(jobId);
    if (!row || row.state !== "provisioning") {
      return { action: "destroy" };
    }
    this.#sql.exec(
      `UPDATE jobs SET sandbox_id = ?, runner_name = ? WHERE job_id = ?`,
      sandboxId,
      runnerName,
      jobId,
    );
    return { action: "launch" };
  }

  /** Flips provisioning → running once the runner is launched. */
  async markRunning(jobId: number): Promise<void> {
    this.#sql.exec(
      `UPDATE jobs SET state = 'running', booted_at = ? WHERE job_id = ? AND state = 'provisioning'`,
      Date.now(),
      jobId,
    );
  }

  /**
   * Records the real queued→started signal — the `in_progress` webhook GitHub
   * sends when a runner ACCEPTS the job — as `job_started_at`, and hands the
   * Worker the phase timestamps to log. Pure observation: it stamps once and
   * NEVER changes `state`, so it is safe for a row in any live state and adds no
   * network call (the webhook is one we already receive).
   *
   * Keyed on runner identity like onCompleted — under backlog GitHub may run a
   * different queued job on our runner, so the runner name is the true owner —
   * falling back to job id. Returns null when there is nothing to emit: a job we
   * hold no row for, a redelivery (already stamped), or a row already torn down
   * (a job so fast its `completed` beat its `in_progress`), so the Worker logs
   * exactly one timeline per spawn and never a fake duration.
   */
  async markJobStarted(jobId: number, runnerName?: string): Promise<SpawnTimeline | null> {
    let row = runnerName ? this.#rowByRunner(runnerName) : undefined;
    if (!row) row = this.#rowByJob(jobId);
    if (!row || row.state === "destroying" || row.job_started_at !== null) return null;

    const now = Date.now();
    this.#sql.exec(`UPDATE jobs SET job_started_at = ? WHERE job_id = ?`, now, row.job_id);
    return {
      jobId: row.job_id,
      runnerName: row.runner_name,
      createdAt: row.created_at,
      provisionStartedAt: row.provision_started_at,
      bootedAt: row.booted_at,
      jobStartedAt: now,
    };
  }

  /**
   * Provisioning failed (JIT mint / createSandbox / launch threw). Frees the
   * slot immediately rather than holding it until the reaper, and hands back the
   * next pending job to boot.
   *
   * If the failure happened AFTER a VM was created, the row is not dropped: it
   * flips to `destroying` (carrying `sandboxId`, which the row may not have
   * learned yet if recordSandboxCreated is what failed) and the teardown is
   * returned for the Worker to run. Deleting it instead — as this used to —
   * threw away the only durable record of a live VM, so a destroy that then
   * failed leaked it forever, invisibly: the runner never launched, so the VM
   * never self-deletes either. `destroying` is retried by the reaper until it
   * confirms, and does not count against the cap, so the slot still frees at
   * once. Leaves an existing `destroying` row alone — a raced `completed`
   * already claimed that teardown.
   */
  async markProvisionFailed(jobId: number, sandboxId?: string): Promise<ProvisionFailedResult> {
    const row = this.#rowByJob(jobId);
    let toDestroy: TeardownTask | null = null;
    const vm = sandboxId ?? row?.sandbox_id ?? null;

    if (row && row.state !== "destroying") {
      toDestroy = this.#retireRow(row, vm);
    } else if (!row && vm) {
      // A raced `completed` already dropped the row, but we hold a live VM. There
      // is nothing left to persist the teardown against, so hand it back to be
      // destroyed now and let the orphaned-sandbox sweep backstop a failure.
      toDestroy = { jobId, sandboxId: vm };
    }
    return { toDestroy, nextPending: this.#dequeuePending() };
  }

  /**
   * A job completed (any conclusion, including cancelled). Tears down the VM
   * that ACTUALLY ran the job, identified by runner name: under backlog GitHub
   * may assign our shared-label runner a different queued job than the one that
   * triggered provisioning, so job_id alone is the wrong owner. Falls back to
   * job_id (steady state / cancelled before pickup). Keeps the row in
   * `destroying` until the Worker confirms teardown, then frees the next slot.
   */
  async onCompleted(jobId: number, runnerName?: string): Promise<CompletedResult> {
    let row = runnerName ? this.#rowByRunner(runnerName) : undefined;
    if (!row) row = this.#rowByJob(jobId);

    if (!row || row.state === "destroying") {
      // unknown job, redelivery, or teardown already in flight → no-op destroy.
      return { toDestroy: null, nextPending: this.#dequeuePending() };
    }

    const toDestroy = this.#retireRow(row);
    return { toDestroy, nextPending: this.#dequeuePending() };
  }

  /** Confirms a VM was destroyed: removes its `destroying` row. */
  async markDestroyed(jobId: number): Promise<void> {
    this.#sql.exec(`DELETE FROM jobs WHERE job_id = ? AND state = 'destroying'`, jobId);
  }

  /**
   * Promotes the oldest pending job (FIFO on `created_at`) to provisioning and
   * starts its provisioning clock; returns it, or null. Without that clock reset
   * the job inherits the age it accrued waiting for a slot and is eligible for
   * reaping before its VM can finish booting — see ROW_AGE.
   */
  #dequeuePending(): PendingJob | null {
    const cap = this.#maxConcurrent();
    if (cap > 0 && this.#active() >= cap) return null;
    const rows = this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE state = 'pending' ORDER BY created_at ASC LIMIT 1`)
      .toArray();
    const row = rows[0];
    if (!row) return null;
    this.#sql.exec(
      `UPDATE jobs SET state = 'provisioning', provision_started_at = ? WHERE job_id = ?`,
      Date.now(),
      row.job_id,
    );
    return this.#toPending(row);
  }

  /**
   * Promotes as many pending jobs as freed capacity allows (oldest-first)
   * through the same canonical #dequeuePending path a completion uses. Slot
   * release is spread across several methods (completion, provision-failure,
   * reaper, reconciler); the single-slot events promote one, but a bulk reap
   * can vacate several at once, so those drain to the cap. Returns the jobs the
   * Worker must boot — without this, reaping a runner-less VM would free a slot
   * that no pending job is ever pulled into (its `queued` webhook already fired
   * once), stranding it until the age reaper.
   */
  #drainPending(): PendingJob[] {
    const promoted: PendingJob[] = [];
    for (let next = this.#dequeuePending(); next; next = this.#dequeuePending()) {
      promoted.push(next);
    }
    return promoted;
  }

  /**
   * Reconciler teardown: VMs whose runner never came online. `onlineRunners` is
   * the set of runner names GitHub reports as registered right now; an
   * `provisioning`/`running` row older than graceMs whose recorded runner name
   * is absent booted a VM that never registered a runner (bad JIT config, guest
   * crash) or a `running` VM whose `completed` webhook we missed. Unlike `sweep`
   * (age-only, can't tell a busy VM from an orphan) this keys on live runner
   * identity, so a long-running job is spared as long as its runner is online.
   * Rows with a VM flip to `destroying` (the Worker tears them down + confirms
   * via markDestroyed, freeing the row so a still-queued job can be
   * re-provisioned next reconcile); rows without a VM are dropped outright. The
   * grace window keeps a normally-booting runner — registration lags VM create
   * by seconds — from being reaped mid-boot.
   */
  async reapUnregistered(
    nowMs: number,
    onlineRunners: string[],
    graceMs: number,
  ): Promise<ReapResult> {
    const cutoff = nowMs - graceMs;
    const online = new Set(onlineRunners);
    const toDestroy: TeardownTask[] = [];
    for (const r of this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE state IN ${ACTIVE_STATES} AND ${ROW_AGE} < ?`, cutoff)
      .toArray()) {
      if (r.runner_name && online.has(r.runner_name)) continue; // runner live → healthy
      const task = this.#retireRow(r);
      if (task) toDestroy.push(task);
    }
    return { toDestroy, nextPending: this.#drainPending() };
  }

  /**
   * Reaper: returns every VM the Worker should (re)destroy —
   *   1. `destroying` rows whose teardown was never confirmed (destroy
   *      failed/pending); destroy is idempotent + NotFound-safe so re-issuing
   *      an in-flight one is harmless.
   *   2. `running` / `provisioning` orphans older than maxAgeMs (missed
   *      `completed` webhook, stuck boot), flipped to `destroying`.
   * Rows that never got a VM are dropped outright. The Worker destroys each and
   * confirms via markDestroyed; a failed destroy stays `destroying` for the
   * next sweep.
   */
  async sweep(nowMs: number, maxAgeMs: number): Promise<ReapResult> {
    const cutoff = nowMs - maxAgeMs;
    const toDestroy: TeardownTask[] = [];

    for (const row of this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE state = 'destroying'`)
      .toArray()) {
      const task = this.#retireRow(row);
      if (task) toDestroy.push(task);
    }

    for (const row of this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE state IN ${ACTIVE_STATES} AND ${ROW_AGE} < ?`, cutoff)
      .toArray()) {
      const task = this.#retireRow(row);
      if (task) toDestroy.push(task);
    }

    this.#sql.exec(`DELETE FROM jobs WHERE state = 'pending' AND created_at < ?`, cutoff);
    this.#sql.exec(`DELETE FROM deliveries WHERE seen_at < ?`, cutoff);
    // Stale-orphan teardowns above vacated slots; pull surviving pending jobs in.
    return { toDestroy, nextPending: this.#drainPending() };
  }
}
