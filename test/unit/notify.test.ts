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

  it("never throws when the webhook call fails", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    await expect(
      notify({ ...base, alertWebhookUrl: "https://hooks.example/x" }, "boom"),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
