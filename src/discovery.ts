import type { ProvisionPolicy, QueuedJob } from "./types";

/**
 * The narrow GitHub transport the recovery scan drives. A subset of
 * `GitHubClient` so tests can supply a fake without a real client, and so the
 * scan cannot reach anything but these three reads plus the subrequest meter.
 */
export interface DiscoveryClient {
  /** Cumulative paged GET subrequests issued so far (pagination counted). */
  readonly subrequests: number;
  installationRepos(): Promise<string[]>;
  activeRunIds(repo: string): Promise<number[]>;
  queuedJobs(repo: string, runId: number): Promise<QueuedJob[]>;
}

export interface DiscoveryOptions {
  /**
   * Max GitHub subrequests this scan may spend before it stops and defers the
   * rest to a later tick. Bounds the O(installed-repos) read fan-out so it can
   * never blow the Free-plan 50-subrequest invocation cap as the org grows.
   */
  budget: number;
  /**
   * The repo full-name this scan last covered (from the Coordinator). The scan
   * resumes at the repo *after* it, wrapping — so budget-deferred repos are
   * reached on following ticks (eventual coverage) instead of the head being
   * re-scanned forever. `null` starts from the top of the list.
   */
  cursor: string | null;
  policy: ProvisionPolicy;
  /** Full names, e.g. "nodeops-app/api". Only consulted under `repo-allowlist`. */
  allowlist: string[];
}

export interface DiscoveryCoverage {
  /** Repos fully scanned this tick. */
  covered: number;
  /** Repos left unscanned because the budget bound. */
  deferred: number;
  /** True when the budget stopped the scan before every repo was covered. */
  budgetBound: boolean;
  /**
   * The repo to resume after next tick — persist to the Coordinator. Carries the
   * incoming cursor forward unchanged when nothing was scanned, so a budget too
   * small to cover even one repo cannot silently rewind coverage.
   */
  nextCursor: string | null;
}

export interface DiscoveryResult {
  jobs: QueuedJob[];
  coverage: DiscoveryCoverage;
}

/**
 * Rotates `repos` so iteration begins at the entry *after* `startAfter`,
 * wrapping to the front. An unknown/removed cursor (or `null`) starts at index
 * 0. This is what turns a budget-bounded partial scan into round-robin eventual
 * coverage across ticks.
 */
function resumeAfter(repos: string[], startAfter: string | null): string[] {
  if (startAfter === null) return repos;
  const idx = repos.indexOf(startAfter);
  if (idx < 0) return repos;
  return [...repos.slice(idx + 1), ...repos.slice(0, idx + 1)];
}

/**
 * The recovery scan: every still-`queued` workflow_job GitHub knows about,
 * independent of whether we ever saw (or lost) its `queued` webhook — but bounded
 * by a subrequest budget and resumed by a repo cursor so its cost stays inside
 * the Cloudflare invocation envelope as installed repos grow.
 *
 * Fan-out is `1 (+pages) repo list + per repo: 2 run-status reads + 1 job read
 * per active run`. The budget is checked at each *repo* boundary, so a repo is
 * always scanned whole (its jobs are never half-collected) and the scan can
 * overshoot the budget by at most one repo's cost — keep the budget's slack
 * under the 50-cap accordingly. Returned coverage lets the caller (which owns
 * the tick context) warn loudly when the budget binds.
 *
 * Transport-dumb by construction: raw labels, no admission decision here — that
 * belongs to `createJobAdmission`. Under `repo-allowlist` the scan skips repos
 * policy could never admit; under `org-wide`/`fork-gated` the cursor carries
 * eventual coverage of the whole installation.
 */
export async function discoverQueuedJobs(
  client: DiscoveryClient,
  opts: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const start = client.subrequests;
  const spent = () => client.subrequests - start;

  const all = await client.installationRepos();
  const eligible =
    opts.policy === "repo-allowlist" ? all.filter((r) => opts.allowlist.includes(r)) : all;
  const ordered = resumeAfter(eligible, opts.cursor);

  const jobs: QueuedJob[] = [];
  let covered = 0;
  let lastScanned: string | null = null;
  let budgetBound = false;

  for (const repo of ordered) {
    // Budget is spent by the repo-list fetch and prior repos; check before
    // committing to another whole repo so a repo's jobs are never half-read.
    if (spent() >= opts.budget) {
      budgetBound = true;
      break;
    }
    for (const runId of await client.activeRunIds(repo)) {
      jobs.push(...(await client.queuedJobs(repo, runId)));
    }
    covered++;
    lastScanned = repo;
  }

  return {
    jobs,
    coverage: {
      covered,
      deferred: ordered.length - covered,
      budgetBound,
      nextCursor: lastScanned ?? opts.cursor,
    },
  };
}
