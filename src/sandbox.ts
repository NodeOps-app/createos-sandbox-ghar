import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import type { Config, PendingJob } from "./types";
import type { GitHubClient } from "./github/client";

export interface SandboxDeps {
  /** Injection seam for tests. Defaults to a real client from config. */
  makeClient?: (config: Config) => CreateosSandboxClient;
}

function client(config: Config, deps: SandboxDeps): CreateosSandboxClient {
  if (deps.makeClient) return deps.makeClient(config);
  return new CreateosSandboxClient({
    baseUrl: config.createosBaseUrl,
    apiKey: config.createosApiKey,
  });
}

/**
 * Boots one microVM for a job: mint JIT config, create the sandbox with the
 * pre-baked runner template, then launch the runner DETACHED so this call
 * returns immediately (runCommand blocks until its command exits, so we
 * background the long-lived runner with setsid). The runner's env carries the
 * JIT config; start-runner.sh (baked into the template) consumes $JIT_CONFIG
 * and halts the VM on exit.
 */
export async function provisionSandbox(
  config: Config,
  github: GitHubClient,
  job: PendingJob,
  deps: SandboxDeps = {},
): Promise<{ sandboxId: string }> {
  const runnerName = `ghar-${job.jobId}`;
  const jitConfig = await github.generateJitConfig(runnerName);

  const c = client(config, deps);
  const sandbox = await c.createSandbox({
    shape: config.runnerShape,
    rootfs: config.runnerTemplate,
    disk_mib: config.runnerDiskMib,
    name: runnerName,
    envs: { JIT_CONFIG: jitConfig },
  });

  // Detached launch: setsid + background so the outer exec returns at once.
  await sandbox.runCommand("bash", [
    "-c",
    "setsid bash /opt/start-runner.sh >/var/log/runner.log 2>&1 </dev/null & echo started",
  ]);

  return { sandboxId: sandbox.id };
}
