import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function stub(name: string) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(name));
}

describe("tenant schema migration", () => {
  it("creates the tenant tables and the jobs.tenant_id column", async () => {
    const s = stub("schema-" + Math.random());
    await runInDurableObject(s, async (_instance, state) => {
      const tables = state.storage.sql
        .exec(`SELECT name FROM sqlite_master WHERE type='table'`)
        .toArray()
        .map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(["tenants", "projects", "usage"]));

      const cols = state.storage.sql
        .exec(`PRAGMA table_info(jobs)`)
        .toArray()
        .map((r) => r.name);
      expect(cols).toContain("tenant_id");
    });
  });

  it("existing job flow is untouched by the new schema", async () => {
    const s = stub("schema-flow-" + Math.random());
    const d = await s.onQueued(
      { jobId: 1, runId: 1, repoFullName: "acme/x", label: "createos" },
      "d1",
    );
    expect(d.action).toBe("provision");
  });
});
