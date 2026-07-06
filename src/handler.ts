import type { Bindings } from "./index";
import { loadConfig } from "./config";
import { verifySignature, parseWorkflowJob, matchesLabel } from "./webhook";
import { shouldProvision } from "./policy";
import { GitHubClient } from "./github/client";
import { createRunnerSandbox, launchRunner, teardownSandbox, type SandboxDeps } from "./sandbox";
import { notify } from "./notify";
import type { PendingJob, Config } from "./types";

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
  if (!matchesLabel(job, config.runnerLabel)) return new Response("no-label", { status: 202 });

  const co = coordinator(env);
  const pending: PendingJob = {
    jobId: job.jobId,
    runId: job.runId,
    repoFullName: job.repoFullName,
  };

  if (job.action === "queued") {
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
  const { toDestroy } = await co.sweep(Date.now(), config.reaperMaxAgeMs);
  await Promise.allSettled(toDestroy.map((task) => destroyAndConfirm(env, config, task, deps)));
}
