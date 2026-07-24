import { describe, it, expect, vi } from "vitest";
import {
  createRunnerSandbox,
  jobIdFromRunnerName,
  jobIdFromSandboxName,
  launchRunner,
  RUNNER_PREFIX,
  runnerNameFor,
  sandboxNameFor,
  sandboxNamesAreSweepable,
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

describe("jobIdFromSandboxName", () => {
  // The orphaned-SANDBOX sweep's ownership test, and the sharpest edge in this
  // file: what it returns gets fed straight to destroy(). A false positive
  // destroys a VM we did not create — the createos account also holds hand-made
  // boxes and other projects' sandboxes.
  const noPrefix = { ...config, sandboxNamePrefix: "" } as Config;

  it("round-trips the name createRunnerSandbox mints (prefixed)", () => {
    expect(jobIdFromSandboxName(sandboxNameFor(86749416515, "ignored", config), config)).toBe(
      86749416515,
    );
  });

  it("round-trips the name createRunnerSandbox mints (no prefix → the runner name)", () => {
    const runner = runnerNameFor(86749416515, "ow");
    expect(jobIdFromSandboxName(sandboxNameFor(86749416515, runner, noPrefix), noPrefix)).toBe(
      86749416515,
    );
  });

  it.each([
    ["staging-db-123", "a stranger's VM that merely contains digits"],
    ["gha-ci", "the bare prefix, no job id"],
    ["gha-ci-", "empty job id"],
    ["gha-ci-abc", "non-numeric job id"],
    ["gha-ci-123-extra", "trailing junk after the job id"],
    ["x-gha-ci-123", "not anchored at the start"],
    ["friendly-heyrovsky", "an unrelated auto-named box"],
    ["", "empty"],
  ])("refuses %j — %s", (name) => {
    expect(jobIdFromSandboxName(name, config)).toBeNull();
  });

  it("refuses a runner-shaped name when a prefix IS configured", () => {
    expect(jobIdFromSandboxName(runnerNameFor(123, "aa"), config)).toBeNull();
  });

  it("refuses a bare prefixed name when NO prefix is configured", () => {
    // With no prefix the VM name is the runner name, so only that grammar owns it.
    expect(jobIdFromSandboxName("gha-ci-123", noPrefix)).toBeNull();
  });

  // The sharpest failure mode of all. Under a long prefix, job 86749416515 mints
  // `gha-ci-nodeops-app-86749416515`, which createos truncates to
  // `gha-ci-nodeops-app-867` — a name that parses cleanly as job 867 and even
  // round-trips back to itself. Nothing in the NAME reveals the lie. Were the
  // sweep to act on it, it would find no row for job 867 and destroy the VM while
  // job 86749416515 was still running on it. So ownership is refused wholesale
  // for any config whose names can truncate.
  describe("a prefix long enough to truncate disables ownership entirely", () => {
    const long = { ...config, sandboxNamePrefix: "gha-ci-nodeops-app" } as Config;

    it("is not sweepable", () => {
      expect(sandboxNamesAreSweepable(long)).toBe(false);
      expect(sandboxNamesAreSweepable(config)).toBe(true); // the deployed prefix is fine
      expect(sandboxNamesAreSweepable(noPrefix)).toBe(true);
    });

    it("refuses the truncated name, and the plausible-but-wrong job id it parses as", () => {
      const minted = sandboxNameFor(86749416515, "ignored", long);
      expect(minted).toBe("gha-ci-nodeops-app-867"); // truncated: the digits are a lie
      expect(jobIdFromSandboxName(minted, long)).toBeNull();
      // Even a name that is genuinely well-formed under this prefix is refused —
      // we cannot tell it apart from a truncated one.
      expect(jobIdFromSandboxName("gha-ci-nodeops-app-867", long)).toBeNull();
    });
  });
});
const job: PendingJob = {
  jobId: 100,
  runId: 200,
  repoFullName: "nodeops-app/api",
  label: "createos",
  tenant: null,
};

describe("createRunnerSandbox", () => {
  it("mints jit and creates the sandbox, returning the handle + runner name", async () => {
    const runCommand = vi.fn();
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;

    const res = await createRunnerSandbox(config, github, job, {
      makeClient: () => ({
        createSandbox,
        getSandbox: vi.fn(),
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
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
    // Provision sub-phase timings feed the breakdown log (mint vs create).
    expect(typeof res.timings.mintMs).toBe("number");
    expect(typeof res.timings.createMs).toBe("number");
  });

  it("gives each provision attempt of the same job a distinct runner name", async () => {
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand: vi.fn() });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;

    const a = await createRunnerSandbox(config, github, job, {
      makeClient: () => ({
        createSandbox,
        getSandbox: vi.fn(),
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
      attemptId: () => "k3",
    });
    const b = await createRunnerSandbox(config, github, job, {
      makeClient: () => ({
        createSandbox,
        getSandbox: vi.fn(),
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
      attemptId: () => "z9",
    });

    expect(a.runnerName).not.toBe(b.runnerName);
  });

  it("default attempt token is 2 chars (keeps JIT blob under the 4096 env cap)", async () => {
    const createSandbox = vi.fn().mockResolvedValue({ id: "sb_1", runCommand: vi.fn() });
    const github = { generateJitConfig: vi.fn().mockResolvedValue("BLOB") } as any;

    await createRunnerSandbox(config, github, job, {
      makeClient: () => ({
        createSandbox,
        getSandbox: vi.fn(),
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
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
      tenant: null,
    };

    await createRunnerSandbox(cfg, github, bigJob, {
      makeClient: () => ({
        createSandbox,
        getSandbox: vi.fn(),
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
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
      tenant: null,
    };

    await createRunnerSandbox(config, github, shapedJob, {
      makeClient: () => ({
        createSandbox,
        getSandbox: vi.fn(),
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
      attemptId: () => "aa",
    });

    expect(createSandbox.mock.calls[0]![0].shape).toBe("s-8vcpu-16gb");
    expect(github.generateJitConfig).toHaveBeenCalledWith(
      runnerNameFor(7, "aa"),
      "createos-8vcpu-16gb",
    );
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
  it("destroys an existing sandbox; readEgress defaults false (no bandwidth read, null return)", async () => {
    const destroy = vi.fn().mockResolvedValue({ id: "sb_1", status: "destroying" });
    const getBandwidth = vi.fn().mockResolvedValue({ used_bytes: 0 });
    const getSandbox = vi.fn().mockResolvedValue({ destroy, getBandwidth });
    const result = await teardownSandbox(config, "sb_1", {
      makeClient: () => ({
        getSandbox,
        createSandbox: vi.fn(),
        listShapes: vi.fn(),
        listSandboxes: vi.fn().mockResolvedValue([]),
      }),
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(getBandwidth).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("readEgress=true reads bandwidth before destroying and returns used_bytes", async () => {
    const destroy = vi.fn().mockResolvedValue({ id: "sb_2", status: "destroying" });
    const getBandwidth = vi.fn().mockResolvedValue({ used_bytes: 4242 });
    const getSandbox = vi.fn().mockResolvedValue({ destroy, getBandwidth });
    const result = await teardownSandbox(
      config,
      "sb_2",
      {
        makeClient: () => ({
          getSandbox,
          createSandbox: vi.fn(),
          listShapes: vi.fn(),
          listSandboxes: vi.fn().mockResolvedValue([]),
        }),
      },
      true,
    );
    expect(result).toBe(4242);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("readEgress=true still destroys and returns null when the bandwidth read rejects (best-effort)", async () => {
    const destroy = vi.fn().mockResolvedValue({ id: "sb_3", status: "destroying" });
    const getBandwidth = vi.fn().mockRejectedValue(new Error("bw down"));
    const getSandbox = vi.fn().mockResolvedValue({ destroy, getBandwidth });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await teardownSandbox(
      config,
      "sb_3",
      {
        makeClient: () => ({
          getSandbox,
          createSandbox: vi.fn(),
          listShapes: vi.fn(),
          listSandboxes: vi.fn().mockResolvedValue([]),
        }),
      },
      true,
    );
    expect(result).toBeNull();
    expect(destroy).toHaveBeenCalledOnce(); // never blocked by the failed read
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toEqual(
      expect.stringContaining("bandwidth read failed sandbox=sb_3"),
    );
    warn.mockRestore();
  });

  it("swallows NotFound (idempotent)", async () => {
    const getSandbox = vi
      .fn()
      .mockRejectedValue(
        new CreateosSandboxNotFoundError("gone", new Response(null, { status: 404 })),
      );
    await expect(
      teardownSandbox(config, "sb_x", {
        makeClient: () => ({
          getSandbox,
          createSandbox: vi.fn(),
          listShapes: vi.fn(),
          listSandboxes: vi.fn().mockResolvedValue([]),
        }),
      }),
    ).resolves.toBeNull();
  });

  it("rethrows other errors", async () => {
    const getSandbox = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      teardownSandbox(config, "sb_x", {
        makeClient: () => ({
          getSandbox,
          createSandbox: vi.fn(),
          listShapes: vi.fn(),
          listSandboxes: vi.fn().mockResolvedValue([]),
        }),
      }),
    ).rejects.toThrow(/boom/);
  });
});
