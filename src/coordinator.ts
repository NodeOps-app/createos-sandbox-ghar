import { DurableObject } from "cloudflare:workers";
import type { QueuedDecision, PendingJob, CompletedResult, ReapResult } from "./types";

interface Env {
  MAX_CONCURRENT: string;
}

type Row = {
  job_id: number;
  run_id: number;
  repo: string;
  sandbox_id: string | null;
  state: string;
  created_at: number;
  booted_at: number | null;
};

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
        state       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        booted_at   INTEGER
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        seen_at     INTEGER NOT NULL
      );
    `);
  }

  #maxConcurrent(): number {
    return Number(this.env.MAX_CONCURRENT ?? "0") || 0;
  }

  #active(): number {
    const r = this.#sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE state IN ('provisioning','running')`)
      .one();
    return r.n;
  }

  async activeCount(): Promise<number> {
    return this.#active();
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

    const existing = this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE job_id = ?`, job.jobId)
      .toArray();
    if (existing.length > 0) {
      return { action: "ignore", jobId: job.jobId }; // already tracked (redelivery)
    }

    const cap = this.#maxConcurrent();
    const atCap = cap > 0 && this.#active() >= cap;
    const state = atCap ? "pending" : "provisioning";
    this.#sql.exec(
      `INSERT INTO jobs (job_id, run_id, repo, sandbox_id, state, created_at, booted_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
      job.jobId,
      job.runId,
      job.repoFullName,
      state,
      now,
    );
    return { action: atCap ? "queued" : "provision", jobId: job.jobId };
  }

  /** Records the booted VM id and flips provisioning → running. */
  async markRunning(jobId: number, sandboxId: string): Promise<void> {
    this.#sql.exec(
      `UPDATE jobs SET sandbox_id = ?, state = 'running', booted_at = ? WHERE job_id = ?`,
      sandboxId,
      Date.now(),
      jobId,
    );
  }

  /**
   * A job completed (any conclusion, including cancelled). Returns the VM to
   * destroy (if one booted) and the next pending job to provision (if a slot
   * freed). If the job never booted (still pending), just drops it.
   */
  async onCompleted(jobId: number): Promise<CompletedResult> {
    const rows = this.#sql.exec<Row>(`SELECT * FROM jobs WHERE job_id = ?`, jobId).toArray();
    const row = rows[0];
    const sandboxIdToDestroy = row?.sandbox_id ?? null;
    this.#sql.exec(`DELETE FROM jobs WHERE job_id = ?`, jobId);
    return { sandboxIdToDestroy, nextPending: this.#dequeuePending() };
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
   * Reaper: finds jobs older than maxAgeMs that still hold a sandbox (booted
   * but never completed — missed webhook / stuck). Returns their VM ids and
   * clears the rows. Also drops stale never-booted rows.
   */
  async sweep(nowMs: number, maxAgeMs: number): Promise<ReapResult> {
    const cutoff = nowMs - maxAgeMs;
    const stale = this.#sql
      .exec<Row>(`SELECT * FROM jobs WHERE created_at < ?`, cutoff)
      .toArray();
    const sandboxIdsToDestroy = stale
      .map((r) => r.sandbox_id)
      .filter((s): s is string => s !== null);
    this.#sql.exec(`DELETE FROM jobs WHERE created_at < ?`, cutoff);
    this.#sql.exec(`DELETE FROM deliveries WHERE seen_at < ?`, cutoff);
    return { sandboxIdsToDestroy };
  }
}
