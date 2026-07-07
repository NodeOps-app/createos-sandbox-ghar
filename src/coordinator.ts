import { DurableObject } from "cloudflare:workers";
import type {
  QueuedDecision,
  PendingJob,
  CompletedResult,
  ReapResult,
  SandboxRecordDecision,
  ProvisionFailedResult,
  TeardownTask,
} from "./types";

interface Env {
  MAX_CONCURRENT: string;
}

type Row = {
  job_id: number;
  run_id: number;
  repo: string;
  sandbox_id: string | null;
  runner_name: string | null;
  state: string;
  created_at: number;
  booted_at: number | null;
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

export class Coordinator extends DurableObject<Env> {
  #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id      INTEGER PRIMARY KEY,
        run_id      INTEGER NOT NULL,
        repo        TEXT NOT NULL,
        sandbox_id  TEXT,
        runner_name TEXT,
        state       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        booted_at   INTEGER
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        seen_at     INTEGER NOT NULL
      );
    `);
    // Migrate DOs created before runner-identity teardown: add the column if a
    // pre-existing `jobs` table lacks it (CREATE TABLE IF NOT EXISTS won't).
    const cols = this.#sql.exec(`PRAGMA table_info(jobs)`).toArray() as { name: string }[];
    if (!cols.some((c) => c.name === "runner_name")) {
      this.#sql.exec(`ALTER TABLE jobs ADD COLUMN runner_name TEXT`);
    }
  }

  #maxConcurrent(): number {
    return Number(this.env.MAX_CONCURRENT ?? "0") || 0;
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

  #rowByJob(jobId: number): Row | undefined {
    return this.#sql.exec<Row>(`SELECT * FROM jobs WHERE job_id = ?`, jobId).toArray()[0];
  }

  #rowByRunner(runnerName: string): Row | undefined {
    return this.#sql.exec<Row>(`SELECT * FROM jobs WHERE runner_name = ?`, runnerName).toArray()[0];
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
    this.#sql.exec(
      `INSERT INTO jobs (job_id, run_id, repo, sandbox_id, runner_name, state, created_at, booted_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`,
      job.jobId,
      job.runId,
      job.repoFullName,
      state,
      now,
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
   * Provisioning failed (JIT mint / createSandbox / launch threw). Drops the
   * row so the slot frees immediately instead of being held until the reaper,
   * and hands back the next pending job to boot. Leaves a `destroying` row
   * alone — a raced `completed` already claimed that teardown.
   */
  async markProvisionFailed(jobId: number): Promise<ProvisionFailedResult> {
    this.#sql.exec(
      `DELETE FROM jobs WHERE job_id = ? AND state IN ('provisioning','pending')`,
      jobId,
    );
    return { nextPending: this.#dequeuePending() };
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

    let toDestroy: TeardownTask | null = null;
    if (row.sandbox_id) {
      this.#sql.exec(`UPDATE jobs SET state = 'destroying' WHERE job_id = ?`, row.job_id);
      toDestroy = { jobId: row.job_id, sandboxId: row.sandbox_id };
    } else {
      // Never booted a VM (still pending / provisioning) → just drop the row.
      this.#sql.exec(`DELETE FROM jobs WHERE job_id = ?`, row.job_id);
    }
    return { toDestroy, nextPending: this.#dequeuePending() };
  }

  /** Confirms a VM was destroyed: removes its `destroying` row. */
  async markDestroyed(jobId: number): Promise<void> {
    this.#sql.exec(`DELETE FROM jobs WHERE job_id = ? AND state = 'destroying'`, jobId);
  }

  /** Promotes the oldest pending job to provisioning; returns it, or null. */
  #dequeuePending(): PendingJob | null {
    const cap = this.#maxConcurrent();
    if (cap > 0 && this.#active() >= cap) return null;
    const rows = this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE state = 'pending' ORDER BY created_at ASC LIMIT 1`)
      .toArray();
    const row = rows[0];
    if (!row) return null;
    this.#sql.exec(`UPDATE jobs SET state = 'provisioning' WHERE job_id = ?`, row.job_id);
    return { jobId: row.job_id, runId: row.run_id, repoFullName: row.repo };
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
      .exec<Row>(`SELECT * FROM jobs WHERE state IN ${ACTIVE_STATES} AND created_at < ?`, cutoff)
      .toArray()) {
      if (r.runner_name && online.has(r.runner_name)) continue; // runner live → healthy
      if (r.sandbox_id) {
        this.#sql.exec(`UPDATE jobs SET state = 'destroying' WHERE job_id = ?`, r.job_id);
        toDestroy.push({ jobId: r.job_id, sandboxId: r.sandbox_id });
      } else {
        this.#sql.exec(`DELETE FROM jobs WHERE job_id = ?`, r.job_id); // never booted a VM
      }
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

    for (const r of this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE state = 'destroying'`)
      .toArray()) {
      if (r.sandbox_id) toDestroy.push({ jobId: r.job_id, sandboxId: r.sandbox_id });
      else this.#sql.exec(`DELETE FROM jobs WHERE job_id = ?`, r.job_id);
    }

    const stale = this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE state IN ${ACTIVE_STATES} AND created_at < ?`, cutoff)
      .toArray();
    for (const r of stale) {
      if (r.sandbox_id) {
        this.#sql.exec(`UPDATE jobs SET state = 'destroying' WHERE job_id = ?`, r.job_id);
        toDestroy.push({ jobId: r.job_id, sandboxId: r.sandbox_id });
      } else {
        this.#sql.exec(`DELETE FROM jobs WHERE job_id = ?`, r.job_id); // never got a VM
      }
    }

    this.#sql.exec(`DELETE FROM jobs WHERE state = 'pending' AND created_at < ?`, cutoff);
    this.#sql.exec(`DELETE FROM deliveries WHERE seen_at < ?`, cutoff);
    // Stale-orphan teardowns above vacated slots; pull surviving pending jobs in.
    return { toDestroy, nextPending: this.#drainPending() };
  }
}
