import { CreateosSandboxClient, CreateosSandboxNotFoundError } from "@nodeops-createos/sandbox";
import type { Config, PendingJob } from "./types";
import type { GitHubClient } from "./github/client";

/** A booted sandbox handle — the subset createRunnerSandbox returns to launchRunner. */
export type SandboxHandle = Awaited<ReturnType<CreateosSandboxClient["createSandbox"]>>;

export interface SandboxDeps {
  /** Injection seam for tests. Defaults to a real client from config. */
  makeClient?: (config: Config) => CreateosSandboxClient;
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

/**
 * Step 1 of provisioning: mint JIT config and create the microVM from the
 * pre-baked runner template. Returns the handle + runner name so the caller can
 * record ownership in the Coordinator BEFORE launching the runner — closing the
 * window where a `completed` webhook arriving mid-boot would leak the VM. The
 * runner is named `ghar-<jobId>`; that name is how a later `completed` webhook
 * (`runner_name`) maps back to the VM that ran the job.
 */
export async function createRunnerSandbox(
  config: Config,
  github: GitHubClient,
  job: PendingJob,
  deps: SandboxDeps = {},
): Promise<{ sandboxId: string; runnerName: string; sandbox: SandboxHandle }> {
  const runnerName = `ghar-${job.jobId}`;
  const jitConfig = await github.generateJitConfig(runnerName);

  // The createos VM name is cosmetic (teardown keys on sandbox_id + runner
  // identity, not this). Prefix it so CI VMs are identifiable in the createos
  // dashboard; the GitHub runner name stays `ghar-<jobId>` for ownership.
  const sandboxName = config.sandboxNamePrefix
    ? `${config.sandboxNamePrefix}-${runnerName}`
    : runnerName;

  const c = client(config, deps);
  const sandbox = await c.createSandbox({
    shape: config.runnerShape,
    rootfs: config.runnerTemplate,
    disk_mib: config.runnerDiskMib,
    name: sandboxName,
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
