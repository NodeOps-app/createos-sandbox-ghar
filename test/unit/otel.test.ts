import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config";
import {
  OTEL_TOKEN_HEADER,
  OTEL_TOKEN_TTL_S,
  forwardWorkflowEvent,
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

  it("fails open: a mint error yields no env instead of a failed provision", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new Error("boom"));
    expect(await otelRunnerEnvs(otel, 7, "cos-abc-1x", NOW)).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("booting without telemetry"));
    spy.mockRestore();
    warn.mockRestore();
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

  it("enables forwarding only when both the URL and its secret are set", () => {
    const on = {
      ...base,
      OTEL_ENDPOINT: "https://c.example",
      OTEL_TOKEN_KEY: KEY,
      OTEL_INSTALLATION_IDS: "7",
    };
    expect(loadConfig(on).otel?.webhook).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig({ ...on, OTEL_WEBHOOK_SECRET: "w" }).otel?.webhook).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("OTEL forwarding disabled"));
    warn.mockRestore();
    expect(
      loadConfig({ ...on, OTEL_WEBHOOK_URL: "https://c.example/events", OTEL_WEBHOOK_SECRET: "w" })
        .otel?.webhook,
    ).toEqual({ url: "https://c.example/events", secret: "w" });
  });

  it("is off, silently, without the key — the kill switch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadConfig({
      ...base,
      OTEL_ENDPOINT: "https://c.example",
      OTEL_INSTALLATION_IDS: "7",
    });
    expect(cfg.otel).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns and stays off when the key is set but the rest is not", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig({ ...base, OTEL_TOKEN_KEY: KEY }).otel).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("OTEL beta disabled"));
    warn.mockRestore();
  });
});

const body = (o: object) => JSON.stringify({ installation: { id: 7 }, ...o });

const stub = (impl: () => Promise<Response>) => {
  const f = vi.fn(impl);
  globalThis.fetch = f as unknown as typeof fetch;
  return f;
};

describe("forwardWorkflowEvent", () => {
  const sink = { url: "https://collector.example/events", secret: "s".repeat(16) };
  const cfg = { ...otel, webhook: sink };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  it("sends a completed job of an allowlisted tenant, signed with the collector's secret", async () => {
    const f = stub(async () => new Response("ok"));
    const b = body({ action: "completed" });
    await forwardWorkflowEvent(cfg, "workflow_job", b);
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(url).toBe(sink.url);
    expect(h["X-GitHub-Event"]).toBe("workflow_job");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(sink.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const want = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(b));
    const hex = [...new Uint8Array(want)].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(h["X-Hub-Signature-256"]).toBe(`sha256=${hex}`);
  });

  it.each([
    ["another tenant", "workflow_job", { action: "completed", installation: { id: 8 } }],
    ["a queued job", "workflow_job", { action: "queued" }],
    ["an unrelated event", "push", { action: "completed" }],
  ])("sends nothing for %s", async (_l, event, payload) => {
    const f = stub(async () => new Response("ok"));
    await forwardWorkflowEvent(cfg, event, body(payload));
    expect(f).not.toHaveBeenCalled();
  });

  it("sends nothing when forwarding is not configured", async () => {
    const f = stub(async () => new Response("ok"));
    await forwardWorkflowEvent(otel, "workflow_job", body({ action: "completed" }));
    await forwardWorkflowEvent(undefined, "workflow_job", body({ action: "completed" }));
    expect(f).not.toHaveBeenCalled();
  });

  it("never throws: a dead collector, a 500, or a garbage body are all swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stub(async () => Promise.reject(new Error("down")));
    await expect(
      forwardWorkflowEvent(cfg, "workflow_job", body({ action: "completed" })),
    ).resolves.toBeUndefined();
    stub(async () => new Response("no", { status: 500 }));
    await expect(
      forwardWorkflowEvent(cfg, "workflow_job", body({ action: "completed" })),
    ).resolves.toBeUndefined();
    await expect(forwardWorkflowEvent(cfg, "workflow_job", "not json")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
