import type { Config, ProvisionPolicy, Region } from "./types";

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

// A GitHub id (runner group). Must be a positive integer — 0, fractions,
// whitespace-as-zero and unsafe integers all mint fine but 404 at
// generate-jitconfig, which would fail every admitted job asynchronously and
// have the reconciler retry it forever. Fail fast at startup instead.
function posInt(env: Record<string, unknown>, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  // Whitelist canonical decimal, never coerce. `Number()` alone would accept
  // `true`→1, `[7]`→7, `"1e2"`→100, `"0x10"`→16 — each landing on a group the
  // operator never named. This one is a trust boundary, so anything but a plain
  // positive-integer string fails loud. (`.test` stringifies, so the typeof
  // guard is what blocks `[7]`; isSafeInteger caps an oversized digit run.)
  const n = typeof v === "string" && /^[1-9]\d*$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`invalid env: ${key}=${String(v)} (want a positive integer)`);
  }
  return n;
}

// The tenancy switch is a trust boundary like PROVISION_POLICY: an unknown
// value must fail startup, not silently mean "single".
function mode(env: Record<string, unknown>): "single" | "multi" {
  const v = (env.TENANCY_MODE as string) || "single";
  if (v !== "single" && v !== "multi") throw new Error(`invalid TENANCY_MODE: ${v}`);
  return v;
}

/**
 * The CreateOS control planes provisioning may use, primary first. Parsed from
 * CREATEOS_REGIONS ("us=https://api-us.sb.createos.sh,eu=https://api-eu.sb.createos.sh");
 * when unset, CREATEOS_BASE_URL becomes a single region named "default" — the
 * pre-region behavior, verbatim. A region NAME is persisted on every job row and
 * read back at teardown, so it must be stable across deploys (like RUNNER_LABEL):
 * renaming a region strands every row the old name owns.
 */
function regions(env: Record<string, unknown>): Region[] {
  const raw = (env.CREATEOS_REGIONS as string) || "";
  if (!raw.trim()) {
    return [{ name: "default", baseUrl: req(env, "CREATEOS_BASE_URL").replace(/\/+$/, "") }];
  }
  const out: Region[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const m = /^([a-z0-9][a-z0-9-]*)=(https:\/\/\S+)$/.exec(entry.trim());
    if (!m) {
      throw new Error(
        `invalid CREATEOS_REGIONS entry: ${JSON.stringify(entry)} (want name=https://host)`,
      );
    }
    const name = m[1]!;
    const baseUrl = m[2]!;
    if (seen.has(name)) throw new Error(`duplicate CREATEOS_REGIONS region: ${name}`);
    seen.add(name);
    out.push({ name, baseUrl: baseUrl.replace(/\/+$/, "") });
  }
  return out;
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
    createosRegions: regions(env),
    createosApiKey: req(env, "CREATEOS_API_KEY"),
    runnerLabel: (env.RUNNER_LABEL as string) || "createos",
    runnerGroupId: posInt(env, "RUNNER_GROUP_ID", 1),
    runnerTemplate: req(env, "RUNNER_TEMPLATE"),
    sandboxNamePrefix: (env.SANDBOX_NAME_PREFIX as string) || "",
    runnerShape: (env.RUNNER_SHAPE as string) || "s-4vcpu-4gb",
    minRunnerMemMib: num(env, "MIN_RUNNER_MEM_MIB", 2048),
    runnerDiskMib: num(env, "RUNNER_DISK_MIB", 30720),
    maxConcurrent: num(env, "MAX_CONCURRENT", 0),
    provisionPolicy: policy as ProvisionPolicy,
    repoAllowlist: allowlist,
    reaperMaxAgeMs: num(env, "REAPER_MAX_AGE_MS", 3_600_000),
    reconcileGraceMs: num(env, "RECONCILE_GRACE_MS", 180_000),
    recoverySubrequestBudget: num(env, "RECOVERY_SUBREQUEST_BUDGET", 30),
    alertWebhookUrl: (env.ALERT_WEBHOOK_URL as string) || undefined,
    slowJobThresholdMs: num(env, "SLOW_JOB_THRESHOLD_MS", 60_000),
    adminToken: (env.ADMIN_TOKEN as string) || undefined,
    tenancyMode: mode(env),
    applyFormUrl: (env.APPLY_FORM_URL as string) || "",
  };
}
