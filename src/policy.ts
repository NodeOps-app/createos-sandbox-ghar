import type { Config } from "./types";

export interface PolicyJob {
  repoFullName: string;
}

/**
 * Decides whether a job is eligible for a Sandbox. `isFork` is lazy and is
 * awaited only by fork-gated policy, so org-wide admission stays network-free.
 */
export async function shouldProvision(
  config: Config,
  job: PolicyJob,
  isFork: () => Promise<boolean>,
): Promise<boolean> {
  const [org] = job.repoFullName.split("/");
  // GitHub org logins are case-insensitive; the webhook casing may differ from config.
  if (org?.toLowerCase() !== config.githubOrg.toLowerCase()) return false; // never serve other orgs

  switch (config.provisionPolicy) {
    case "org-wide":
      return true;
    case "repo-allowlist":
      return config.repoAllowlist.includes(job.repoFullName);
    case "fork-gated":
      return !(await isFork());
  }
}
