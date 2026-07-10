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
import { createRunnerSandbox, launchRunner, teardownSandbox, type SandboxDeps } from "./sandbox";
import { notify } from "./notify";
import type { PendingJob, Config, QueuedJob } from "./types";

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

  // "Is this ours" is a pure label question for every action — the catalog is
  // only needed to admit a `queued` job below. Gating teardown on the shapes API
  // would leak every shaped VM during a shapes outage.
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
    // A bare label needs no catalog: only a shaped label consults it.
    // Fetching one anyway would mean a shapes-API outage could stop
    // bare-label jobs, which is exactly what must never happen.
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
    const github = new GitHubClient(config);
    const eligible = await shouldProvision(config, job, () =>
      github.isForkJob(job.repoFullName, job.runId),
    );
    if (!eligible) return new Response("policy-skip", { status: 202 });

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
  //    unavailable — never reap on a partial/failed view.
  try {
    const online = await github.listOnlineRunners();
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
  // once here and carried alongside the job. Jobs that aren't ours are skipped
  // silently: "not ours" isn't a bound binding, it's just someone else's job.
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

  // Only pay for the catalog if some candidate actually names a shaped label
  // — a tick where every candidate is bare-label must never touch the shapes
  // API. No synthetic catalog when it's skipped: `validateShape` is only ever
  // called below when `isShapedLabel` is true, and `needsCatalog` is exactly
  // that condition across every candidate, so `catalog` is always defined by
  // the time it's needed.
  const needsCatalog = candidates.some(({ label }) => isShapedLabel(label, config));
  let catalog: Catalog | undefined;
  if (needsCatalog) catalog = await fetchCatalog(config, deps);

  const toProvision: PendingJob[] = [];
  for (const { job: j, label } of candidates) {
    if (isShapedLabel(label, config)) {
      const check = validateShape(label, config, catalog!);
      if (!check.ok) {
        console.warn(`reconcile: job ${j.jobId} (${j.repoFullName}) skipped: ${check.reason}`);
        continue;
      }
    }
    const job: PendingJob = { jobId: j.jobId, runId: j.runId, repoFullName: j.repoFullName, label };
    const eligible = await shouldProvision(
      config,
      {
        action: "queued",
        jobId: job.jobId,
        runId: job.runId,
        repoFullName: job.repoFullName,
        labels: [job.label],
      },
      () => github.isForkJob(job.repoFullName, job.runId),
    );
    if (!eligible) continue;
    // Same job_id → onQueued returns `ignore` for anything we're already
    // tracking (fresh boot / at-cap pending); only untracked jobs provision.
    const decision = await co.onQueued(job, `reconcile-${job.jobId}`);
    if (decision.action === "provision") toProvision.push(job);
  }
  await Promise.allSettled(toProvision.map((job) => provisionAndRecord(env, job, deps)));
}
