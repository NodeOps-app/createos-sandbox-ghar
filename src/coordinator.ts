import { DurableObject } from "cloudflare:workers";

export class Coordinator extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
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

  async ping(): Promise<string> {
    return "pong";
  }
}
