import { describe, it, expect, vi } from "vitest";
import { createRunnerSandbox, launchRunner, teardownSandbox } from "../../src/sandbox";
import { CreateosSandboxNotFoundError } from "@nodeops-createos/sandbox";
import type { Config, PendingJob } from "../../src/types";

const config = {
  runnerLabel: "createos",
  runnerShape: "s-4vcpu-4gb",
  runnerTemplate: "ghar-runner",
  runnerDiskMib: 30720,
  sandboxNamePrefix: "gha-ci",
} as Config;
const job: PendingJob = {
  jobId: 100,
  runId: 200,
  repoFullName: "nodeops-app/api",
  label: "createos",
};

describe("createRunnerSandbox", () => {
  it("mints jit and creates the sandbox, returning the handle + runner name", async () => {
    const runCommand = vi.fn();
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;

    const res = await createRunnerSandbox(config, github, job, {
      makeClient: () => ({ createSandbox }) as any,
      attemptId: () => "k3",
    });

    // Runner name carries a 2-char attempt token so a re-driven job can't collide.
    expect(github.generateJitConfig).toHaveBeenCalledWith("ghar-100-k3", "createos");
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        shape: "s-4vcpu-4gb",
        rootfs: "ghar-runner",
        name: "gha-ci-100", // cosmetic VM name stays short + suffix-free
        egress: ["*"], // CI needs unrestricted egress
        envs: { JIT_CONFIG: "BLOB" },
      }),
    );
    // Does NOT launch the runner — that is a separate step, after ownership is recorded.
    expect(runCommand).not.toHaveBeenCalled();
    expect(res.sandboxId).toBe("sb_1");
    expect(res.runnerName).toBe("ghar-100-k3");
  });

  it("gives each provision attempt of the same job a distinct runner name", async () => {
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand: vi.fn() });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;

    const a = await createRunnerSandbox(config, github, job, {
      makeClient: () => ({ createSandbox }) as any,
      attemptId: () => "k3",
    });
    const b = await createRunnerSandbox(config, github, job, {
      makeClient: () => ({ createSandbox }) as any,
      attemptId: () => "z9",
    });

    expect(a.runnerName).not.toBe(b.runnerName);
  });

  it("default attempt token is 2 chars (keeps JIT blob under the 4096 env cap)", async () => {
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand: vi.fn() });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;

    await createRunnerSandbox(config, github, job, {
      makeClient: () => ({ createSandbox }) as any,
    });

    const name = github.generateJitConfig.mock.calls[0]![0] as string;
    expect(name).toMatch(/^ghar-100-[0-9a-z]{2}$/);
  });

  it("clamps the VM name to the createos 22-char cap", async () => {
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand: vi.fn() });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;
    // 11-digit jobId: gha-ci-<11> = 18, fits; force overflow with a long prefix.
    const cfg = { ...config, sandboxNamePrefix: "gha-ci-nodeops" } as Config;
    const bigJob: PendingJob = {
      jobId: 85556234917,
      runId: 1,
      repoFullName: "nodeops-app/api",
      label: "createos",
    };

    await createRunnerSandbox(cfg, github, bigJob, {
      makeClient: () => ({ createSandbox }) as any,
    });

    const name = createSandbox.mock.calls[0]![0].name;
    expect(name.length).toBeLessThanOrEqual(22);
    expect(name).toBe("gha-ci-nodeops-8555623");
  });

  it("derives the VM shape from the job's label", async () => {
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1" });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;
    const shapedJob: PendingJob = {
      jobId: 7,
      runId: 1,
      repoFullName: "o/r",
      label: "createos-8vcpu-16gb",
    };

    await createRunnerSandbox(config, github, shapedJob, {
      makeClient: () => ({ createSandbox }) as any,
      attemptId: () => "aa",
    });

    expect(createSandbox.mock.calls[0]![0].shape).toBe("s-8vcpu-16gb");
    expect(github.generateJitConfig).toHaveBeenCalledWith("ghar-7-aa", "createos-8vcpu-16gb");
  });
});

describe("launchRunner", () => {
  it("launches the runner detached via setsid", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValue({ result: { stdout: "started", stderr: "", exit_code: 0 }, exec_ms: 5 });
    await launchRunner({ id: "sb_1", runCommand } as any);
    expect(runCommand.mock.calls[0]![0]).toBe("bash");
    expect(runCommand.mock.calls[0]![1][1]).toContain("setsid");
  });
});

describe("teardownSandbox", () => {
  it("destroys an existing sandbox", async () => {
    const destroy = vi.fn().mockResolvedValue({ id: "sb_1", status: "destroying" });
    const getSandbox = vi.fn().mockResolvedValue({ destroy });
    await teardownSandbox(config, "sb_1", { makeClient: () => ({ getSandbox }) as any });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("swallows NotFound (idempotent)", async () => {
    const getSandbox = vi
      .fn()
      .mockRejectedValue(
        new CreateosSandboxNotFoundError("gone", new Response(null, { status: 404 })),
      );
    await expect(
      teardownSandbox(config, "sb_x", { makeClient: () => ({ getSandbox }) as any }),
    ).resolves.toBeUndefined();
  });

  it("rethrows other errors", async () => {
    const getSandbox = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      teardownSandbox(config, "sb_x", { makeClient: () => ({ getSandbox }) as any }),
    ).rejects.toThrow(/boom/);
  });
});
