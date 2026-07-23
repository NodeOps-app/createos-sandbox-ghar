import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config";

const base = {
  GITHUB_ORG: "nodeops-app",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
  GITHUB_INSTALLATION_ID: "2",
  GITHUB_WEBHOOK_SECRET: "s",
  CREATEOS_BASE_URL: "https://api.createos",
  CREATEOS_API_KEY: "k",
  RUNNER_TEMPLATE: "ghar-runner",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.runnerLabel).toBe("createos");
    expect(c.runnerShape).toBe("s-4vcpu-4gb");
    expect(c.runnerDiskMib).toBe(30720);
    expect(c.maxConcurrent).toBe(0);
    expect(c.provisionPolicy).toBe("org-wide");
    expect(c.repoAllowlist).toEqual([]);
    expect(c.reaperMaxAgeMs).toBe(3_600_000);
    expect(c.reconcileGraceMs).toBe(180_000);
    expect(c.sandboxNamePrefix).toBe(""); // no prefix unless SANDBOX_NAME_PREFIX set
    expect(c.runnerGroupId).toBe(1); // org-wide Default group
  });

  it("parses a non-default runner group", () => {
    expect(loadConfig({ ...base, RUNNER_GROUP_ID: "7" }).runnerGroupId).toBe(7);
  });

  it("rejects a non-positive-integer runner group", () => {
    // A bad group id mints fine but 404s at generate-jitconfig, failing every
    // job async — must fail loud at startup instead.
    // Only a canonical positive-decimal string is admitted; exponent and hex
    // forms coerce to a *different* group under Number() and must be rejected.
    for (const bad of ["0", "-1", "1.5", "abc", " ", "1e30", "1e2", "0x10", "07", "+1"]) {
      expect(() => loadConfig({ ...base, RUNNER_GROUP_ID: bad })).toThrow(/RUNNER_GROUP_ID/);
    }
    // Non-string bindings must not coerce (Number(true)=1, Number([7])=7) onto a
    // group the operator never named.
    for (const bad of [true, [7], {}]) {
      expect(() => loadConfig({ ...base, RUNNER_GROUP_ID: bad })).toThrow(/RUNNER_GROUP_ID/);
    }
  });

  it("prefixes sandbox name when SANDBOX_NAME_PREFIX set", () => {
    expect(loadConfig({ ...base, SANDBOX_NAME_PREFIX: "gha-ci" }).sandboxNamePrefix).toBe("gha-ci");
  });

  it("parses allowlist csv", () => {
    const c = loadConfig({
      ...base,
      PROVISION_POLICY: "repo-allowlist",
      REPO_ALLOWLIST: "a/b, c/d",
    });
    expect(c.repoAllowlist).toEqual(["a/b", "c/d"]);
  });

  it("throws on missing required env", () => {
    const { GITHUB_ORG: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/GITHUB_ORG/);
  });

  it("throws on bad policy", () => {
    expect(() => loadConfig({ ...base, PROVISION_POLICY: "nope" })).toThrow(/PROVISION_POLICY/);
  });

  it("throws on negative number", () => {
    expect(() => loadConfig({ ...base, MAX_CONCURRENT: "-3" })).toThrow(/MAX_CONCURRENT/);
  });

  it("tenancyMode defaults single, accepts multi, rejects junk", () => {
    expect(loadConfig(base).tenancyMode).toBe("single");
    expect(loadConfig({ ...base, TENANCY_MODE: "multi" }).tenancyMode).toBe("multi");
    expect(() => loadConfig({ ...base, TENANCY_MODE: "dual" })).toThrow(/TENANCY_MODE/);
  });
});
