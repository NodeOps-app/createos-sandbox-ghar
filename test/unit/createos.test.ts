import { describe, it, expect } from "vitest";
import {
  CreateosSandboxConnectionError,
  CreateosSandboxNotFoundError,
  CreateosSandboxServerError,
  CreateosSandboxTimeoutError,
  CreateosSandboxValidationError,
} from "@nodeops-createos/sandbox";
import { isFailoverEligible, regionByName } from "../../src/createos";
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
