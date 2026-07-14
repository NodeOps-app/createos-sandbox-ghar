import { describe, it, expect, vi } from "vitest";
import {
  createRunnerSandbox,
  jobIdFromRunnerName,
  launchRunner,
  RUNNER_PREFIX,
  runnerNameFor,
  teardownSandbox,
} from "../../src/sandbox";
import { CreateosSandboxNotFoundError } from "@nodeops-createos/sandbox";
import type { Config, PendingJob } from "../../src/types";

describe("jobIdFromRunnerName", () => {
  // The orphaned-runner sweep's ownership test. A name that parses is one we
  // minted and may be deleted from the org; anything else belongs to someone
  // else and is untouchable. Both directions matter: a false positive deletes a
  // stranger's runner, a false negative strands our own leak forever.
  it("round-trips every name createRunnerSandbox mints", () => {
    expect(jobIdFromRunnerName(runnerNameFor(86749416515, "ow"))).toBe(86749416515);
  });

  // Malformed cases are built from RUNNER_PREFIX, never spelled out: renaming the
  // prefix must not touch this file. The literals below are the names we must
  // NOT own, so they are literal on purpose.
  it.each([
    ["arc-runner-set-bvlbx-runner-c7n4v", "an Actions Runner Controller runner"],
    ["ghar-runner", "the template name, not a runner name"],
    // The prefix was `ghar-` before it was shortened to fit the 4096-byte JIT
    // cap. Legacy names deliberately do NOT parse, so the sweeper leaves them
    // alone rather than guessing — any left on GitHub at the rename are cleaned
    // up once, by hand.
    ["ghar-86749416515-ow", "a runner minted under the pre-rename prefix"],
    [`${RUNNER_PREFIX}123`, "no attempt suffix"],
    [`${RUNNER_PREFIX}-aa`, "no job id"],
    [`${RUNNER_PREFIX}abc-aa`, "non-numeric job id"],
    [`${RUNNER_PREFIX}123-toolong`, "suffix is not the 2-char token we mint"],
    [`prefix-${RUNNER_PREFIX}123-aa`, "not anchored at the start"],
    ["", "empty"],
  ])("refuses %j — %s", (name) => {
    expect(jobIdFromRunnerName(name)).toBeNull();
  });
});

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
      makeClient: () => ({ createSandbox, getSandbox: vi.fn(), listShapes: vi.fn() }),
      attemptId: () => "k3",
    });

    // Runner name carries a 2-char attempt token so a re-driven job can't collide.
    expect(github.generateJitConfig).toHaveBeenCalledWith(runnerNameFor(100, "k3"), "createos");
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
    expect(res.runnerName).toBe(runnerNameFor(100, "k3"));
  });

  it("gives each provision attempt of the same job a distinct runner name", async () => {
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand: vi.fn() });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;

    const a = await createRunnerSandbox(config, github, job, {
      makeClient: () => ({ createSandbox, getSandbox: vi.fn(), listShapes: vi.fn() }),
      attemptId: () => "k3",
    });
    const b = await createRunnerSandbox(config, github, job, {
      makeClient: () => ({ createSandbox, getSandbox: vi.fn(), listShapes: vi.fn() }),
      attemptId: () => "z9",
    });

    expect(a.runnerName).not.toBe(b.runnerName);
  });

  it("default attempt token is 2 chars (keeps JIT blob under the 4096 env cap)", async () => {
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand: vi.fn() });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;

    await createRunnerSandbox(config, github, job, {
      makeClient: () => ({ createSandbox, getSandbox: vi.fn(), listShapes: vi.fn() }),
    });

    const name = github.generateJitConfig.mock.calls[0]![0] as string;
    expect(name).toMatch(new RegExp(`^${RUNNER_PREFIX}100-[0-9a-z]{2}$`));
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
      makeClient: () => ({ createSandbox, getSandbox: vi.fn(), listShapes: vi.fn() }),
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
      makeClient: () => ({ createSandbox, getSandbox: vi.fn(), listShapes: vi.fn() }),
      attemptId: () => "aa",
    });

    expect(createSandbox.mock.calls[0]![0].shape).toBe("s-8vcpu-16gb");
    expect(github.generateJitConfig).toHaveBeenCalledWith(runnerNameFor(7, "aa"), "createos-8vcpu-16gb");
  });
});

describe("launchRunner", () => {
  it("launches the runner detached via setsid", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValue({ result: { stdout: "started", stderr: "", exit_code: 0 }, exec_ms: 5 });
    await launchRunner({ id: "sb_1", runCommand });
    expect(runCommand.mock.calls[0]![0]).toBe("bash");
    expect(runCommand.mock.calls[0]![1][1]).toContain("setsid");
  });
});

describe("teardownSandbox", () => {
  it("destroys an existing sandbox", async () => {
    const destroy = vi.fn().mockResolvedValue({ id: "sb_1", status: "destroying" });
    const getSandbox = vi.fn().mockResolvedValue({ destroy });
    await teardownSandbox(config, "sb_1", {
      makeClient: () => ({ getSandbox, createSandbox: vi.fn(), listShapes: vi.fn() }),
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("swallows NotFound (idempotent)", async () => {
    const getSandbox = vi
      .fn()
      .mockRejectedValue(
        new CreateosSandboxNotFoundError("gone", new Response(null, { status: 404 })),
      );
    await expect(
      teardownSandbox(config, "sb_x", {
        makeClient: () => ({ getSandbox, createSandbox: vi.fn(), listShapes: vi.fn() }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rethrows other errors", async () => {
    const getSandbox = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      teardownSandbox(config, "sb_x", {
        makeClient: () => ({ getSandbox, createSandbox: vi.fn(), listShapes: vi.fn() }),
      }),
    ).rejects.toThrow(/boom/);
  });
});
