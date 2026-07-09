import { describe, it, expect } from "vitest";
import { verifySignature, parseWorkflowJob } from "../../src/webhook";
import { sign, workflowJobPayload } from "../helpers/fixtures";

describe("verifySignature", () => {
  it("accepts a valid signature", async () => {
    const body = workflowJobPayload({});
    const header = await sign("secret", body);
    expect(await verifySignature("secret", body, header)).toBe(true);
  });
  it("rejects a tampered body", async () => {
    const header = await sign("secret", workflowJobPayload({}));
    expect(await verifySignature("secret", workflowJobPayload({ jobId: 999 }), header)).toBe(false);
  });
  it("rejects wrong secret", async () => {
    const body = workflowJobPayload({});
    const header = await sign("secret", body);
    expect(await verifySignature("other", body, header)).toBe(false);
  });
  it("rejects missing/malformed header", async () => {
    expect(await verifySignature("s", "b", null)).toBe(false);
    expect(await verifySignature("s", "b", "md5=abc")).toBe(false);
    expect(await verifySignature("s", "b", "sha256=zz")).toBe(false);
  });
});

describe("parseWorkflowJob", () => {
  it("parses a queued job", () => {
    const job = parseWorkflowJob(workflowJobPayload({ action: "queued", jobId: 7, runId: 9 }));
    expect(job).toEqual({
      action: "queued",
      jobId: 7,
      runId: 9,
      repoFullName: "nodeops-app/api",
      labels: ["createos"],
      runnerName: undefined,
    });
  });
  it("carries runner_name from a completed job", () => {
    const job = parseWorkflowJob(
      workflowJobPayload({ action: "completed", jobId: 7, runnerName: "ghar-7" }),
    );
    expect(job?.runnerName).toBe("ghar-7");
  });
  it("returns null for non-workflow_job / bad json", () => {
    expect(parseWorkflowJob("{}")).toBeNull();
    expect(parseWorkflowJob("not json")).toBeNull();
    expect(parseWorkflowJob(JSON.stringify({ action: "opened", pull_request: {} }))).toBeNull();
  });
  it("returns null on malformed ids / repo (the trust boundary validates types)", () => {
    const bad = (wj: unknown, repository: unknown = { full_name: "nodeops-app/api" }) =>
      JSON.stringify({ action: "queued", workflow_job: wj, repository });
    expect(parseWorkflowJob(bad({ id: "7", run_id: 9 }))).toBeNull(); // id not a number
    expect(parseWorkflowJob(bad({ id: 7, run_id: "9" }))).toBeNull(); // run_id not a number
    expect(parseWorkflowJob(bad({ id: 0, run_id: 9 }))).toBeNull(); // id not positive
    expect(parseWorkflowJob(bad({ id: 7, run_id: 9 }, { full_name: "" }))).toBeNull(); // empty repo
    expect(parseWorkflowJob(bad({ id: 7, run_id: 9 }, {}))).toBeNull(); // missing full_name
    expect(parseWorkflowJob(bad("nope"))).toBeNull(); // workflow_job not an object
  });
  it("drops non-string labels", () => {
    const job = parseWorkflowJob(
      JSON.stringify({
        action: "queued",
        workflow_job: { id: 7, run_id: 9, labels: ["createos", 5, null] },
        repository: { full_name: "nodeops-app/api" },
      }),
    );
    expect(job?.labels).toEqual(["createos"]);
  });
});
