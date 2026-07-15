import { describe, it, expect, vi } from "vitest";
import { notify } from "../../src/notify";
import type { Config } from "../../src/types";

const base = { alertWebhookUrl: undefined } as unknown as Config;

describe("notify", () => {
  it("no-ops when no webhook is configured", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await notify(base, "hi");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("posts a Slack-style payload when configured", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await notify({ ...base, alertWebhookUrl: "https://hooks.example/x" }, "boom");
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://hooks.example/x");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: "boom" });
    spy.mockRestore();
  });

  it("logs, and does not throw, when the webhook returns non-2xx", async () => {
    // A dead/rotated Slack URL 404s: fetch resolves, so an unchecked response
    // reports the alert as delivered. It must be logged instead of swallowed.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("nope", { status: 404 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      notify({ ...base, alertWebhookUrl: "https://hooks.example/x" }, "boom"),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0]![0]).toMatch(/404 — alert not delivered/);
    fetchSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("does not log on a delivered 2xx", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await notify({ ...base, alertWebhookUrl: "https://hooks.example/x" }, "boom");
    expect(errSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("never throws when the webhook call fails, and logs the loss", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      notify({ ...base, alertWebhookUrl: "https://hooks.example/x" }, "boom"),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0]![0]).toMatch(/request failed.*alert not delivered/);
    fetchSpy.mockRestore();
    errSpy.mockRestore();
  });
});
