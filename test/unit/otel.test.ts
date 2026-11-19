import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config";
import {
  OTEL_TOKEN_HEADER,
  OTEL_TOKEN_TTL_S,
  mintOtelToken,
  otelRunnerEnvs,
  verifyOtelToken,
} from "../../src/otel";

const KEY = "k".repeat(32);
const NOW = 1_800_000_000_000;
const otel = { endpoint: "https://collector.example", tokenKey: KEY, installationIds: [7] };

describe("otel token", () => {
  it("round-trips and names the runner", async () => {
    const t = await mintOtelToken(KEY, "cos-abc-1x", NOW);
    expect(await verifyOtelToken(KEY, t, NOW + 1000)).toEqual({
      ok: true,
      runnerName: "cos-abc-1x",
    });
  });

  it("is rejected after expiry, under another key, or when edited", async () => {
    const t = await mintOtelToken(KEY, "cos-abc-1x", NOW);
    expect(await verifyOtelToken(KEY, t, NOW + (OTEL_TOKEN_TTL_S + 1) * 1000)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await verifyOtelToken("z".repeat(32), t, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    const forged = t.replace("cos-abc-1x", "cos-other-1x");
    expect(await verifyOtelToken(KEY, forged, NOW)).toEqual({ ok: false, reason: "bad-signature" });
    expect(await verifyOtelToken(KEY, "junk", NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("gives every run its own token", async () => {
    const a = await mintOtelToken(KEY, "cos-1-aa", NOW);
    const b = await mintOtelToken(KEY, "cos-1-ab", NOW);
    expect(a).not.toBe(b);
  });
});

describe("otelRunnerEnvs", () => {
  it("injects the endpoint and a verifiable token only for an allowlisted tenant", async () => {
    const env = await otelRunnerEnvs(otel, 7, "cos-abc-1x", NOW);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://collector.example");
    const token = env.OTEL_EXPORTER_OTLP_HEADERS!.replace(`${OTEL_TOKEN_HEADER}=`, "");
    expect((await verifyOtelToken(KEY, token, NOW)).ok).toBe(true);
  });

  it("injects nothing for other tenants, no tenant, or an unset beta", async () => {
    expect(await otelRunnerEnvs(otel, 8, "cos-abc-1x", NOW)).toEqual({});
    expect(await otelRunnerEnvs(otel, undefined, "cos-abc-1x", NOW)).toEqual({});
    expect(await otelRunnerEnvs(undefined, 7, "cos-abc-1x", NOW)).toEqual({});
  });
});

describe("loadConfig otel", () => {
  const base = {
    GITHUB_ORG: "o",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    GITHUB_INSTALLATION_ID: "2",
    GITHUB_WEBHOOK_SECRET: "s",
    CREATEOS_BASE_URL: "https://api.sb.createos.sh",
    CREATEOS_API_KEY: "k",
    RUNNER_TEMPLATE: "t",
  };

  it("is on only when endpoint, key and ids are all set", () => {
    const on = loadConfig({
      ...base,
      OTEL_ENDPOINT: "https://c.example/",
      OTEL_TOKEN_KEY: KEY,
      OTEL_INSTALLATION_IDS: "7, 9",
    });
    expect(on.otel).toEqual({
      endpoint: "https://c.example",
      tokenKey: KEY,
      installationIds: [7, 9],
    });
    expect(loadConfig(base).otel).toBeUndefined();
  });

  it("warns and stays off when only part of it is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig({ ...base, OTEL_ENDPOINT: "https://c.example" }).otel).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("OTEL beta disabled"));
    warn.mockRestore();
  });
});
