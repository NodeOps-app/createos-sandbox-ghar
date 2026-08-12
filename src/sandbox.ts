import { CreateosSandboxNotFoundError } from "@nodeops-createos/sandbox";
import type { Config, PendingJob, Region } from "./types";
import type { GitHubClient } from "./github/client";
import {
  isFailoverEligible,
  makeSandboxClient,
  regionByName,
  type SandboxDeps,
  type SandboxHandle,
} from "./createos";
import { shapeForLabel } from "./shapes";

/**
 * How long createRunnerSandbox waits before its one post-failover retry, when
 * every configured region refused with a region-level fault.
 *
 * Long enough that a 5xx wave has a chance to clear (the measured waves resolve
 * in seconds), short enough to stay far inside the provisioning path's latency
 * budget — the alternative is the Coordinator's retry, minutes later.
 */
const RETRY_ALL_REGIONS_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The order this job tries the configured control planes in — every region, once,
 * starting at a per-job offset so provisions SPREAD instead of all landing on
 * `regions[0]` and only spilling over on a fault.
 *
 * The offset is `jobId % N` rather than a counter or a random pick because a
 * Worker isolate has no shared state to round-robin with, and reaching into the
 * DO for one would put a blocking call on the provisioning hot path. Job ids are
 * dense and monotonic, so modulo spreads a burst evenly across N regions, scales
 * to any N without a config change, and — unlike random — is reproducible: the
 * job id in a log line tells you which region it should have started at.
 *
 * Failover semantics are unchanged: the ladder still walks EVERY region before
 * giving up, only the starting point moves.
 */
function regionLadder(config: Config, jobId: number): Region[] {
  const regions = config.createosRegions;
  const start = jobId % regions.length;
  return regions.map((_, i) => regions[(start + i) % regions.length]!);
}

// Re-exported so existing consumers (handler.ts, index.ts, tests) keep importing
// SandboxDeps/SandboxHandle from here.
export type { SandboxDeps, SandboxHandle };

/** createos-sandbox rejects names longer than this (API returns 400). */
const MAX_SANDBOX_NAME = 22;

/**
 * Runner names are `cos-<jobId>-<xx>` (`xx` = the 2-char base36 attempt token).
 * Mint and parse are defined together because the sweeper's ownership test IS
 * this format: a name that parses is one we minted and may delete; a name that
 * does not (an ARC runner, a hand-registered box) is someone else's and is never
 * touched. Let the two drift and the sweeper either strands our orphans or
 * deletes a stranger's runner.
 *
 * The prefix is kept SHORT on purpose. The JIT blob is ~4085 bytes of GitHub
 * credentials against the 4096-byte cap on a createos `envs` value, and the
 * runner name is the only part of it we control — so the name length is the
 * entire safety margin. Measured against the live API: a 20-char name encodes to
 * 4088 bytes (8 spare), while a 24-char one hits exactly 4096 and leaves none.
 * At `cos-` a 13-digit job id still has 8 bytes of headroom; at `createos-` a
 * 12-digit job id (GitHub is at 11 today) would overflow and fail EVERY
 * provision. Lengthen this prefix and you re-arm that bomb.
 */
export const RUNNER_PREFIX = "cos-";
const RUNNER_NAME_RE = new RegExp(`^${RUNNER_PREFIX}(\\d+)-[a-z0-9]{2}$`);

export function runnerNameFor(jobId: number, attemptId: string): string {
  return `${RUNNER_PREFIX}${jobId}-${attemptId}`;
}

/** The job id a runner name was minted for, or null if we did not mint it. */
export function jobIdFromRunnerName(name: string): number | null {
  const m = RUNNER_NAME_RE.exec(name);
  if (!m) return null;
  const jobId = Number(m[1]);
  return Number.isSafeInteger(jobId) ? jobId : null;
}

/** Clamp the cosmetic VM name to the createos cap; warn when it actually binds. */
function clampSandboxName(name: string): string {
  if (name.length <= MAX_SANDBOX_NAME) return name;
  const clamped = name.slice(0, MAX_SANDBOX_NAME);
  console.warn(
    `sandbox name "${name}" (${name.length}) exceeds ${MAX_SANDBOX_NAME}; clamped to "${clamped}"`,
  );
  return clamped;
}

/**
 * The VM's name. Cosmetic to provisioning (teardown keys on sandbox_id and
 * runner identity, never on this) but load-bearing to the orphaned-sandbox
 * sweep, which has nothing else to go on: a leaked VM is by definition one the
 * Coordinator has no row for, so its name is the only thing tying it back to a
 * job id.
 */
export function sandboxNameFor(jobId: number, runnerName: string, config: Config): string {
  return clampSandboxName(
    config.sandboxNamePrefix ? `${config.sandboxNamePrefix}-${jobId}` : runnerName,
  );
}

/**
 * The widest job id we assume GitHub will ever mint. It is at 11 digits today;
 * 13 is the same headroom the runner-name budget is sized against.
 */
const MAX_JOB_ID_DIGITS = 13;

/**
 * Whether a VM's name can prove which job it belongs to under this config — the
 * precondition for the orphaned-sandbox sweep being safe to run at all.
 *
 * It fails when `SANDBOX_NAME_PREFIX` is long enough that `clampSandboxName` can
 * truncate a minted name, because truncation is IRREVERSIBLE and silently
 * plausible. With prefix `gha-ci-nodeops-app`, job 86749416515 mints
 * `gha-ci-nodeops-app-86749416515`, which clamps to `gha-ci-nodeops-app-867` —
 * and that parses cleanly as job **867**, even round-tripping back to itself. A
 * sweep reading that name would conclude the VM belongs to a job it has no row
 * for and destroy it, WHILE JOB 86749416515 IS STILL RUNNING ON IT. No parser can
 * recover the lost digits, so the only safe answer is to not sweep on such names.
 * (The deployed prefix `gha-ci` is 6 chars and never clamps.)
 */
export function sandboxNamesAreSweepable(config: Config): boolean {
  // No prefix → the VM name IS the runner name, whose grammar is self-describing
  // and length-budgeted already.
  if (!config.sandboxNamePrefix) return true;
  return `${config.sandboxNamePrefix}-`.length + MAX_JOB_ID_DIGITS <= MAX_SANDBOX_NAME;
}

/**
 * The job id a VM name was minted for, or null if we did not mint it. The
 * orphaned-sandbox sweep's ownership test — whatever this returns gets fed to a
 * destroy call, so a false positive destroys someone else's VM.
 *
 * With no prefix the VM name IS the runner name, so ownership is the runner-name
 * grammar and nothing else. With a prefix the name must be exactly
 * `<prefix>-<digits>` — a loose `/(\d+)/` search would be catastrophic here,
 * happily reading `123` out of a stranger's `staging-db-123`.
 */
export function jobIdFromSandboxName(name: string, config: Config): number | null {
  if (!config.sandboxNamePrefix) return jobIdFromRunnerName(name);
  if (!sandboxNamesAreSweepable(config)) return null; // names may be truncated → cannot prove ownership

  const prefix = `${config.sandboxNamePrefix}-`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  const jobId = Number(rest);
  if (!Number.isSafeInteger(jobId)) return null;

  // Re-mint and compare, so a name that only *looks* like ours (leading zeros,
  // stray padding) cannot slip through.
  return `${prefix}${jobId}` === name ? jobId : null;
}

/**
 * Step 1 of provisioning: mint JIT config and create the microVM from the
 * pre-baked runner template. Returns the handle + runner name so the caller can
 * record ownership in the Coordinator BEFORE launching the runner — closing the
 * window where a `completed` webhook arriving mid-boot would leak the VM. The
 * runner is named `cos-<jobId>-<xx>` (see `runnerNameFor`) where `xx` is a 2-char
 * random token that makes every provision attempt a fresh name, so re-driving a
 * job whose earlier attempt orphaned its JIT registration can't collide (409
 * "already exists"). Kept to 2 chars for the same reason the prefix is short: the
 * JIT blob is injected via the createos `envs` value, which caps at 4096 bytes,
 * and the blob is already ~4085 without the name. That name is recorded in the DO
 * and is how a later `completed` webhook (`runner_name`) maps back to the VM that
 * ran it.
 *
 * The VM's shape comes from the label the job requested (`shapeForLabel`), and
 * the runner registers under that same single label — the two must agree or a
 * job gets a runner of the wrong size.
 */
export async function createRunnerSandbox(
  config: Config,
  github: GitHubClient,
  job: PendingJob,
  deps: SandboxDeps = {},
): Promise<{
  sandboxId: string;
  runnerName: string;
  sandbox: SandboxHandle;
  /** Name of the region whose control plane booted the VM. The caller persists
   * it on the job row; teardown dials that region (see TeardownTask.region). */
  region: string;
  timings: { mintMs: number; createMs: number };
}> {
  const attemptId =
    deps.attemptId ??
    (() =>
      Math.floor(Math.random() * 1296)
        .toString(36)
        .padStart(2, "0"));
  const runnerName = runnerNameFor(job.jobId, attemptId());

  // Time the two external legs of provisioning separately. The in_progress
  // timeline shows provision dominates spawn latency; this splits it so the next
  // optimization targets the real cost. mint = GitHub token mint + generate-
  // jitconfig (a fresh client per provision today, so a cold mint each burst —
  // the credential-session seam); create = the synchronous CreateOS host boot.
  const mintStart = Date.now();
  const jitConfig = await github.generateJitConfig(runnerName, job.label);
  const mintMs = Date.now() - mintStart;

  // Short + stable per job (`gha-ci-<jobId>`, no per-attempt suffix): collisions
  // are harmless, and dropping the runner's `cos-`/attempt token keeps it under
  // the createos name cap for dashboard use. Minted through the same function
  // the orphan sweep parses with — drift here and the sweep stops recognising
  // our own VMs.
  const sandboxName = sandboxNameFor(job.jobId, runnerName, config);

  const attempt = async (region: Region) => {
    const c = makeSandboxClient(config, deps, region);
    const createStart = Date.now();
    const sandbox = await c.createSandbox({
      shape: shapeForLabel(job.label, config),
      rootfs: config.runnerTemplate,
      disk_mib: config.runnerDiskMib,
      name: sandboxName,
      // CI jobs pull from arbitrary hosts (npm/pip/apt/git/ghcr/…); the createos
      // default egress allowlist blocks them. `["*"]` = allow all egress.
      egress: ["*"],
      // Do NOT set auto_pause_after_seconds: a paused runner goes offline to
      // GitHub (missed dispatch, 1-day deregistration). Omitting it disables
      // idle auto-pause; these VMs self-delete per job anyway.
      envs: { JIT_CONFIG: jitConfig },
    });
    return {
      sandboxId: sandbox.id,
      runnerName,
      sandbox,
      region: region.name,
      timings: { mintMs, createMs: Date.now() - createStart },
    };
  };

  // Region failover over the balanced ladder (regionLadder): the JIT config is
  // minted ONCE and reused on every attempt — it is a GitHub credential,
  // indifferent to which control plane boots the VM. Retry only on region-level
  // faults (isFailoverEligible: 5xx/connection/timeout — capacity exhaustion is a
  // bare 503); a 4xx is a request defect and fails identically everywhere. A
  // single configured region loops exactly once, i.e. the pre-region behavior. If
  // an attempt throws AFTER the VM booted server-side (response lost), that VM
  // leaks under a stable per-job name the orphaned-sandbox sweep reclaims — same
  // as the pre-failover leak path.
  const ladder = regionLadder(config, job.jobId);
  for (const [i, region] of ladder.entries()) {
    try {
      return await attempt(region);
    } catch (err) {
      if (!isFailoverEligible(err)) throw err;
      if (i < ladder.length - 1) {
        console.warn(
          `createSandbox failed in region ${region.name} job=${job.jobId}: ${String(err)} — ` +
            `failing over to ${ladder[i + 1]!.name}`,
        );
        continue;
      }
      // Every region refused, and every refusal was region-level. Before giving
      // the job back to the Coordinator — which can only retry it on the next
      // cron tick, minutes away — spend one more attempt on this job's OWN first
      // region after a short pause. A 5xx wave that hits every region at once
      // (measured 2026-08-10 on a 45-job matrix burst) clears in seconds, so this
      // is the difference between a job starting late and a job starting after a
      // full retry cycle. Retrying `ladder[0]` rather than the global primary
      // keeps the retry wave as spread as the first wave was — funnelling every
      // job's last chance onto one control plane is the concentration
      // regionLadder exists to avoid.
      //
      // Deliberately ONE attempt, at ONE region, after a delay: retrying the
      // whole ladder immediately would double the create load on a control plane
      // that is already shedding it, and the failure mode we are recovering from
      // IS overload. The spaced-out retries belong to the Coordinator
      // (#requeueForRetry, ~5 min apart), which is the right backoff for a wave.
      console.warn(
        `createSandbox failed in every region (${ladder.length}) ` +
          `job=${job.jobId}: ${String(err)} — one retry at ` +
          `${ladder[0]!.name} in ${RETRY_ALL_REGIONS_MS}ms`,
      );
      await (deps.sleep ?? sleep)(RETRY_ALL_REGIONS_MS);
      return await attempt(ladder[0]!);
    }
  }
  // Unreachable: the last iteration either returns or throws. TS needs the exit.
  throw new Error("createRunnerSandbox: region loop exited without a result");
}

/**
 * Step 2 of provisioning: launch the runner DETACHED so this call returns
 * immediately (runCommand blocks until its command exits, so we background the
 * long-lived runner with setsid). The runner's env carries the JIT config; the
 * baked-in /opt/start-runner.sh consumes $JIT_CONFIG and halts the VM on exit.
 */
export async function launchRunner(sandbox: SandboxHandle): Promise<void> {
  // Detached launch: setsid + background so the outer exec returns at once.
  await sandbox.runCommand("bash", [
    "-c",
    "setsid bash /opt/start-runner.sh >/var/log/runner.log 2>&1 </dev/null & echo started",
  ]);
}

/**
 * Destroys a sandbox. Idempotent: an already-gone VM (NotFound) is treated as
 * success, so a redelivered `completed` webhook or a double reaper pass is safe.
 *
 * `readEgress` gates a best-effort bandwidth read before the destroy — set only
 * for tenant-billed VMs (the cost gate), and skipped entirely when the VM is
 * already gone (a self-deleted runner never pays for a bandwidth subrequest).
 * Returns the egress `used_bytes`, or null when unavailable/self-deleted.
 */
export async function teardownSandbox(
  config: Config,
  sandboxId: string,
  /** Region whose control plane owns this VM (from the job row); null/undefined
   * = pre-region row → primary. An unknown name throws BEFORE any API call —
   * see regionByName: guessing here is how a live VM reads as "already gone". */
  region: string | null | undefined,
  deps: SandboxDeps = {},
  readEgress = false,
): Promise<number | null> {
  const c = makeSandboxClient(config, deps, regionByName(config, region));
  try {
    const handle = await c.getSandbox(sandboxId);
    let egress: number | null = null;
    if (readEgress) {
      // Best-effort and alert-only: a bandwidth read must never block a
      // destroy, and it is skipped entirely for un-billed VMs (cost gate).
      try {
        egress = (await handle.getBandwidth()).used_bytes;
      } catch (err) {
        console.warn(`bandwidth read failed sandbox=${sandboxId}: ${String(err)}`);
      }
    }
    await handle.destroy();
    return egress;
  } catch (err) {
    if (err instanceof CreateosSandboxNotFoundError) return null;
    throw err;
  }
}
