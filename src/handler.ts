import type { Bindings } from "./index";
import { loadConfig } from "./config";
import { verifySignature, parseWorkflowJob, matchesLabel } from "./webhook";
import { shouldProvision } from "./policy";
import { GitHubClient } from "./github/client";
import { provisionSandbox, teardownSandbox, type SandboxDeps } from "./sandbox";
import type { PendingJob } from "./types";

function coordinator(env: Bindings) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
}

/** Boots a VM for a job then records it running. Runs in ctx.waitUntil. */
async function provisionAndRecord(
  env: Bindings,
  job: PendingJob,
  deps: SandboxDeps = {},
): Promise<void> {
  const config = loadConfig(env as Record<string, unknown>);
  const github = new GitHubClient(config);
  try {
    const { sandboxId } = await provisionSandbox(config, github, job, deps);
    await coordinator(env).markRunning(job.jobId, sandboxId);
  } catch (err) {
    console.error(`provision failed job=${job.jobId}: ${String(err)}`);
  }
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
  const pending: PendingJob = { jobId: job.jobId, runId: job.runId, repoFullName: job.repoFullName };

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
    const result = await co.onCompleted(job.jobId);
    ctx.waitUntil(
      (async () => {
        if (result.sandboxIdToDestroy) {
          await teardownSandbox(config, result.sandboxIdToDestroy, deps);
        }
        if (result.nextPending) {
          await provisionAndRecord(env, result.nextPending, deps);
        }
      })(),
    );
    return new Response("completed", { status: 202 });
  }

  return new Response("noop", { status: 202 });
}

export async function runReaper(env: Bindings, deps: SandboxDeps = {}): Promise<void> {
  const config = loadConfig(env as Record<string, unknown>);
  const co = coordinator(env);
  const { sandboxIdsToDestroy } = await co.sweep(Date.now(), config.reaperMaxAgeMs);
  await Promise.allSettled(
    sandboxIdsToDestroy.map((id) => teardownSandbox(config, id, deps)),
  );
}
