import { describe, it, expect } from "vitest";
import {
  CreateosSandboxAuthError,
  CreateosSandboxConnectionError,
  CreateosSandboxNotFoundError,
  CreateosSandboxPaymentRequiredError,
  CreateosSandboxPermissionError,
  CreateosSandboxRateLimitError,
  CreateosSandboxServerError,
  CreateosSandboxTimeoutError,
  CreateosSandboxValidationError,
} from "@nodeops-createos/sandbox";
import { isFailoverEligible, isPermanentProvisionFailure, regionByName } from "../../src/createos";
import type { Config } from "../../src/types";

const config = {
  createosRegions: [
    { name: "us", baseUrl: "https://api-us.sb.createos.sh" },
    { name: "eu", baseUrl: "https://api-eu.sb.createos.sh" },
  ],
} as Config;

describe("isFailoverEligible", () => {
  // The failover trigger set. Region-level faults (capacity exhaustion is a
  // bare 503, the region being unreachable, a boot that outlived the request
  // deadline) are worth retrying against the next control plane. A 4xx is a
  // defect in the request — it fails identically everywhere, so retrying one
  // is pure latency on an already-doomed job.
  it.each([
    [
      "server error (5xx — capacity exhausted)",
      new CreateosSandboxServerError("service unavailable", new Response(null, { status: 503 })),
    ],
    [
      "connection error (region unreachable)",
      new CreateosSandboxConnectionError("connect ECONNREFUSED"),
    ],
    ["timeout error (boot outlived the request)", new CreateosSandboxTimeoutError("deadline")],
  ])("eligible: %s", (_label, err) => {
    expect(isFailoverEligible(err)).toBe(true);
  });

  it.each([
    [
      "validation error (bad shape/name — fails everywhere)",
      new CreateosSandboxValidationError("unknown shape", new Response(null, { status: 400 })),
    ],
    [
      "not found (404 — a request defect on create)",
      new CreateosSandboxNotFoundError("gone", new Response(null, { status: 404 })),
    ],
    ["a non-SDK error", new Error("boom")],
    ["a thrown non-error", "boom"],
  ])("not eligible: %s", (_label, err) => {
    expect(isFailoverEligible(err)).toBe(false);
  });
});

describe("isPermanentProvisionFailure", () => {
  // Decides whether a VM-less provision failure is re-queued for another attempt
  // or dropped. Inverting this is quiet in both directions: too permissive and a
  // doomed job alerts once per attempt, too strict and a transient 5xx costs the
  // job a full recovery-scan rotation.
  it.each([
    [
      "unknown shape (422 — same request, same rejection)",
      new CreateosSandboxValidationError("unknown shape", new Response(null, { status: 422 })),
    ],
    [
      "rejected key (401)",
      new CreateosSandboxAuthError("invalid api key", new Response(null, { status: 401 })),
    ],
    [
      "quota/ACL refusal (403)",
      new CreateosSandboxPermissionError("forbidden", new Response(null, { status: 403 })),
    ],
    [
      "out of credit (402 — same error until topped up)",
      new CreateosSandboxPaymentRequiredError("no credit", new Response(null, { status: 402 })),
    ],
    [
      "missing resource (404)",
      new CreateosSandboxNotFoundError("gone", new Response(null, { status: 404 })),
    ],
  ])("permanent: %s", (_label, err) => {
    expect(isPermanentProvisionFailure(err)).toBe(true);
  });

  it.each([
    [
      "server error (5xx — the wave that strands jobs)",
      new CreateosSandboxServerError("internal error", new Response(null, { status: 500 })),
    ],
    [
      "rate limited (429 — the one 4xx that means 'later')",
      new CreateosSandboxRateLimitError("slow down", new Response(null, { status: 429 })),
    ],
    [
      "name conflict (409 — a leaked prior attempt, clears once the orphan sweep runs)",
      new CreateosSandboxValidationError("already exists", new Response(null, { status: 409 })),
    ],
    ["connection error", new CreateosSandboxConnectionError("connect ECONNREFUSED")],
    ["timeout", new CreateosSandboxTimeoutError("deadline")],
    ["a non-SDK error (GitHub mint failure, DO blip)", new Error("boom")],
    ["a thrown non-error", "boom"],
  ])("retryable: %s", (_label, err) => {
    expect(isPermanentProvisionFailure(err)).toBe(false);
  });
});

describe("regionByName", () => {
  it("resolves a named region", () => {
    expect(regionByName(config, "eu")).toEqual({
      name: "eu",
      baseUrl: "https://api-eu.sb.createos.sh",
    });
  });

  it("resolves null/undefined (a pre-region row) to the primary", () => {
    expect(regionByName(config, null).name).toBe("us");
    expect(regionByName(config, undefined).name).toBe("us");
  });

  it("throws on an unknown name rather than guessing", () => {
    // Guessing wrong here is how a live EU VM reads as 404 on the US control
    // plane and is marked destroyed — a silent leak. A throw keeps the row
    // `destroying` so the reaper retries and the operator is paged.
    expect(() => regionByName(config, "ap")).toThrow(/unknown createos region "ap"/);
  });
});
