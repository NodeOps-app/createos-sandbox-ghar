import { describe, it, expect, vi } from "vitest";
import { notify, jobRef, alertContext } from "../../src/notify";
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

describe("jobRef", () => {
  const ref = jobRef("NodeOps-app/createos-studio", 31174368241, 92852985334);

  it("links the exact URL GitHub itself reports as the job's html_url", () => {
    // Verified against `gh api .../actions/jobs/92852985334` on 2026-08-07: the
    // API's own html_url is byte-identical to this. If GitHub ever changes the
    // permalink shape, this is the test that catches a channel full of 404s.
    expect(ref).toContain(
      "<https://github.com/NodeOps-app/createos-studio/actions/runs/31174368241/job/92852985334|",
    );
  });

  it("spells the ids out so they survive a sink that does not render mrkdwn", () => {
    expect(ref).toContain("org=NodeOps-app repo=createos-studio run=31174368241 job=92852985334");
  });

  it("does not break on a repo name without a slash", () => {
    // repoFullName is webhook-supplied; a malformed one must still produce a
    // readable alert rather than "org=undefined".
    expect(jobRef("weird", 1, 2)).toContain("org=weird repo= run=1 job=2");
  });
});

describe("alertContext", () => {
  it("renders the fields an operator needs, as one copy-pasteable line", () => {
    expect(alertContext({ region: "eu", sandbox: "sb_1", outcome: "will retry" })).toBe(
      "\nregion=eu sandbox=sb_1 outcome=will retry",
    );
  });

  // A pre-VM failure has no sandbox id and a single-mode row has no tenant.
  // Rendering `sandbox=` empty would read as "we lost the id" rather than
  // "there was never one".
  it("drops absent fields instead of rendering them empty", () => {
    expect(alertContext({ region: "us", sandbox: undefined, tenant: null, label: "" })).toBe(
      "\nregion=us",
    );
  });

  // Attempt 0 is a real, meaningful value — a `pending` row that has never been
  // tried. Only null/undefined/"" mean "absent".
  it("keeps zero and false, which are values, not absences", () => {
    expect(alertContext({ attempt: 0, retryable: false })).toBe("\nattempt=0 retryable=false");
  });

  it("returns an empty string when nothing is known, so callers can concatenate blindly", () => {
    expect(alertContext({ region: null })).toBe("");
  });
});
