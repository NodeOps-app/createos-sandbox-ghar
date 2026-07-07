import type { Config, ProvisionPolicy } from "./types";

const POLICIES: ProvisionPolicy[] = ["org-wide", "repo-allowlist", "fork-gated"];

function req(env: Record<string, unknown>, key: string): string {
  const v = env[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required env: ${key}`);
  }
  return v;
}

function num(env: Record<string, unknown>, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid numeric env: ${key}=${String(v)}`);
  return n;
}

export function loadConfig(env: Record<string, unknown>): Config {
  const policy = (env.PROVISION_POLICY as string) || "org-wide";
  if (!POLICIES.includes(policy as ProvisionPolicy)) {
    throw new Error(`invalid PROVISION_POLICY: ${policy}`);
  }
  const allowlist = ((env.REPO_ALLOWLIST as string) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    githubOrg: req(env, "GITHUB_ORG"),
    githubApiUrl: ((env.GITHUB_API_URL as string) || "https://api.github.com").replace(/\/+$/, ""),
    githubAppId: req(env, "GITHUB_APP_ID"),
    githubAppPrivateKeyPkcs8: req(env, "GITHUB_APP_PRIVATE_KEY"),
    githubInstallationId: req(env, "GITHUB_INSTALLATION_ID"),
    githubWebhookSecret: req(env, "GITHUB_WEBHOOK_SECRET"),
    createosBaseUrl: req(env, "CREATEOS_BASE_URL"),
    createosApiKey: req(env, "CREATEOS_API_KEY"),
    runnerLabel: (env.RUNNER_LABEL as string) || "createos",
    runnerTemplate: req(env, "RUNNER_TEMPLATE"),
    sandboxNamePrefix: (env.SANDBOX_NAME_PREFIX as string) || "",
    runnerShape: (env.RUNNER_SHAPE as string) || "s-4vcpu-4gb",
    runnerDiskMib: num(env, "RUNNER_DISK_MIB", 30720),
    maxConcurrent: num(env, "MAX_CONCURRENT", 0),
    provisionPolicy: policy as ProvisionPolicy,
    repoAllowlist: allowlist,
    reaperMaxAgeMs: num(env, "REAPER_MAX_AGE_MS", 3_600_000),
    reconcileGraceMs: num(env, "RECONCILE_GRACE_MS", 180_000),
    alertWebhookUrl: (env.ALERT_WEBHOOK_URL as string) || undefined,
  };
}
