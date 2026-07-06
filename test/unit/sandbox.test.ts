import { describe, it, expect, vi } from "vitest";
import { createRunnerSandbox, launchRunner, teardownSandbox } from "../../src/sandbox";
import { CreateosSandboxNotFoundError } from "@nodeops-createos/sandbox";
import type { Config, PendingJob } from "../../src/types";

const config = {
  runnerShape: "s-4vcpu-4gb",
  runnerTemplate: "ghar-runner",
  runnerDiskMib: 30720,
} as Config;
const job: PendingJob = { jobId: 100, runId: 200, repoFullName: "nodeops-app/api" };

describe("createRunnerSandbox", () => {
  it("mints jit and creates the sandbox, returning the handle + runner name", async () => {
    const runCommand = vi.fn();
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;

    const res = await createRunnerSandbox(config, github, job, {
      makeClient: () => ({ createSandbox }) as any,
    });

    expect(github.generateJitConfig).toHaveBeenCalledWith("ghar-100");
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        shape: "s-4vcpu-4gb",
        rootfs: "ghar-runner",
        name: "ghar-100",
        envs: { JIT_CONFIG: "BLOB" },
      }),
    );
    // Does NOT launch the runner — that is a separate step, after ownership is recorded.
    expect(runCommand).not.toHaveBeenCalled();
    expect(res.sandboxId).toBe("sb_1");
    expect(res.runnerName).toBe("ghar-100");
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
