import { describe, expect, it } from "vitest";
import {
  discoverQueuedJobs,
  type DiscoveryClient,
  type DiscoveryOptions,
} from "../../src/discovery";
import type { QueuedJob } from "../../src/types";

/**
 * A fake GitHub transport whose subrequest meter mirrors the real cost shape:
 * the repo-list fetch costs `listCost` (default 1 page), each repo costs 2 for
 * the queued/in_progress run reads, and each active run costs 1 for its jobs.
 * Records which repos it actually scanned so coverage can be asserted directly.
 */
class FakeClient implements DiscoveryClient {
  #n = 0;
  visited: string[] = [];
  constructor(
    private repos: string[],
    private opts: { listCost?: number; runsPerRepo?: number; jobsPerRun?: number } = {},
  ) {}

  get subrequests(): number {
    return this.#n;
  }

  async installationRepos(): Promise<string[]> {
    this.#n += this.opts.listCost ?? 1;
    return this.repos;
  }

  async activeRunIds(repo: string): Promise<number[]> {
    this.#n += 2;
    this.visited.push(repo);
    return Array.from({ length: this.opts.runsPerRepo ?? 1 }, (_, i) => i + 1);
  }

  async queuedJobs(repo: string, runId: number): Promise<QueuedJob[]> {
    this.#n += 1;
    return Array.from({ length: this.opts.jobsPerRun ?? 1 }, () => ({
      jobId: this.#n,
      runId,
      repoFullName: repo,
      labels: ["createos"],
    }));
  }
}

const base: Omit<DiscoveryOptions, "cursor"> = {
  budget: 1000,
  policy: "org-wide",
  allowlist: [],
};

describe("discoverQueuedJobs", () => {
  it("scans every repo under an ample budget and cursors the last one", async () => {
    const client = new FakeClient(["a", "b", "c"]);
    const { jobs, coverage } = await discoverQueuedJobs(client, { ...base, cursor: null });

    expect(client.visited).toEqual(["a", "b", "c"]);
    expect(coverage).toMatchObject({
      covered: 3,
      deferred: 0,
      budgetBound: false,
      nextCursor: "c",
    });
    expect(jobs.map((j) => j.repoFullName)).toEqual(["a", "b", "c"]);
  });

  // Repos are scanned in concurrent batches, and the budget is checked at BATCH
  // boundaries — so a tick can overshoot its budget by at most one batch's reads,
  // and coverage/cursor advance a whole batch at a time. 20 repos here so several
  // batches exist to bind between.
  const twenty = Array.from({ length: 20 }, (_, i) => `r${String(i).padStart(2, "0")}`);

  it("stops at the first batch boundary past the budget, deferring the rest", async () => {
    // list costs 1, each repo costs 3 (2 run reads + 1 job read). The first batch
    // is committed to at spent=1 (< 5) and costs 8*3=24; the next boundary's
    // pre-check (25 >= 5) binds.
    const client = new FakeClient(twenty);
    const { coverage } = await discoverQueuedJobs(client, { ...base, budget: 5, cursor: null });

    expect(coverage.budgetBound).toBe(true);
    expect(coverage.covered).toBe(8);
    expect(coverage.deferred).toBe(12);
    // The cursor is the LAST repo of the completed batch in list order — never
    // whichever concurrent read happened to settle last.
    expect(coverage.nextCursor).toBe("r07");
    expect(new Set(client.visited)).toEqual(new Set(twenty.slice(0, 8)));
    // Overshoot is bounded by one batch, not unbounded.
    expect(client.subrequests).toBeLessThanOrEqual(5 + 8 * 3);
  });

  it("resumes after the cursor and reaches every repo across ticks", async () => {
    const seen = new Set<string>();

    let cursor: string | null = null;
    for (let tick = 0; tick < 3; tick++) {
      const client = new FakeClient(twenty);
      const { coverage } = await discoverQueuedJobs(client, { ...base, budget: 5, cursor });
      for (const r of client.visited) seen.add(r);
      cursor = coverage.nextCursor;
    }

    // Three budget-bound ticks (8 + 8 + 4 repos) cover the whole installation.
    expect(seen).toEqual(new Set(twenty));
  });

  it("under repo-allowlist scans only admissible repos", async () => {
    const client = new FakeClient(["a", "b", "c"]);
    const { jobs, coverage } = await discoverQueuedJobs(client, {
      ...base,
      policy: "repo-allowlist",
      allowlist: ["a", "c"],
      cursor: null,
    });

    expect(client.visited).toEqual(["a", "c"]);
    expect(coverage).toMatchObject({ covered: 2, deferred: 0, budgetBound: false });
    expect(jobs.every((j) => j.repoFullName !== "b")).toBe(true);
  });

  it("returns the incoming cursor unchanged when nothing is scanned", async () => {
    // Budget smaller than the repo-list fetch itself: bound before any repo,
    // and coverage must NOT rewind — it carries the prior cursor forward.
    const client = new FakeClient(["a", "b"], { listCost: 3 });
    const { jobs, coverage } = await discoverQueuedJobs(client, {
      ...base,
      budget: 2,
      cursor: "b",
    });

    expect(client.visited).toEqual([]);
    expect(jobs).toEqual([]);
    expect(coverage).toMatchObject({ covered: 0, budgetBound: true, nextCursor: "b" });
  });

  it("starts from the top when the cursor repo is gone", async () => {
    const client = new FakeClient(["a", "b", "c"]);
    const { coverage } = await discoverQueuedJobs(client, { ...base, cursor: "removed-repo" });

    expect(client.visited).toEqual(["a", "b", "c"]);
    expect(coverage.covered).toBe(3);
  });

  it("handles an empty installation without binding", async () => {
    const client = new FakeClient([]);
    const { jobs, coverage } = await discoverQueuedJobs(client, { ...base, cursor: null });

    expect(jobs).toEqual([]);
    expect(coverage).toMatchObject({
      covered: 0,
      deferred: 0,
      budgetBound: false,
      nextCursor: null,
    });
  });
});
