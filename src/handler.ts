import type { Bindings } from "./index";
import { loadConfig } from "./config";
import { verifySignature, parseWorkflowJob } from "./webhook";
import {
  resolveRequestedLabel,
  isShapedLabel,
  validateShape,
  fetchCatalog,
  shapeForLabel,
  type Catalog,
} from "./shapes";
import { shouldProvision } from "./policy";
import { GitHubClient } from "./github/client";
import {
  createRunnerSandbox,
  jobIdFromRunnerName,
  launchRunner,
  teardownSandbox,
  type SandboxDeps,
} from "./sandbox";
import { notify } from "./notify";
import type { PendingJob, Config, QueuedJob, Runner } from "./types";

function coordinator(env: Bindings) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
}

/**
 * Boots a VM for a job and drives it to `running`, recording ownership in the
 * DO between create and launch so a `completed` webhook arriving mid-boot never
 * leaks the VM. Any failure frees the slot at once (markProvisionFailed) and
 * pulls the next pending job forward — a transient error can't hold capacity
 * until the reaper. Runs in ctx.waitUntil.
 */
async function provisionAndRecord(
  env: Bindings,
  job: PendingJob,
  deps: SandboxDeps = {},
): Promise<void> {
  const config = loadConfig(env as Record<string, unknown>);
  const github = new GitHubClient(config);
  const co = coordinator(env);

  let sandboxId: string;
  let runnerName: string;
  let sandbox: Awaited<ReturnType<typeof createRunnerSandbox>>["sandbox"];
  try {
    ({ sandboxId, runnerName, sandbox } = await createRunnerSandbox(config, github, job, deps));
  } catch (err) {
    // Nothing booted (JIT mint / createSandbox threw) → free the slot + advance.
    await failProvision(env, config, job, deps, err);
    return;
  }

  // Record the VM before launching it: from here a `completed` tears it down
  // via runner identity, so the runner launch below can never orphan it.
  const decision = await co.recordSandboxCreated(job.jobId, sandboxId, runnerName);
  if (decision.action === "destroy") {
    // Job already completed/cancelled during creation — destroy the orphan now.
    await teardownSandbox(config, sandboxId, deps);
    return;
  }

  try {
    await launchRunner(sandbox);
    await co.markRunning(job.jobId);
  } catch (err) {
    // VM exists + is recorded → destroy it, then free the slot + advance.
    await teardownSandbox(config, sandboxId, deps).catch(() => {});
    await failProvision(env, config, job, deps, err);
  }
}

/** Logs + alerts a provision failure, frees the slot, and boots the next pending job. */
async function failProvision(
  env: Bindings,
  config: Config,
  job: PendingJob,
  deps: SandboxDeps,
  err: unknown,
): Promise<void> {
  console.error(`provision failed job=${job.jobId}: ${String(err)}`);
  await notify(
    config,
    `ghar provision failed — job ${job.jobId} (${job.repoFullName}): ${String(err)}`,
  );
  const { nextPending } = await coordinator(env).markProvisionFailed(job.jobId);
  if (nextPending) await provisionAndRecord(env, nextPending, deps);
}

export async function handleWebhook(
  req: Request,
  env: Bindings,
  ctx: ExecutionContext,
  deps: SandboxDeps = {},
): Promise<Response> {
  const config = loadConfig(env as Record<string, unknown>);
  const body = await req.text();
  const sig = req.headers.get("X-Hub-Signature-256");
  if (!(await verifySignature(config.githubWebhookSecret, body, sig))) {
    return new Response("bad signature", { status: 401 });
  }
  const delivery = req.headers.get("X-GitHub-Delivery") ?? crypto.randomUUID();
  const job = parseWorkflowJob(body);
  if (!job) return new Response("ignored", { status: 202 });

  // "Is this ours" is a pure label question for every action — the catalog and
  // policy are only consulted for a `queued` job below. Gating teardown on
  // either would leak every shaped VM during a shapes outage or a policy that
  // has since changed.
  const requested = resolveRequestedLabel(job.labels, config);
  if (requested.kind === "none") return new Response("no-label", { status: 202 });
  if (requested.kind === "ambiguous") {
    console.warn(
      `job ${job.jobId} names ${requested.labels.length} createos labels (${requested.labels.join(", ")})`,
    );
    return new Response("ambiguous-label", { status: 202 });
  }
  const label = requested.label;

  const co = coordinator(env);
  const pending: PendingJob = {
    jobId: job.jobId,
    runId: job.runId,
    repoFullName: job.repoFullName,
    label,
  };

  if (job.action === "queued") {
    // Policy first: a job the policy rejects must never cost a catalog fetch,
    // and must be reported as policy-skip rather than as whatever the catalog
    // fetch would have said (see the Fix-1 review finding: a policy-blocked
    // shaped job used to return catalog-unavailable during an outage, which
    // both lied about the reason and never reached the policy that would have
    // permanently rejected it anyway).
    const github = new GitHubClient(config);
    const eligible = await shouldProvision(config, job, () =>
      github.isForkJob(job.repoFullName, job.runId),
    );
    if (!eligible) return new Response("policy-skip", { status: 202 });

    // Only a shaped label needs the catalog: a bare label's shape comes from
    // config, so a shapes-API outage can never stop the jobs that work today.
    if (isShapedLabel(label, config)) {
      const catalog: Catalog = await fetchCatalog(config, deps);
      const check = validateShape(label, config, catalog);
      if (!check.ok) {
        if (check.reason === "unknown-shape") {
          console.warn(
            `job ${job.jobId}: label "${label}" names shape "${shapeForLabel(label, config)}", which is not offered`,
          );
        } else {
          console.warn(`job ${job.jobId}: ${check.reason}`);
        }
        return new Response(check.reason, { status: 202 });
      }
    }

    const decision = await co.onQueued(pending, delivery);
    if (decision.action === "provision") {
      ctx.waitUntil(provisionAndRecord(env, pending, deps));
    }
    return new Response(decision.action, { status: 202 });
  }

  if (job.action === "completed") {
    // runner_name identifies the VM that ACTUALLY ran the job (may differ from
    // the provisioning job under backlog); the DO tears down that one.
    const result = await co.onCompleted(job.jobId, job.runnerName);
    ctx.waitUntil(
      (async () => {
        if (result.toDestroy) await destroyAndConfirm(env, config, result.toDestroy, deps);
        if (result.nextPending) await provisionAndRecord(env, result.nextPending, deps);
      })(),
    );
    return new Response("completed", { status: 202 });
  }

  return new Response("noop", { status: 202 });
}

/**
 * Destroys a VM and only then clears its `destroying` row. A failed destroy is
 * logged/alerted and the row is left behind so the reaper retries it — teardown
 * is never lost to a thrown destroy after the row was deleted.
 */
async function destroyAndConfirm(
  env: Bindings,
  config: Config,
  task: { jobId: number; sandboxId: string },
  deps: SandboxDeps,
): Promise<void> {
  try {
    await teardownSandbox(config, task.sandboxId, deps);
    await coordinator(env).markDestroyed(task.jobId);
  } catch (err) {
    console.error(`teardown failed sandbox=${task.sandboxId} job=${task.jobId}: ${String(err)}`);
    await notify(
      config,
      `ghar teardown failed — sandbox ${task.sandboxId} (job ${task.jobId}): ${String(err)}`,
    );
  }
}

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
 */
export async function runReconciler(env: Bindings, deps: SandboxDeps = {}): Promise<void> {
  const config = loadConfig(env as Record<string, unknown>);
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

  // B. Re-drive every still-queued label job GitHub knows about.
  let queued: QueuedJob[];
  try {
    queued = await github.listQueuedJobs();
  } catch (err) {
    console.error(`reconcile: queued-job poll failed: ${String(err)}`);
    return;
  }

  // Pure prefilter — no network. Each candidate's requested label is resolved
  // once here. Jobs that aren't ours are skipped silently: "not ours" isn't a
  // bound binding, it's just someone else's job. An ambiguous job is malformed
  // regardless of policy, so it's disposed of here too, before either policy
  // or the catalog are ever consulted.
  const candidates: { job: QueuedJob; label: string }[] = [];
  for (const j of queued) {
    const requested = resolveRequestedLabel(j.labels, config);
    if (requested.kind === "none") continue;
    if (requested.kind === "ambiguous") {
      console.warn(
        `reconcile: job ${j.jobId} (${j.repoFullName}) skipped: ambiguous (${requested.labels.join(", ")})`,
      );
      continue;
    }
    candidates.push({ job: j, label: requested.label });
  }

  // Policy next, still before the catalog: a job the policy rejects must
  // never cost a catalog fetch (see the Fix-1 review finding). One
  // shouldProvision call per candidate, same as before this reordering —
  // moving it earlier only changes *when* its (possibly network) fork check
  // runs, not how many times.
  const eligible: { job: QueuedJob; label: string }[] = [];
  for (const { job: j, label } of candidates) {
    const admitted = await shouldProvision(
      config,
      {
        action: "queued",
        jobId: j.jobId,
        runId: j.runId,
        repoFullName: j.repoFullName,
        labels: [label],
      },
      () => github.isForkJob(j.repoFullName, j.runId),
    );
    if (admitted) eligible.push({ job: j, label });
  }

  // Only pay for the catalog if some POLICY-ELIGIBLE candidate actually names
  // a shaped label — a tick whose only shaped jobs are all policy-blocked, or
  // where every eligible job is bare-label, must never touch the shapes API.
  const needsCatalog = eligible.some(({ label }) => isShapedLabel(label, config));
  let catalog: Catalog | undefined;
  if (needsCatalog) catalog = await fetchCatalog(config, deps);

  const toProvision: PendingJob[] = [];
  for (const { job: j, label } of eligible) {
    if (isShapedLabel(label, config)) {
      // needsCatalog is exactly "some eligible candidate is shaped", so
      // catalog was fetched above whenever this branch runs.
      const check = validateShape(label, config, catalog!);
      if (!check.ok) {
        console.warn(`reconcile: job ${j.jobId} (${j.repoFullName}) skipped: ${check.reason}`);
        continue;
      }
    }
    const job: PendingJob = { jobId: j.jobId, runId: j.runId, repoFullName: j.repoFullName, label };
    // Same job_id → onQueued returns `ignore` for anything we're already
    // tracking (fresh boot / at-cap pending); only untracked jobs provision.
    const decision = await co.onQueued(job, `reconcile-${job.jobId}`);
    if (decision.action === "provision") toProvision.push(job);
  }
  await Promise.allSettled(toProvision.map((job) => provisionAndRecord(env, job, deps)));

  // C. Delete the GitHub runner registrations left behind by jobs that never ran
  //    one. Deliberately LAST: it is the least critical work in the tick, so if
  //    the Free-plan subrequest budget runs out it starves here instead of in
  //    provisioning or teardown, and the next cron picks up what it missed.
  //    Reuses step A's runner list — zero extra API cost — so a failed read there
  //    skips this too.
  if (runners) {
    try {
      await sweepOrphanedRunners(env, github, runners);
    } catch (err) {
      console.error(`reconcile: orphaned-runner sweep failed: ${String(err)}`);
    }
  }
}
