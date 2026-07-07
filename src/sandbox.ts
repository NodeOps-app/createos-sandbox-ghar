import { CreateosSandboxClient, CreateosSandboxNotFoundError } from "@nodeops-createos/sandbox";
import type { Config, PendingJob } from "./types";
import type { GitHubClient } from "./github/client";

/** A booted sandbox handle — the subset createRunnerSandbox returns to launchRunner. */
export type SandboxHandle = Awaited<ReturnType<CreateosSandboxClient["createSandbox"]>>;

export interface SandboxDeps {
  /** Injection seam for tests. Defaults to a real client from config. */
  makeClient?: (config: Config) => CreateosSandboxClient;
  /** Injection seam for tests. Unix seconds; discriminates provision attempts. */
  now?: () => number;
}

function client(config: Config, deps: SandboxDeps): CreateosSandboxClient {
  if (deps.makeClient) return deps.makeClient(config);
  return new CreateosSandboxClient({
    baseUrl: config.createosBaseUrl,
    apiKey: config.createosApiKey,
    // Workers rejects an unbound fetch called off the SDK's config object.
    fetch: globalThis.fetch.bind(globalThis),
  });
}

/** createos-sandbox rejects names longer than this (API returns 400). */
const MAX_SANDBOX_NAME = 22;

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
 * Step 1 of provisioning: mint JIT config and create the microVM from the
 * pre-baked runner template. Returns the handle + runner name so the caller can
 * record ownership in the Coordinator BEFORE launching the runner — closing the
 * window where a `completed` webhook arriving mid-boot would leak the VM. The
 * runner is named `ghar-<jobId>-<unixSec>`; the unix-seconds suffix makes every
 * provision attempt a fresh name so re-driving a job whose earlier attempt
 * orphaned its JIT registration can't collide (409 "already exists"). That name
 * is recorded in the DO and is how a later `completed` webhook (`runner_name`)
 * maps back to the VM that ran the job.
 */
export async function createRunnerSandbox(
  config: Config,
  github: GitHubClient,
  job: PendingJob,
  deps: SandboxDeps = {},
): Promise<{ sandboxId: string; runnerName: string; sandbox: SandboxHandle }> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const runnerName = `ghar-${job.jobId}-${now()}`;
  const jitConfig = await github.generateJitConfig(runnerName);

  // The createos VM name is cosmetic (teardown keys on sandbox_id + runner
  // identity, not this). Keep it short + stable per job (`gha-ci-<jobId>`, no
  // per-attempt suffix): collisions are harmless here, and dropping the runner's
  // `ghar-`/timestamp keeps it under the createos name cap for dashboard use.
  const sandboxName = clampSandboxName(
    config.sandboxNamePrefix ? `${config.sandboxNamePrefix}-${job.jobId}` : runnerName,
  );

  const c = client(config, deps);
  const sandbox = await c.createSandbox({
    shape: config.runnerShape,
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

  return { sandboxId: sandbox.id, runnerName, sandbox };
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
 */
export async function teardownSandbox(
  config: Config,
  sandboxId: string,
  deps: SandboxDeps = {},
): Promise<void> {
  const c = client(config, deps);
  try {
    const handle = await c.getSandbox(sandboxId);
    await handle.destroy();
  } catch (err) {
    if (err instanceof CreateosSandboxNotFoundError) return;
    throw err;
  }
}
