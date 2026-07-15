import type { Config, QueuedJob, Runner } from "../types";
import { TokenCache } from "./auth";

type FetchLike = typeof fetch;
const UA = "createos-sandbox-ghar";
const MAX_PAGES = 20; // runaway guard for paginated list endpoints

type RunnerLite = { id?: number; name?: string; status?: string; busy?: boolean };
type RepoLite = { full_name?: string };
type RunLite = { id?: number; status?: string };
type JobLite = { id?: number; status?: string; labels?: string[] };

export class GitHubClient {
  #tokens: TokenCache;
  constructor(
    private config: Config,
    // Bound to globalThis so `this.fetchImpl(...)` keeps fetch's own `this`
    // (Workers throws Illegal invocation otherwise).
    private fetchImpl: FetchLike = fetch.bind(globalThis),
  ) {
    this.#tokens = new TokenCache(
      config.githubAppId,
      config.githubAppPrivateKeyPkcs8,
      config.githubInstallationId,
      config.githubApiUrl,
      fetchImpl,
    );
  }

  async #headers(): Promise<HeadersInit> {
    return {
      Authorization: `Bearer ${await this.#tokens.token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      "Content-Type": "application/json",
    };
  }

  /**
   * Creates a JIT ephemeral org runner config; returns encoded_jit_config.
   *
   * The runner carries exactly the ONE label its job asked for. GitHub
   * AND-matches `runs-on` against a runner's labels, so a runner registered with
   * both `createos` and `createos-8vcpu-16gb` would be eligible for bare
   * `createos` jobs while sitting on an 8 vCPU VM. One label per runner keeps
   * each shape's pool disjoint (ADR-0004).
   */
  async generateJitConfig(runnerName: string, label: string): Promise<string> {
    const res = await this.fetchImpl(
      `${this.config.githubApiUrl}/orgs/${this.config.githubOrg}/actions/runners/generate-jitconfig`,
      {
        method: "POST",
        headers: await this.#headers(),
        body: JSON.stringify({
          name: runnerName,
          runner_group_id: this.config.runnerGroupId,
          labels: [label],
          work_folder: "_work",
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`generate-jitconfig failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { encoded_jit_config: string };
    return body.encoded_jit_config;
  }

  /**
   * Resolves whether a workflow run originates from a fork. Only called under
   * the fork-gated policy. Uses the run's head_repository vs the base repo.
   */
  async isForkJob(repoFullName: string, runId: number): Promise<boolean> {
    const res = await this.fetchImpl(
      `${this.config.githubApiUrl}/repos/${repoFullName}/actions/runs/${runId}`,
      { method: "GET", headers: await this.#headers() },
    ).catch(() => null);
    if (!res || !res.ok) return true; // fail closed: treat unknown as fork
    const body = (await res.json()) as {
      head_repository?: { fork?: boolean; owner?: { login?: string } };
    };
    const head = body.head_repository;
    if (!head) return true;
    if (head.fork === true) return true;
    const login = head.owner?.login;
    // An owner we cannot read is an owner we cannot vouch for. Same-org is the
    // ONLY answer that admits a job, so it must be the one we prove, never the
    // one we assume: every other unknown here already fails closed.
    if (!login) return true;
    return login.toLowerCase() !== this.config.githubOrg.toLowerCase();
  }

  async #get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.config.githubApiUrl}${path}`, {
      method: "GET",
      headers: await this.#headers(),
    });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /**
   * GETs every page of a list endpoint (per_page=100) and concatenates
   * `body[key]`, so a backlog spanning pages is never silently truncated —
   * exactly the high-volume case the reconciler exists to serve. Caps at
   * MAX_PAGES as a runaway guard.
   *
   * `strict` is for callers that test for ABSENCE. A truncated list is a lie by
   * omission to them: the runner-liveness oracle would read a live runner's
   * missing page as "runner gone" and destroy its VM mid-job. They get an error
   * and skip the step rather than act on a half-view. Callers that merely
   * enumerate (queued jobs) keep the warn-and-return-partial behaviour.
   */
  async #getPaged<T>(path: string, key: string, strict = false): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    const out: T[] = [];
    let page = 1;
    let declaredTotal: number | undefined;
    for (; page <= MAX_PAGES; page++) {
      const body = await this.#get<Record<string, unknown>>(
        `${path}${sep}per_page=100&page=${page}`,
      );
      const raw = body[key];
      // A strict caller tests for ABSENCE, so a 200 whose list key is missing or
      // not an array is the same lie by omission as a truncated page: coercing it
      // to `[]` reads as "nothing there" and would reap every live VM at once.
      // Refuse it. A genuinely empty list arrives as `[]` — present, iterable —
      // and passes cleanly.
      if (strict && !Array.isArray(raw)) {
        throw new Error(
          `getPaged: ${path} page ${page} has no array "${key}" — refusing to under-report`,
        );
      }
      if (typeof body.total_count === "number") {
        declaredTotal =
          declaredTotal === undefined
            ? body.total_count
            : Math.max(declaredTotal, body.total_count);
      }
      const items = (raw ?? []) as T[];
      out.push(...items);
      if (items.length < 100) break;
    }
    // Full last page at the page cap → more results likely exist but were dropped.
    // Never truncate coverage silently: surface the bound so it can be raised.
    if (page > MAX_PAGES) {
      const msg = `getPaged: hit MAX_PAGES=${MAX_PAGES} for ${path} — results truncated (${out.length} items collected)`;
      if (strict) throw new Error(msg);
      console.warn(msg);
    }
    // GitHub states the full count alongside the page. For a strict caller, a
    // total we fell short of is proof of omission the array shape alone can't
    // show (e.g. `{total_count:1, runners:[]}`) — the same under-report, self-
    // declared. The HIGHEST count seen across pages is the bar, not the last:
    // offset pagination over a set that shrinks mid-scan (a runner deregisters
    // between pages) can shift a still-live runner into an already-read page and
    // return a short final page with a lowered total — using the last count
    // would rubber-stamp that omission, so a destructive-absence oracle must
    // fail closed on any shrink. A shortfall throws; collecting MORE than the max
    // (a registration mid-scan) is not a teardown risk and passes.
    //
    // KNOWN RESIDUAL (not closed here, by design): count equality cannot prove
    // SET completeness under *balanced* mid-scan turnover — one runner leaves and
    // another joins between pages, keeping the total equal while a live runner
    // shifts out of an already-read page and vanishes. Only reachable with >100
    // org runners (multi-page), a degraded state the orphan sweep exists to
    // prevent. Truly closing it means confirming a specific runner's absence
    // against GitHub (single-runner / name-filtered GET) in the REAP path before
    // destroying — one subrequest per candidate, which is the subrequest-budget
    // redesign's call to make, not this transport's. Tracked with that work.
    if (strict && declaredTotal !== undefined && out.length < declaredTotal) {
      throw new Error(
        `getPaged: ${path} returned ${out.length} of ${declaredTotal} declared — refusing to under-report`,
      );
    }
    return out;
  }

  /**
   * Every org runner GitHub knows about. Serves both reconciler reads off one
   * call: `status` is the liveness oracle (a tracked VM whose recorded `cos-…`
   * runner is not `online` booted but never registered, or has already exited,
   * so its slot is dead), and `id` is what an orphaned registration is deleted
   * by. Strict paging — see #getPaged.
   */
  async listRunners(): Promise<Runner[]> {
    const runners = await this.#getPaged<RunnerLite>(
      `/orgs/${this.config.githubOrg}/actions/runners`,
      "runners",
      true,
    );
    const out: Runner[] = [];
    for (const r of runners) {
      // A record we can't read as a live/dead runner is a lie by omission to a
      // caller that tests for ABSENCE, exactly like a truncated page: a dropped
      // record — or a status that isn't the online/offline the oracle compares
      // against — makes a live runner read as "gone", and reapUnregistered then
      // destroys its VM mid-job. Refuse the whole read rather than under-report,
      // same contract as strict paging above. `status` is validated to the two
      // values GitHub actually returns so an unexpected one can't slip through as
      // not-online. (`busy` stays lenient — default false: it only gates the
      // orphan sweep, which is backstopped by the Coordinator row check, and the
      // real API always sends it; requiring it would reject nothing GitHub emits
      // while breaking every mock that omits it.)
      if (
        typeof r.id !== "number" ||
        typeof r.name !== "string" ||
        !r.name ||
        (r.status !== "online" && r.status !== "offline")
      ) {
        throw new Error(
          `listRunners: malformed runner record (id=${JSON.stringify(r.id)}, name=${JSON.stringify(r.name)}, status=${JSON.stringify(r.status)}) — refusing to under-report live runners`,
        );
      }
      out.push({ id: r.id, name: r.name, status: r.status, busy: r.busy === true });
    }
    return out;
  }

  /**
   * Deletes a runner registration. GitHub auto-removes an ephemeral runner only
   * once it has COMPLETED a job; every registration we mint for a job that never
   * ran one (createSandbox failed, job cancelled mid-boot, VM reaped before
   * pickup) is ours to clean up or it lingers `offline` forever.
   *
   * 404 is success: GitHub, a self-completing runner, or a concurrent sweep
   * already removed it. Keeps the sweeper idempotent across overlapping crons.
   */
  async deleteRunner(id: number): Promise<void> {
    const res = await this.fetchImpl(
      `${this.config.githubApiUrl}/orgs/${this.config.githubOrg}/actions/runners/${id}`,
      { method: "DELETE", headers: await this.#headers() },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`delete runner ${id} failed: ${res.status} ${await res.text()}`);
    }
  }

  /**
   * Every workflow_job GitHub still reports as `queued` — the reconciler's
   * source of truth for jobs needing a runner, independent of whether we ever
   * saw (or lost) their `queued` webhook. Scans the app's installed repos; a
   * partly-drained matrix run is `in_progress` with its remaining jobs still
   * `queued`, so both run statuses are inspected.
   *
   * Dumb transport: returns every queued job with its raw labels, unfiltered.
   * Which job is ours and which shape (if any) it names is an admission decision
   * (`identifyJob`/`createJobAdmission` in admission.ts) that belongs to the
   * caller, not this client — deciding it here would also steal the job id
   * out of any warning the caller wants to log about it.
   */
  async listQueuedJobs(): Promise<QueuedJob[]> {
    const out: QueuedJob[] = [];
    for (const repo of await this.#installationRepos()) {
      for (const runId of await this.#activeRunIds(repo)) {
        out.push(...(await this.#queuedJobs(repo, runId)));
      }
    }
    return out;
  }

  async #installationRepos(): Promise<string[]> {
    const repos = await this.#getPaged<RepoLite>("/installation/repositories", "repositories");
    const full: string[] = [];
    for (const r of repos) if (r.full_name) full.push(r.full_name);
    return full;
  }

  /**
   * Run ids GitHub reports as `queued`/`in_progress` for a repo. Queried once
   * per status (the REST `status` filter takes a single value) so pagination
   * walks only the active runs, never the repo's entire completed-run history.
   */
  async #activeRunIds(repoFullName: string): Promise<number[]> {
    const ids = new Set<number>();
    for (const status of ["queued", "in_progress"] as const) {
      const runs = await this.#getPaged<RunLite>(
        `/repos/${repoFullName}/actions/runs?status=${status}`,
        "workflow_runs",
      );
      for (const run of runs) if (typeof run.id === "number") ids.add(run.id);
    }
    return [...ids];
  }

  async #queuedJobs(repoFullName: string, runId: number): Promise<QueuedJob[]> {
    const jobs = await this.#getPaged<JobLite>(
      `/repos/${repoFullName}/actions/runs/${runId}/jobs?filter=latest`,
      "jobs",
    );
    const out: QueuedJob[] = [];
    for (const j of jobs) {
      if (j.status !== "queued" || typeof j.id !== "number") continue;
      out.push({ jobId: j.id, runId, repoFullName, labels: j.labels ?? [] });
    }
    return out;
  }
}
