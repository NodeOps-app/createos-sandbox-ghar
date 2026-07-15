import { describe, expect, it, vi } from "vitest";
import { createJobAdmission, identifyJob, type JobCandidate } from "../../src/admission";
import { loadConfig } from "../../src/config";
import type { Catalog } from "../../src/shapes";

const config = loadConfig({
  GITHUB_ORG: "nodeops-app",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "key",
  GITHUB_INSTALLATION_ID: "2",
  GITHUB_WEBHOOK_SECRET: "secret",
  CREATEOS_BASE_URL: "https://createos.test",
  CREATEOS_API_KEY: "token",
  RUNNER_TEMPLATE: "ghar-runner",
  RUNNER_LABEL: "createos",
  RUNNER_SHAPE: "s-4vcpu-4gb",
});

const candidate = (overrides: Partial<JobCandidate> = {}): JobCandidate => ({
  jobId: 101,
  runId: 201,
  repoFullName: "nodeops-app/api",
  labels: ["self-hosted", "createos"],
  ...overrides,
});

const healthy: Catalog = {
  ok: true,
  usable: new Set(["s-2vcpu-2gb", "s-4vcpu-4gb"]),
};

describe("identifyJob", () => {
  it("identifies none, ambiguity, and one requested label", () => {
    expect(identifyJob(candidate({ labels: ["ubuntu-latest"] }), config)).toEqual({
      kind: "none",
    });
    expect(identifyJob(candidate({ labels: ["createos", "createos-2vcpu-2gb"] }), config)).toEqual({
      kind: "ambiguous",
      labels: ["createos", "createos-2vcpu-2gb"],
    });
    expect(identifyJob(candidate(), config)).toEqual({
      kind: "identified",
      job: {
        jobId: 101,
        runId: 201,
        repoFullName: "nodeops-app/api",
        label: "createos",
      },
    });
  });
});

describe("createJobAdmission", () => {
  it("admits a bare label without loading the Shape catalog", async () => {
    const loadCatalog = vi.fn<() => Promise<Catalog>>().mockResolvedValue(healthy);
    const admit = createJobAdmission(config, {
      isForkJob: vi.fn().mockResolvedValue(false),
      loadCatalog,
    });

    await expect(admit(candidate())).resolves.toMatchObject({ kind: "admitted" });
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("applies policy before loading the Shape catalog", async () => {
    const blocked = { ...config, provisionPolicy: "repo-allowlist" as const, repoAllowlist: [] };
    const loadCatalog = vi.fn<() => Promise<Catalog>>().mockResolvedValue(healthy);
    const admit = createJobAdmission(blocked, {
      isForkJob: vi.fn().mockResolvedValue(false),
      loadCatalog,
    });

    await expect(admit(candidate({ labels: ["createos-2vcpu-2gb"] }))).resolves.toEqual({
      kind: "refused",
      reason: "policy-skip",
    });
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("shares one lazy catalog across a batch", async () => {
    const loadCatalog = vi.fn<() => Promise<Catalog>>().mockResolvedValue(healthy);
    const admit = createJobAdmission(config, {
      isForkJob: vi.fn().mockResolvedValue(false),
      loadCatalog,
    });

    await expect(
      admit(candidate({ jobId: 102, labels: ["createos-2vcpu-2gb"] })),
    ).resolves.toMatchObject({ kind: "admitted" });
    await expect(
      admit(candidate({ jobId: 103, labels: ["createos-4vcpu-4gb"] })),
    ).resolves.toMatchObject({ kind: "admitted" });
    expect(loadCatalog).toHaveBeenCalledOnce();
  });

  it("distinguishes unavailable and unknown Shapes", async () => {
    const unavailable = createJobAdmission(config, {
      isForkJob: vi.fn().mockResolvedValue(false),
      loadCatalog: vi.fn().mockResolvedValue({ ok: false }),
    });
    await expect(unavailable(candidate({ labels: ["createos-2vcpu-2gb"] }))).resolves.toEqual({
      kind: "refused",
      reason: "catalog-unavailable",
      label: "createos-2vcpu-2gb",
    });

    const unknown = createJobAdmission(config, {
      isForkJob: vi.fn().mockResolvedValue(false),
      loadCatalog: vi.fn().mockResolvedValue(healthy),
    });
    await expect(unknown(candidate({ labels: ["createos-99vcpu-1tb"] }))).resolves.toEqual({
      kind: "refused",
      reason: "unknown-shape",
      label: "createos-99vcpu-1tb",
      shape: "s-99vcpu-1tb",
    });
  });
});
