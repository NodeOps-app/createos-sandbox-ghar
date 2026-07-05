import { describe, it, expect, vi } from "vitest";
import { provisionSandbox } from "../../src/sandbox";
import type { Config, PendingJob } from "../../src/types";

const config = { runnerShape: "s-4vcpu-4gb", runnerTemplate: "ghar-runner", runnerDiskMib: 30720 } as Config;
const job: PendingJob = { jobId: 100, runId: 200, repoFullName: "nodeops-app/api" };

describe("provisionSandbox", () => {
  it("mints jit, creates sandbox, launches runner detached", async () => {
    const runCommand = vi.fn().mockResolvedValue({ result: { stdout: "started", stderr: "", exit_code: 0 }, exec_ms: 5 });
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;

    const res = await provisionSandbox(config, github, job, {
      makeClient: () => ({ createSandbox }) as any,
    });

    expect(github.generateJitConfig).toHaveBeenCalledWith("ghar-100");
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ shape: "s-4vcpu-4gb", rootfs: "ghar-runner", envs: { JIT_CONFIG: "BLOB" } }),
    );
    expect(runCommand.mock.calls[0]![0]).toBe("bash");
    expect(runCommand.mock.calls[0]![1][1]).toContain("setsid");
    expect(res).toEqual({ sandboxId: "sb_1" });
  });
});
