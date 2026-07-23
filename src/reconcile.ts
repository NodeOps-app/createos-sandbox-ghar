/**
 * Cron-side self-healing: the Reconciler (re-drive lost jobs, reap runner-less
 * VMs, delete orphaned registrations, sweep unowned sandboxes) and the age-only
 * Reaper backstop. Extracted from handler.ts so the webhook hot path and the
 * cron path evolve separately; both share the provisioning/teardown core that
 * stays in handler.ts (provisionAndRecord, destroyAndConfirm).
 */
import type { Bindings } from "./index";
import { loadConfig } from "./config";
import { createJobAdmission, type AdmissionDecision } from "./admission";
import { fetchCatalog } from "./shapes";
import { discoverQueuedJobs } from "./discovery";
import { GitHubClient } from "./github/client";
import {
  jobIdFromRunnerName,
  jobIdFromSandboxName,
  sandboxNamesAreSweepable,
  type SandboxDeps,
} from "./sandbox";
import { makeSandboxClient } from "./createos";
import {
  coordinator,
  provisionAndRecord,
  destroyAndConfirm,
  admitAndDrive,
  warnAdmission,
} from "./handler";
import type { PendingJob, Config, QueuedJob, Runner } from "./types";

/**
 * Deletes at most this many orphaned runner registrations per cron tick.
 *
 * The Free plan caps a Worker invocation at 50 subrequests, and `scheduled` runs
 * the reconciler AND the reaper inside one — a backlog of orphans must not eat
 * the budget that provisioning and teardown need. On the five-minute cron this
 * still clears 120 orphans/hour, far above any plausible leak rate; the
 * remainder waits a tick.
 */
const MAX_RUNNER_DELETES_PER_TICK = 10;

/** Destroys at most this many orphaned VMs per cron tick. Same budget logic as above. */
const MAX_SANDBOX_DESTROYS_PER_TICK = 5;

/**
 * Destroys the microVMs no Coordinator row owns — the last line of defence
 * against a leaked VM, and the only one that works when the DO itself is the
 * thing that failed.
 *
 * Every other teardown path routes through a `destroying` row, so it needs the
 * DO to be reachable at the moment of failure. This one does not: it re-derives
 * ownership from the VM's NAME, which was minted from the job id, so a VM whose
 * teardown record was never written (recordSandboxCreated threw; a raced
 * `completed` dropped the row before we could persist) is still reclaimable. It
 * matters more here than for runners because a leaked VM is not merely clutter —
 * its runner never launched, so it never self-deletes, and it burns capacity for
 * as long as it exists.
 *
 * Same three-part ownership proof as the runner sweep, and the same safety
 * oracle: `onQueued` inserts the job row BEFORE `createRunnerSandbox` creates the
 * VM, so a VM that is merely mid-boot ALWAYS has a live row and is never a
 * target. Listing createos BEFORE reading the DO closes the other direction. A
 * name that does not round-trip through `sandboxNameFor` is not ours (the
 * account also holds hand-made boxes) and is never touched.
 */
async function sweepOrphanedSandboxes(
  env: Bindings,
  config: Config,
  deps: SandboxDeps,
): Promise<void> {
  // A prefix long enough to truncate a minted name makes ownership unprovable,
  // and an unprovable owner here means destroying a VM with a job still on it.
  // Refuse the whole sweep rather than act on names we cannot trust — loudly,
  // because the cost is that leaked VMs stop being reclaimed.
  if (!sandboxNamesAreSweepable(config)) {
    console.warn(
      `sandbox sweep: DISABLED — SANDBOX_NAME_PREFIX="${config.sandboxNamePrefix}" is long enough ` +
        `that createos truncates the VM name, so a VM's job id cannot be proven. Leaked VMs will ` +
        `NOT be reclaimed until the prefix is shortened.`,
    );
    return;
  }

  const client = makeSandboxClient(config, deps);
  const sandboxes = await client.listSandboxes();
  const live = new Set(await coordinator(env).liveJobIds());

  const orphans = sandboxes.filter((s) => {
    if (s.status === "destroyed" || s.status === "failed") return false;
    if (!s.name) return false;
    const jobId = jobIdFromSandboxName(s.name, config);
    return jobId !== null && !live.has(jobId);
  });
  if (orphans.length === 0) return;

  const batch = orphans.slice(0, MAX_SANDBOX_DESTROYS_PER_TICK);
  if (batch.length < orphans.length) {
    console.warn(
      `sandbox sweep: ${orphans.length} orphaned VMs found, destroying ${batch.length} this tick ` +
        `(MAX_SANDBOX_DESTROYS_PER_TICK=${MAX_SANDBOX_DESTROYS_PER_TICK}); the rest follow next cron`,
    );
  }

  const results = await Promise.allSettled(batch.map((s) => s.destroy()));
  const failed = results.filter((r) => r.status === "rejected");
  for (const f of failed) console.error(`sandbox sweep: destroy failed: ${String(f.reason)}`);
  console.log(
    `sandbox sweep: destroyed ${batch.length - failed.length}/${batch.length} orphaned VM(s): ` +
      batch.map((s) => s.name).join(", "),
  );
}

/**
 * Deletes the GitHub runner registrations we minted for jobs that never
 * completed one — createSandbox failed, the job was cancelled mid-boot, the VM
 * was reaped before GitHub assigned it work. GitHub auto-removes an ephemeral
 * runner only when it FINISHES a job, so these linger `offline` forever, and
 * nothing else cleans them up. Left alone they grow without bound until the org
 * runner list crosses #getPaged's page cap — at which point `listRunners` starts
 * refusing to read (strict paging), and the reconciler goes blind rather than
 * reaping healthy VMs off a truncated liveness view.
 *
 * Ownership is proven, never guessed. A registration is deleted only if:
 *   1. its name parses as `cos-<jobId>-<xx>` — ARC runners and hand-registered
 *      boxes don't parse, so they are never touched;
 *   2. GitHub reports it offline and not busy — a live runner is never a target;
 *   3. the Coordinator holds NO row for that job id.
 *
 * (3) is what makes this safe against deleting a runner that is merely booting.
 * A JIT registration exists from the moment it is minted, but its VM takes ~30s
 * to come up, so a healthy boot looks exactly like an orphan to (1) and (2). The
 * DO is what tells them apart: `onQueued` inserts the job row BEFORE the mint,
 * so a booting runner always has a row and an orphan never does. Listing GitHub
 * BEFORE reading the DO closes the other direction — a job that queues mid-sweep
 * isn't in the runner list we're deciding over.
 */
async function sweepOrphanedRunners(
  env: Bindings,
  github: GitHubClient,
  runners: Runner[],
): Promise<void> {
  const live = new Set(await coordinator(env).liveJobIds());

  const orphans = runners.filter((r) => {
    if (r.status !== "offline" || r.busy) return false;
    const jobId = jobIdFromRunnerName(r.name);
    return jobId !== null && !live.has(jobId);
  });
  if (orphans.length === 0) return;

  const batch = orphans.slice(0, MAX_RUNNER_DELETES_PER_TICK);
  if (batch.length < orphans.length) {
    console.warn(
      `runner sweep: ${orphans.length} orphaned registrations found, deleting ${batch.length} this tick ` +
        `(MAX_RUNNER_DELETES_PER_TICK=${MAX_RUNNER_DELETES_PER_TICK}); the rest follow next cron`,
    );
  }

  const results = await Promise.allSettled(batch.map((r) => github.deleteRunner(r.id)));
  const failed = results.filter((r) => r.status === "rejected");
  for (const f of failed) console.error(`runner sweep: delete failed: ${String(f.reason)}`);
  console.log(
    `runner sweep: deleted ${batch.length - failed.length}/${batch.length} orphaned runner registration(s)`,
  );
}

export async function runReaper(env: Bindings, deps: SandboxDeps = {}): Promise<void> {
  const config = loadConfig(env as Record<string, unknown>);
  const co = coordinator(env);
  const { toDestroy, nextPending } = await co.sweep(Date.now(), config.reaperMaxAgeMs);
  await Promise.allSettled([
    ...toDestroy.map((task) => destroyAndConfirm(env, config, task, deps)),
    ...nextPending.map((job) => provisionAndRecord(env, job, deps)),
  ]);
}

/**
 * Multi-mode recovery cursor: `{installationId, repo}` — which tenant the last
 * tick left off at, and (within it) which repo. Malformed/foreign JSON (a
 * stale cursor from before multi mode, or hand-edited storage) restarts
 * rotation from the top rather than throwing, same fail-open posture as the
 * rest of the reconciler.
 */
function parseTenantCursor(
  raw: string | null,
): { installationId: number; repo: string | null } | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { installationId?: unknown; repo?: unknown };
    if (typeof p.installationId !== "number") throw new Error("bad installationId");
    return { installationId: p.installationId, repo: typeof p.repo === "string" ? p.repo : null };
  } catch {
    console.warn(`reconcile: malformed tenant cursor ${JSON.stringify(raw)}; restarting rotation`);
    return null;
  }
}

/**
 * Rotates `scopes` so iteration begins AT the cursor's tenant (not after it) —
 * a tenant whose own repo scan was budget-bound mid-list must be revisited
 * first so its stored repo cursor can resume it, before rotation moves on to
 * the next tenant. An unknown/removed tenant (`startId` undefined, or no
 * longer approved) starts at the top.
 */
function rotateFrom<T extends { tenant: { installationId: number } }>(
  scopes: T[],
  startId: number | undefined,
): T[] {
  if (startId === undefined) return scopes;
  const i = scopes.findIndex((s) => s.tenant.installationId === startId);
  return i < 0 ? scopes : [...scopes.slice(i), ...scopes.slice(0, i)];
}

/**
 * Multi-tenant reconciler. Same four steps as single mode, adapted for N
 * tenant orgs behind one GitHub App installation each:
 *   A. liveness — the ONLINE UNION across every tenant's runner list. All-
 *      or-nothing: reapUnregistered tests for ABSENCE over the whole row set,
 *      so a partial union (one tenant's listRunners failed) would read that
 *      tenant's live runners as gone and destroy them mid-job. One failure
 *      skips the step for every tenant, not just the failed one.
 *   B. recovery — tenants rotate through a cursor `{installationId, repo}`
 *      persisted the same way single mode persists its repo-only cursor, all
 *      sharing ONE subrequest budget per tick so N tenants can't multiply the
 *      Free-plan subrequest cap. Each discovered job re-enters through
 *      `admitAndDrive` — the identical gate ladder the webhook uses, so the
 *      cron path can never admit something the webhook would have refused.
 *   C. orphaned runner registrations — per tenant, off step A's ALREADY-
 *      FETCHED lists (zero extra GitHub cost); skipped under the same
 *      fail-safe as step A.
 *   D. orphaned sandboxes — unchanged from single mode: one DO, VM ownership
 *      keyed on name (not tenant), GitHub-independent. Never gated on the
 *      tenant loop above — see sweepOrphanedSandboxes' own doc comment.
 */
async function runMultiTenantReconciler(
  env: Bindings,
  config: Config,
  deps: SandboxDeps,
): Promise<void> {
  const co = coordinator(env);
  const tenants = (await co.adminListTenants()).filter((t) => t.status === "approved");
  const scopes = tenants.map((t) => ({
    tenant: t,
    gh: new GitHubClient(config, undefined, {
      orgLogin: t.orgLogin,
      installationId: t.installationId,
      runnerGroupId: t.runnerGroupId,
    }),
  }));

  // A. Liveness: see the all-or-nothing rationale above.
  let runnersByTenant: Map<number, Runner[]> | null = new Map();
  try {
    for (const s of scopes) {
      runnersByTenant.set(s.tenant.installationId, await s.gh.listRunners());
    }
  } catch (err) {
    console.error(`reconcile: runner sweep skipped (a tenant list failed): ${String(err)}`);
    runnersByTenant = null;
  }
  if (runnersByTenant) {
    const online = [...runnersByTenant.values()]
      .flat()
      .filter((r) => r.status === "online")
      .map((r) => r.name);
    const { toDestroy, nextPending } = await co.reapUnregistered(
      Date.now(),
      online,
      config.reconcileGraceMs,
    );
    await Promise.allSettled([
      ...toDestroy.map((t) => destroyAndConfirm(env, config, t, deps)),
      ...nextPending.map((j) => provisionAndRecord(env, j, deps)),
    ]);
  }

  // B. Recovery: rotate tenants starting AT the cursor's tenant, one shared
  //    subrequest budget per tick; within a tenant, discoverQueuedJobs' own
  //    repo cursor rotates as before. Recovered jobs re-enter through
  //    admitAndDrive — the SAME gate ladder as the webhook, by construction.
  const rawCursor = await co.recoveryCursor();
  const parsed = parseTenantCursor(rawCursor);
  const order = rotateFrom(scopes, parsed?.installationId);
  let budget = config.recoverySubrequestBudget;
  let nextCursor: string | null = rawCursor;
  for (const s of order) {
    if (budget <= 0) break;
    const start = s.gh.subrequests;
    const { jobs, coverage } = await discoverQueuedJobs(s.gh, {
      budget,
      cursor: s.tenant.installationId === parsed?.installationId ? parsed.repo : null,
      policy: "org-wide", // project gating happens in admitAndDrive, not here
      allowlist: [],
    });
    budget -= s.gh.subrequests - start;
    nextCursor = JSON.stringify({
      installationId: s.tenant.installationId,
      repo: coverage.nextCursor,
    });
    for (const q of jobs) {
      // A single job's admission can throw (fork-check GitHub call failing,
      // malformed JSON) — must not abort the tenant loop or the tick. Skip
      // only this job; GitHub still reports it queued, so it's retried next
      // tick. Steps C/D below (and the reaper, sequenced by the caller) must
      // still run regardless (see AGENTS.md: step D is never GitHub-gated).
      try {
        await admitAndDrive(
          env,
          config,
          {
            action: "queued",
            jobId: q.jobId,
            runId: q.runId,
            repoFullName: q.repoFullName,
            labels: q.labels,
            installationId: s.tenant.installationId,
          },
          { waitUntil: (p) => p.catch((e) => console.error(String(e))) },
          deps,
          "reconcile: ",
        );
      } catch (err) {
        console.error(
          `reconcile: recovery admission failed job=${q.jobId} tenant=${s.tenant.orgLogin}: ${String(err)}`,
        );
      }
    }
    if (coverage.budgetBound) {
      console.warn(
        `reconcile: budget bound at tenant ${s.tenant.orgLogin} — ` +
          `covered ${coverage.covered}, deferred ${coverage.deferred}`,
      );
      break;
    }
  }
  if (nextCursor !== rawCursor) await co.setRecoveryCursor(nextCursor);

  // C. Orphaned registrations: per tenant, REUSING step A's runner lists (no
  //    re-fetch — cost). Same ownership proof as single mode: name parses as
  //    ours + offline + not busy + no live Coordinator row. Skipped under the
  //    same fail-safe as step A — a partial view is never acted on.
  if (runnersByTenant) {
    for (const s of scopes) {
      try {
        await sweepOrphanedRunners(env, s.gh, runnersByTenant.get(s.tenant.installationId) ?? []);
      } catch (err) {
        console.error(
          `reconcile: orphaned-runner sweep failed for ${s.tenant.orgLogin}: ${String(err)}`,
        );
      }
    }
  }

  // D. Orphaned sandboxes: UNCHANGED — account-wide by VM name, one DO,
  //    liveJobIds() spans all tenants. Deliberately tenant-blind and
  //    GitHub-independent; never gated on the tenant loop above.
  try {
    await sweepOrphanedSandboxes(env, config, deps);
  } catch (err) {
    console.error(`reconcile: orphaned-sandbox sweep failed: ${String(err)}`);
  }
}

/**
 * Reconciler (cron): closes the two gaps a webhook-only controller can't —
 *   1. a job whose provision failed (row dropped) or whose `queued` webhook was
 *      never delivered: GitHub still shows it `queued`, but nothing re-drives it.
 *   2. a VM that booted but whose runner never registered: we think it's
 *      `running`, GitHub never got a runner, and the age-only reaper won't touch
 *      it until REAPER_MAX_AGE_MS.
 * Step A tears down runner-less VMs (freeing their rows); step B replays every
 * still-`queued` job through the normal `onQueued` path so the cap/dedup logic
 * is reused verbatim and only genuinely unserved jobs boot a fresh sandbox.
 * Both GitHub reads fail safe: an outage skips the affected step rather than
 * reaping healthy VMs or provisioning blindly.
 *
 * Behind `config.tenancyMode`: "single" is this function's body, verbatim
 * from before the tenant registry existed. "multi" delegates to
 * `runMultiTenantReconciler` — one Coordinator, N tenant orgs, one shared
 * subrequest budget.
 */
export async function runReconciler(env: Bindings, deps: SandboxDeps = {}): Promise<void> {
  const config = loadConfig(env as Record<string, unknown>);
  if (config.tenancyMode === "multi") {
    await runMultiTenantReconciler(env, config, deps);
    return;
  }
  const github = new GitHubClient(config);
  const co = coordinator(env);

  // A. Reap VMs whose runner is not live. Skipped entirely if the runner list is
  //    unavailable — never reap on a partial/failed view. The list is held for
  //    step C, which deletes the registrations of runners this step never sees.
  let runners: Runner[] | null = null;
  try {
    runners = await github.listRunners();
    const online = runners.filter((r) => r.status === "online").map((r) => r.name);
    const { toDestroy, nextPending } = await co.reapUnregistered(
      Date.now(),
      online,
      config.reconcileGraceMs,
    );
    // Reaping a runner-less VM frees its slot; pull any pending job into it now
    // rather than waiting for that job's (already-fired) queued webhook to recur.
    await Promise.allSettled([
      ...toDestroy.map((task) => destroyAndConfirm(env, config, task, deps)),
      ...nextPending.map((jobToBoot) => provisionAndRecord(env, jobToBoot, deps)),
    ]);
  } catch (err) {
    console.error(`reconcile: runner sweep skipped: ${String(err)}`);
  }

  // B. Re-drive every still-queued label job GitHub knows about. An outage here
  //    skips only the GitHub-dependent work — it must NOT skip step D, whose
  //    leaked VMs are not GitHub's doing and keep burning capacity regardless.
  let queued: QueuedJob[] = [];
  try {
    // Budget the scan so its O(installed-repos) read fan-out can't blow the
    // Free-plan 50-subrequest cap. A budget-bounded tick defers the tail repos;
    // the cursor (persisted in the passive DO) resumes them next tick, so
    // coverage rotates instead of the head being re-scanned forever.
    const cursor = await co.recoveryCursor();
    const { jobs, coverage } = await discoverQueuedJobs(github, {
      budget: config.recoverySubrequestBudget,
      cursor,
      policy: config.provisionPolicy,
      allowlist: config.repoAllowlist,
    });
    queued = jobs;
    // Only persist when the cursor actually moves. When installed repos fit in
    // one tick's budget, nextCursor stabilizes at the last repo — writing it
    // every tick would burn a DO row-write (Free-plan: 100k/day) for a no-op.
    if (coverage.nextCursor !== cursor) await co.setRecoveryCursor(coverage.nextCursor);
    if (coverage.budgetBound) {
      console.warn(
        `reconcile: recovery budget bound (limit=${config.recoverySubrequestBudget} subrequests) — ` +
          `covered ${coverage.covered} repos, deferred ${coverage.deferred}, ` +
          `resuming after ${JSON.stringify(coverage.nextCursor)} next tick`,
      );
    }
  } catch (err) {
    console.error(`reconcile: queued-job poll failed: ${String(err)}`);
  }

  // One admission factory per tick: identify → policy → catalog, the shaped
  // catalog lazily loaded on first need and shared across every job this tick
  // admits, so a matrix burst pays for at most one shapes fetch. Jobs that
  // aren't ours (no-label) and policy rejections are skipped silently; only an
  // ambiguous label or a shape problem warns. Same rule as the webhook — the
  // reconciler reconstructs nothing.
  const admit = createJobAdmission(config, {
    isForkJob: (repoFullName, runId) => github.isForkJob(repoFullName, runId),
    loadCatalog: () => fetchCatalog(config, deps),
  });

  // Admit every candidate BEFORE mutating the Coordinator. An admission can
  // throw — a fork-gated policy check is a GitHub round-trip that rejects on a
  // token or JSON failure — and if it threw *between* two onQueued calls it would
  // strand the rows already promoted this tick in `provisioning` with no VM,
  // burning concurrency until the reaper catches them. Do all the throwing work
  // first, and CATCH per candidate: one job's admission failing must skip only
  // that job, not the whole tick — a mid-loop throw that escaped runReconciler
  // used to take steps C/D and the reaper down with it (bug #1, deferred here).
  // The job simply re-surfaces next tick, since GitHub still reports it queued.
  const admitted: PendingJob[] = [];
  for (const candidate of queued) {
    let admission: AdmissionDecision;
    try {
      admission = await admit(candidate);
    } catch (err) {
      console.error(
        `reconcile: admission failed job=${candidate.jobId} (${candidate.repoFullName}): ${String(err)}`,
      );
      continue;
    }
    if (admission.kind === "refused") {
      warnAdmission("reconcile: ", candidate, admission);
      continue;
    }
    admitted.push(admission.job);
  }

  const toProvision: PendingJob[] = [];
  for (const job of admitted) {
    // Same job_id → onQueued returns `ignore` for anything we're already
    // tracking (fresh boot / at-cap pending); only untracked jobs provision.
    const decision = await co.onQueued(job, `reconcile-${job.jobId}`);
    if (decision.action === "provision") toProvision.push(job);
  }

  await Promise.allSettled(toProvision.map((pending) => provisionAndRecord(env, pending, deps)));

  // C. Delete the GitHub runner registrations left behind by jobs that never ran
  //    one. Deliberately LATE: it is less critical than provisioning/teardown, so
  //    if the Free-plan subrequest budget runs out it starves here rather than
  //    there, and the next cron picks up what it missed. Reuses step A's runner
  //    list — zero extra API cost — so a failed read there skips this too.
  if (runners) {
    try {
      await sweepOrphanedRunners(env, github, runners);
    } catch (err) {
      console.error(`reconcile: orphaned-runner sweep failed: ${String(err)}`);
    }
  }

  // D. Destroy the microVMs no row owns. LAST, but unlike (C) this reclaims real
  //    capacity: a leaked VM's runner never launched, so it never self-deletes.
  //    Independent of (A)/(B) — it must still run when GitHub is down, since the
  //    leaks it cleans up have nothing to do with GitHub.
  try {
    await sweepOrphanedSandboxes(env, config, deps);
  } catch (err) {
    console.error(`reconcile: orphaned-sandbox sweep failed: ${String(err)}`);
  }
}
