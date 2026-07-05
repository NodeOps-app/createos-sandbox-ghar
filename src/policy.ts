import type { Config, WorkflowJob } from "./types";

/**
 * Decides whether a job is eligible for a sandbox, per the configured policy.
 * `isFork` is a lazy callback (a GitHub API round-trip); it is only awaited
 * under the `fork-gated` policy so the default org-wide path stays cheap.
 */
export async function shouldProvision(
  config: Config,
  job: WorkflowJob,
  isFork: () => Promise<boolean>,
): Promise<boolean> {
  const [org] = job.repoFullName.split("/");
  if (org !== config.githubOrg) return false; // never serve other orgs

  switch (config.provisionPolicy) {
    case "org-wide":
      return true;
    case "repo-allowlist":
      return config.repoAllowlist.includes(job.repoFullName);
    case "fork-gated":
      return !(await isFork());
  }
}
