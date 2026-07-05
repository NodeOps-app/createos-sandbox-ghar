import { describe, it, expect } from "vitest";
import { verifySignature, parseWorkflowJob, matchesLabel } from "../../src/webhook";
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
    });
  });
  it("returns null for non-workflow_job / bad json", () => {
    expect(parseWorkflowJob("{}")).toBeNull();
    expect(parseWorkflowJob("not json")).toBeNull();
    expect(parseWorkflowJob(JSON.stringify({ action: "opened", pull_request: {} }))).toBeNull();
  });
});

describe("matchesLabel", () => {
  it("matches when label present", () => {
    const job = parseWorkflowJob(workflowJobPayload({ labels: ["createos", "self-hosted"] }))!;
    expect(matchesLabel(job, "createos")).toBe(true);
    expect(matchesLabel(job, "gpu")).toBe(false);
  });
});
