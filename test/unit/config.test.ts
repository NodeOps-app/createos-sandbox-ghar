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
});
