import { describe, it, expect, vi } from "vitest";
import { shouldProvision } from "../../src/policy";
import type { Config, WorkflowJob } from "../../src/types";

const cfg = (over: Partial<Config>): Config =>
  ({
    githubOrg: "nodeops-app",
    provisionPolicy: "org-wide",
    repoAllowlist: [],
    ...over,
  }) as Config;

const job: WorkflowJob = {
  action: "queued",
  jobId: 1,
  runId: 2,
  repoFullName: "nodeops-app/api",
  labels: ["createos"],
};

describe("shouldProvision", () => {
  it("org-wide: allows any repo in org, never calls isFork", async () => {
    const isFork = vi.fn();
    expect(await shouldProvision(cfg({ provisionPolicy: "org-wide" }), job, isFork)).toBe(true);
    expect(isFork).not.toHaveBeenCalled();
  });
  it("rejects foreign org", async () => {
    const foreign = { ...job, repoFullName: "evil/api" };
    expect(await shouldProvision(cfg({}), foreign, vi.fn())).toBe(false);
  });
  it("repo-allowlist: only listed repos", async () => {
    const c = cfg({ provisionPolicy: "repo-allowlist", repoAllowlist: ["nodeops-app/api"] });
    expect(await shouldProvision(c, job, vi.fn())).toBe(true);
    expect(await shouldProvision(c, { ...job, repoFullName: "nodeops-app/other" }, vi.fn())).toBe(false);
  });
  it("fork-gated: rejects forks, allows internal", async () => {
    const c = cfg({ provisionPolicy: "fork-gated" });
    expect(await shouldProvision(c, job, async () => true)).toBe(false);
    expect(await shouldProvision(c, job, async () => false)).toBe(true);
  });
});
