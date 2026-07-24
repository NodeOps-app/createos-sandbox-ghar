import type { Bindings } from "./index";
import { loadConfig } from "./config";
import { verifySignature, parseWorkflowJob } from "./webhook";
import { createJobAdmission, identifyJob, type AdmissionDecision } from "./admission";
import { fetchCatalog, shapeForLabel, shapeWithinCeiling } from "./shapes";
import { GitHubClient } from "./github/client";
import { createRunnerSandbox, launchRunner, teardownSandbox, type SandboxDeps } from "./sandbox";
import { notify } from "./notify";
import { monthKey, dayKey, weightForLabel } from "./quota";
import type {
  PendingJob,
  Config,
  ProvisionFailedResult,
  SpawnTimeline,
  WorkflowJob,
  TenantStatus,
} from "./types";

export function coordinator(env: Bindings) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("singleton"));
}

/**
 * Boots a VM for a job and drives it to `running`, recording ownership in the
 * DO between create and launch so a `completed` webhook arriving mid-boot never
 * leaks the VM. Any failure frees the slot at once (markProvisionFailed) and
 * pulls the next pending job forward — a transient error can't hold capacity
 * until the reaper. Runs in ctx.waitUntil.
 */
export async function provisionAndRecord(
  env: Bindings,
  job: PendingJob,
  deps: SandboxDeps = {},
): Promise<void> {
  const config = loadConfig(env as Record<string, unknown>);
  const github = new GitHubClient(
    config,
    undefined,
    job.tenant
      ? {
          orgLogin: job.tenant.orgLogin,
          installationId: job.tenant.installationId,
          runnerGroupId: job.tenant.runnerGroupId,
        }
      : undefined,
  );
  const co = coordinator(env);

  let sandboxId: string;
  let runnerName: string;
  let sandbox: Awaited<ReturnType<typeof createRunnerSandbox>>["sandbox"];
  let timings: Awaited<ReturnType<typeof createRunnerSandbox>>["timings"];
  try {
    ({ sandboxId, runnerName, sandbox, timings } = await createRunnerSandbox(
      config,
      github,
      job,
      deps,
    ));
  } catch (err) {
    // Nothing booted (JIT mint / createSandbox threw) → free the slot + advance.
    await failProvision(env, config, job, deps, err);
    return;
  }
  const afterCreate = Date.now();

  // From here a VM EXISTS but its runner has NOT launched yet: it will never
  // self-delete, and if we lose track of its id it leaks silently until the
  // orphaned-sandbox sweep finds it. Guard the record+launch region so any
  // failure destroys the VM — the failure path always carries sandboxId, so the
  // teardown is persisted (or at minimum attempted) rather than dropped.
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
  } catch (err) {
    await failProvision(env, config, job, deps, err, sandboxId);
    return;
  }

  // The runner has launched: it registers with GitHub and can accept the job
  // within seconds, and the VM self-deletes on runner exit. markRunning is a
  // pure bookkeeping write (provisioning → running); its failure must NOT route
  // through failProvision's destroy path — that would tear down a VM whose
  // runner may already be executing the job. The row stays `provisioning`, which
  // counts against the cap identically to `running` and is spared by
  // reapUnregistered once its runner shows online (runner_name was recorded
  // above), so leaving it there is safe. Log and move on.
  try {
    await co.markRunning(job.jobId);
    logProvisionBreakdown(job.jobId, timings, Date.now() - afterCreate);
  } catch (err) {
    console.error(`markRunning failed, VM left running job=${job.jobId}: ${String(err)}`);
  }
}

/**
 * Splits the provision phase — the dominant share of spawn latency on the
 * in_progress timeline — into its legs, so the next optimization targets the
 * real cost: mint (GitHub token + generate-jitconfig, a cold mint per provision
 * today — the credential-session seam), create (synchronous CreateOS host boot),
 * post (ownership record + detached runner launch). One line per successful
 * provision; correlate with the spawn timeline by job id.
 */
function logProvisionBreakdown(
  jobId: number,
  timings: { mintMs: number; createMs: number },
  postMs: number,
): void {
  console.log(
    `provision breakdown: job=${jobId} mint=${timings.mintMs}ms create=${timings.createMs}ms post=${postMs}ms`,
  );
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
export async function failProvision(
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
export function warnAdmission(
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

function contactCopy(config: Config): string {
  return config.applyFormUrl ? ` — details/apply: ${config.applyFormUrl}` : ".";
}

function refusalCopy(
  admission:
    | { kind: "unknown-tenant" }
    | { kind: "not-approved"; status: TenantStatus }
    | { kind: "repo-not-approved"; orgLogin: string },
  config: Config,
): { title: string; summary: string } {
  if (admission.kind === "repo-not-approved") {
    return {
      title: "This repository is not approved for CreateOS runners",
      summary: `The org is onboarded, but this repo is not on its approved list${contactCopy(config)}`,
    };
  }
  if (admission.kind === "not-approved") {
    return {
      title: `CreateOS runner access is ${admission.status}`,
      summary: `This org's access is currently "${admission.status}"${contactCopy(config)}`,
    };
  }
  return {
    title: "This org is not approved for CreateOS runners",
    summary: `CreateOS Sandbox runners are free for approved projects${contactCopy(config)}`,
  };
}

/**
 * Posts the refusal check run at most once per (tenant, repo, UTC day) — the
 * DO's INSERT-OR-IGNORE is the dedup, so cost is bounded by construction.
 * Best-effort: needs head_sha, checks:write, and a mintable token for the
 * payload's own installation; any failure is logged, never surfaced.
 */
async function notifyRefusal(
  env: Bindings,
  config: Config,
  job: WorkflowJob,
  copy: { title: string; summary: string },
): Promise<void> {
  if (job.installationId === undefined || job.headSha === undefined) return;
  try {
    const fresh = await coordinator(env).shouldNotifyRefusal(
      job.installationId,
      job.repoFullName,
      dayKey(Date.now()),
    );
    if (!fresh) return;
    const gh = new GitHubClient(config, undefined, {
      orgLogin: job.repoFullName.split("/")[0]!,
      installationId: job.installationId,
    });
    await gh.createCheckRun(job.repoFullName, job.headSha, copy.title, copy.summary);
  } catch (err) {
    console.warn(`refusal notice failed ${job.repoFullName}#${job.jobId}: ${String(err)}`);
  }
}

/**
 * Multi-mode admission + drive: label → tenant gates → shape ceiling → quota
 * → catalog → onQueued/provision. The ONE path a queued job takes in multi
 * mode, whether it arrived by webhook or recovery scan (`scope` labels the
 * caller for logs, same convention as warnAdmission). Returns the decision
 * word used as the webhook response body.
 */
export async function admitAndDrive(
  env: Bindings,
  config: Config,
  job: WorkflowJob,
  ctx: { waitUntil(p: Promise<unknown>): void },
  deps: SandboxDeps,
  scope: string,
): Promise<string> {
  const co = coordinator(env);
  // Label first: pure, filters every non-createos job in the granted repos at
  // zero DO/GitHub cost. Refusal notices only fire for jobs that explicitly
  // asked for our label.
  const ident = identifyJob(job, config);
  if (ident.kind === "none") return "no-label";
  if (ident.kind === "ambiguous") {
    warnAdmission(scope, job, { kind: "refused", reason: "ambiguous-label", labels: ident.labels });
    return "ambiguous-label";
  }
  if (job.installationId === undefined) {
    console.warn(`${scope}job ${job.jobId} (${job.repoFullName}): no installation id on payload`);
    return "no-installation";
  }

  const admission = await co.admitTenantJob(
    job.installationId,
    job.repoFullName,
    monthKey(Date.now()),
  );
  if (admission.kind !== "ok") {
    ctx.waitUntil(notifyRefusal(env, config, job, refusalCopy(admission, config)));
    return admission.kind;
  }

  const shape = shapeForLabel(ident.job.label, config);
  if (!shapeWithinCeiling(shape, admission.maxShape)) {
    ctx.waitUntil(
      notifyRefusal(env, config, job, {
        title: "Requested runner size exceeds this org's limit",
        summary:
          `\`${ident.job.label}\` maps to \`${shape}\`, above your approved ceiling ` +
          `\`${admission.maxShape}\`. Use a smaller \`runs-on\` label${contactCopy(config)}`,
      }),
    );
    return "shape-over-ceiling";
  }

  if (admission.usedMinutes >= admission.minuteGrant) {
    ctx.waitUntil(
      notifyRefusal(env, config, job, {
        title: "CreateOS runner minutes exhausted",
        summary:
          `This org has used ${Math.round(admission.usedMinutes)} of its ` +
          `${admission.minuteGrant} weighted minutes for ${monthKey(Date.now())}. ` +
          `Quota resets on the 1st (UTC)${contactCopy(config)}`,
      }),
    );
    ctx.waitUntil(
      notify(config, `ghar quota exhausted — ${admission.tenant.orgLogin} (${job.repoFullName})`),
    );
    return "quota-exhausted";
  }

  // Catalog validation exactly as the single path does it (shared rule), on a
  // config scoped to the REQUESTING tenant: `shouldProvision`'s org-match and
  // PROVISION_POLICY are single-tenant operator settings — gates 1/2 (tenant +
  // project approval, just read above) are what multi mode actually enforces
  // at this level, so this override neutralizes both into a no-op rather than
  // refusing every tenant whose org isn't the deploy's own GITHUB_ORG.
  const catalogConfig: Config = {
    ...config,
    githubOrg: admission.tenant.orgLogin,
    provisionPolicy: "org-wide",
  };
  const catalogAdmit = createJobAdmission(catalogConfig, {
    isForkJob: () => Promise.resolve(false), // gates 1-2 replace fork policy in multi mode
    loadCatalog: () => fetchCatalog(config, deps),
  });
  const admitted = await catalogAdmit(job);
  if (admitted.kind === "refused") {
    warnAdmission(scope, job, admitted);
    return admitted.reason;
  }

  const pending: PendingJob = { ...admitted.job, tenant: admission.tenant };
  const delivery = job.deliveryId ?? crypto.randomUUID();
  const decision = await co.onQueued(pending, delivery, {
    tenantId: admission.tenant.installationId,
    weight: weightForLabel(ident.job.label, config.runnerLabel, config.runnerShape),
    cap: admission.concurrencyCap,
  });
  if (decision.action === "provision") {
    ctx.waitUntil(provisionAndRecord(env, pending, deps));
  }
  return decision.action;
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
    if (config.tenancyMode === "multi") {
      job.deliveryId = delivery;
      const word = await admitAndDrive(env, config, job, ctx, deps, "");
      return new Response(word, { status: 202 });
    }
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
export async function destroyAndConfirm(
  env: Bindings,
  config: Config,
  task: { jobId: number; sandboxId: string; tenantId: number | null },
  deps: SandboxDeps,
): Promise<void> {
  try {
    const egress = await teardownSandbox(config, task.sandboxId, deps, task.tenantId !== null);
    await coordinator(env).markDestroyed(task.jobId, egress ?? undefined);
  } catch (err) {
    console.error(`teardown failed sandbox=${task.sandboxId} job=${task.jobId}: ${String(err)}`);
    await notify(
      config,
      `ghar teardown failed — sandbox ${task.sandboxId} (job ${task.jobId}): ${String(err)}`,
    );
  }
}
