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

  it("stops at the budget and defers the remaining repos", async () => {
    // list costs 1, each repo costs 3 (2 run reads + 1 job read). Spent after
    // a=4, after b=7; the 3rd repo's pre-check (7 >= 5) binds. So 2 covered.
    const client = new FakeClient(["a", "b", "c", "d"]);
    const { coverage } = await discoverQueuedJobs(client, { ...base, budget: 5, cursor: null });

    expect(coverage.budgetBound).toBe(true);
    expect(coverage.covered).toBe(2);
    expect(coverage.deferred).toBe(2);
    expect(coverage.nextCursor).toBe("b");
    expect(client.visited).toEqual(["a", "b"]);
  });

  it("resumes after the cursor and reaches every repo across ticks", async () => {
    const repos = ["a", "b", "c"];
    const seen = new Set<string>();

    let cursor: string | null = null;
    for (let tick = 0; tick < 2; tick++) {
      const client = new FakeClient(repos);
      const { coverage } = await discoverQueuedJobs(client, { ...base, budget: 5, cursor });
      for (const r of client.visited) seen.add(r);
      cursor = coverage.nextCursor;
    }

    // Two budget-bound ticks (2 repos each) cover the whole installation.
    expect(seen).toEqual(new Set(["a", "b", "c"]));
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
