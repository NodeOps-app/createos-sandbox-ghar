import type { Bindings } from "./index";
import { loadConfig } from "./config";
import { verifySignature, parseWorkflowJob } from "./webhook";
import { createJobAdmission, identifyJob, type AdmissionDecision } from "./admission";
import { fetchCatalog } from "./shapes";
import { GitHubClient } from "./github/client";
import {
  createRunnerSandbox,
  jobIdFromRunnerName,
  jobIdFromSandboxName,
  launchRunner,
  sandboxNamesAreSweepable,
  teardownSandbox,
  type SandboxDeps,
} from "./sandbox";
import { makeSandboxClient } from "./createos";
import { notify } from "./notify";
import type {
  PendingJob,
  Config,
  ProvisionFailedResult,
  QueuedJob,
  Runner,
  SpawnTimeline,
} from "./types";

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

  // From here a VM EXISTS. Every exit below must account for it: the runner has
  // not launched yet, so the VM will never self-delete, and if we lose track of
  // its id it leaks silently until the orphaned-sandbox sweep finds it. Hence
  // one guard around the whole region — the failure path always carries
  // sandboxId, so the teardown is persisted (or at minimum attempted) rather
  // than dropped on the floor.
  try {
    // Record the VM before launching it: from here a `completed` tears it down
    // via runner identity, so the runner launch below can never orphan it.
    const decision = await co.recordSandboxCreated(job.jobId, sandboxId, runnerName);
    if (decision.action === "destroy") {
      // Job already completed/cancelled during creation — destroy the orphan.
      // A throw here is caught below, which persists the teardown for retry.
      await teardownSandbox(config, sandboxId, deps);
      return;
    }
    await launchRunner(sandbox);
    await co.markRunning(job.jobId);
  } catch (err) {
    await failProvision(env, config, job, deps, err, sandboxId);
  }
}

/**
 * Logs + alerts a provision failure, disposes of any VM it left behind, frees
 * the slot, and boots the next pending job.
 *
 * `sandboxId` is passed whenever a VM was created — including when the DO call
 * that was supposed to record it is what failed, which is exactly the case where
 * the Coordinator does not know the VM exists and only we do. markProvisionFailed
 * persists it as a `destroying` row before we attempt the destroy, so a destroy
 * that then fails is retried by the reaper instead of leaking.
 *
 * If markProvisionFailed itself throws (the DO is unreachable — the one case
 * where nothing can be persisted at all) we still attempt the destroy inline, and
 * the orphaned-sandbox sweep is the backstop if even that fails.
 */
async function failProvision(
  env: Bindings,
  config: Config,
  job: PendingJob,
  deps: SandboxDeps,
  err: unknown,
  sandboxId?: string,
): Promise<void> {
  console.error(`provision failed job=${job.jobId}: ${String(err)}`);
  await notify(
    config,
    `ghar provision failed — job ${job.jobId} (${job.repoFullName}): ${String(err)}`,
  );

  let result: ProvisionFailedResult;
  try {
    result = await coordinator(env).markProvisionFailed(job.jobId, sandboxId);
  } catch (doErr) {
    console.error(`markProvisionFailed unreachable job=${job.jobId}: ${String(doErr)}`);
    if (sandboxId) await destroyUnrecorded(config, job.jobId, sandboxId, deps);
    return;
  }

  if (result.toDestroy) await destroyAndConfirm(env, config, result.toDestroy, deps);
  if (result.nextPending) await provisionAndRecord(env, result.nextPending, deps);
}

/**
 * Destroys a VM the Coordinator holds no row for — the DO was unreachable, so
 * there is nowhere to persist a retry. Best-effort by construction: on failure
 * the VM is a true orphan and only `sweepOrphanedSandboxes` can still reclaim it,
 * so this shouts rather than throwing into a `waitUntil` nobody reads.
 */
async function destroyUnrecorded(
  config: Config,
  jobId: number,
  sandboxId: string,
  deps: SandboxDeps,
): Promise<void> {
  try {
    await teardownSandbox(config, sandboxId, deps);
  } catch (err) {
    console.error(`unrecorded teardown failed sandbox=${sandboxId} job=${jobId}: ${String(err)}`);
    await notify(
      config,
      `ghar VM leaked — sandbox ${sandboxId} (job ${jobId}) has no Coordinator row and could not be ` +
        `destroyed: ${String(err)}. The orphaned-sandbox sweep will retry.`,
    );
  }
}

/**
 * The single place a refused admission becomes a log line. `admitted`,
 * `no-label` (someone else's job) and `policy-skip` (a permanent, expected
 * rejection) are silent by design; only the outcomes an operator should see —
 * an ambiguous label, an unknown shape, an unreachable catalog — warn, and the
 * caller names its scope (`""` for webhook, `"reconcile: "` for the cron) so
 * both sources read the same rule off one function.
 */
function warnAdmission(
  scope: string,
  candidate: { jobId: number; repoFullName: string },
  decision: AdmissionDecision,
): void {
  if (
    decision.kind === "admitted" ||
    decision.reason === "no-label" ||
    decision.reason === "policy-skip"
  ) {
    return;
  }
  if (decision.reason === "ambiguous-label") {
    console.warn(
      `${scope}job ${candidate.jobId} (${candidate.repoFullName}) names ${decision.labels.length} createos labels (${decision.labels.join(", ")})`,
    );
    return;
  }
  if (decision.reason === "unknown-shape") {
    console.warn(
      `${scope}job ${candidate.jobId} (${candidate.repoFullName}): label "${decision.label}" names shape "${decision.shape}", which is not offered`,
    );
    return;
  }
  console.warn(`${scope}job ${candidate.jobId} (${candidate.repoFullName}): catalog-unavailable`);
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

  const co = coordinator(env);

  // A queued job runs the full admission rule (identify → policy → catalog);
  // every other action keys on label identity ALONE. Gating a completed job on
  // policy or the catalog would leak every shaped VM during a shapes outage or a
  // policy that has since changed — teardown must depend only on who the job is.
  if (job.action === "queued") {
    const github = new GitHubClient(config);
    const admit = createJobAdmission(config, {
      isForkJob: (repoFullName, runId) => github.isForkJob(repoFullName, runId),
      loadCatalog: () => fetchCatalog(config, deps),
    });
    const admission = await admit(job);
    if (admission.kind === "refused") {
      warnAdmission("", job, admission);
      return new Response(admission.reason, { status: 202 });
    }

    const decision = await co.onQueued(admission.job, delivery);
    if (decision.action === "provision") {
      ctx.waitUntil(provisionAndRecord(env, admission.job, deps));
    }
    return new Response(decision.action, { status: 202 });
  }

  const identified = identifyJob(job, config);
  if (identified.kind === "none") return new Response("no-label", { status: 202 });
  if (identified.kind === "ambiguous") {
    const refusal: AdmissionDecision = {
      kind: "refused",
      reason: "ambiguous-label",
      labels: identified.labels,
    };
    warnAdmission("", job, refusal);
    return new Response("ambiguous-label", { status: 202 });
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

  if (job.action === "in_progress") {
    // The real queued→started signal: GitHub sends in_progress when a runner
    // ACCEPTS the job. Stamp it and log the spawn phase timeline — pure
    // observation off a webhook we already receive (no lifecycle change, no
    // extra GitHub/CreateOS call). runner_name is the VM that actually ran it,
    // so timing is attributed to the runner even under backlog reassignment.
    const timeline = await co.markJobStarted(job.jobId, job.runnerName);
    if (timeline) logSpawnTimeline(timeline);
    return new Response("in_progress", { status: 202 });
  }

  return new Response("noop", { status: 202 });
}

/**
 * Emits one greppable line per spawn: queued→started latency split into the
 * three phases deep-spawn work optimizes against — wait (queued behind the cap),
 * provision (JIT mint + createSandbox + ownership record + runner launch), and
 * boot (VM/dockerd/runner-connect until GitHub dispatches the job). A phase whose
 * start timestamp is null (skipped) prints `?` rather than a bogus number, and no
 * credentials appear — so a run of spawns shows where the time actually goes.
 */
function logSpawnTimeline(t: SpawnTimeline): void {
  const wait = t.provisionStartedAt === null ? "?" : `${t.provisionStartedAt - t.createdAt}ms`;
  const provision =
    t.provisionStartedAt === null || t.bootedAt === null
      ? "?"
      : `${t.bootedAt - t.provisionStartedAt}ms`;
  const boot = t.bootedAt === null ? "?" : `${t.jobStartedAt - t.bootedAt}ms`;
  console.log(
    `spawn timeline: job=${t.jobId} runner=${t.runnerName ?? "?"} ` +
      `queued->started=${t.jobStartedAt - t.createdAt}ms (wait=${wait} provision=${provision} boot=${boot})`,
  );
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

  // B. Re-drive every still-queued label job GitHub knows about. An outage here
  //    skips only the GitHub-dependent work — it must NOT skip step D, whose
  //    leaked VMs are not GitHub's doing and keep burning capacity regardless.
  let queued: QueuedJob[] = [];
  try {
    queued = await github.listQueuedJobs();
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
  // first: a mid-loop throw then aborts the tick before any row is touched, as
  // the pre-refactor phased flow did.
  const admitted: PendingJob[] = [];
  for (const candidate of queued) {
    const admission = await admit(candidate);
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
