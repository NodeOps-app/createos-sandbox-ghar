import { describe, it, expect, vi } from "vitest";
import { monthKey, weightForLabel, weightedMinutes } from "../../src/quota";

const BARE = "createos";
const DEF = "s-4vcpu-4gb";

describe("monthKey", () => {
  it("formats the UTC year-month zero-padded", () => {
    expect(monthKey(Date.UTC(2026, 6, 22, 12, 0, 0))).toBe("2026-07");
  });

  it("rolls at the UTC month boundary, not local time", () => {
    expect(monthKey(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe("2026-12");
    expect(monthKey(Date.UTC(2027, 0, 1, 0, 0, 0))).toBe("2027-01");
  });
});

describe("weightForLabel", () => {
  it("bills the bare label at the default shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(weightForLabel(BARE, BARE, DEF)).toBe(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("bills shaped labels by their own vCPU", () => {
    expect(weightForLabel("createos-2vcpu-2gb", BARE, DEF)).toBe(1);
    expect(weightForLabel("createos-4vcpu-8gb", BARE, DEF)).toBe(2);
    expect(weightForLabel("createos-8vcpu-16gb", BARE, DEF)).toBe(4);
  });

  it("bills fractional-vCPU shapes correctly, not as a decimal-fragment overbill", () => {
    // Regression for VCPU_RE matching "5vcpu" inside "0.5vcpu": that read the
    // count as 5 (weight 2.5) instead of 0.5 (weight 0.25) — a 10x overbill.
    expect(weightForLabel("createos-0.5vcpu-1gb", BARE, DEF)).toBe(0.25);
    expect(weightForLabel("createos-0.25vcpu-512mb", BARE, DEF)).toBe(0.125);
  });

  it("bills a fractional-vCPU default shape correctly via the bare-label path", () => {
    expect(weightForLabel(BARE, BARE, "s-0.5vcpu-1gb")).toBe(0.25);
    expect(weightForLabel(BARE, BARE, "s-0.25vcpu-512mb")).toBe(0.125);
  });

  it("bills by the shape's vCPU, not a vCPU-like token in the runner-label prefix", () => {
    expect(weightForLabel("ci-16vcpu-2vcpu-2gb", "ci-16vcpu", DEF)).toBe(1);
  });

  it("still parses a label that does not carry the runner-label prefix", () => {
    // runnerLabel deliberately overlaps the label's own prefix ("createos-2")
    // so an unguarded `label.slice(runnerLabel.length + 1)` would slice into
    // the middle of "2vcpu" and destroy the token — this input only passes
    // if the startsWith guard actually gated the slice.
    expect(weightForLabel("createos-2vcpu-2gb", "createos-2", DEF)).toBe(1);
  });

  it("best-effort parses a stale-prefix label matching neither the bare label nor the current prefix", () => {
    // Simulates a RUNNER_LABEL rename mid-flight (see AGENTS.md): a persisted
    // jobs.label ("gha-2vcpu-2gb") carries the *old* prefix, which matches
    // neither the new bare label nor the new prefix. shapeForLabel throws on
    // this input; quota must not — teardown falls through to a best-effort
    // parse of the raw label instead of blocking.
    expect(weightForLabel("gha-2vcpu-2gb", "createos", DEF)).toBe(1);
  });

  it("falls back to the default weight on an unparseable label, loudly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(weightForLabel("createos-huge", BARE, DEF)).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0]![0];
    expect(message).toEqual(expect.stringContaining("huge"));
    expect(message).toEqual(expect.stringContaining(DEF));
    // The stripped fragment ("huge") is a substring of the full label
    // ("createos-huge"), so pin the full, prefixed label explicitly — this
    // is what's persisted in jobs.label and what every other log line names.
    expect(message).toEqual(expect.stringContaining("createos-huge"));
    warn.mockRestore();
  });

  it("falls back to weight 1 when the default shape is also unparseable, loudly twice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(weightForLabel("createos-huge", BARE, "not-a-shape")).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    const first = warn.mock.calls[0]![0];
    expect(first).toEqual(expect.stringContaining("huge"));
    expect(first).toEqual(expect.stringContaining("not-a-shape"));
    expect(first).toEqual(expect.stringContaining("createos-huge"));
    expect(first).not.toEqual(expect.stringContaining("billing at default"));
    const second = warn.mock.calls[1]![0];
    expect(second).toEqual(expect.stringContaining("createos-huge"));
    warn.mockRestore();
  });

  it("names the bare label (not the resolved default shape) in the second warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(weightForLabel(BARE, BARE, "not-a-shape")).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    const second = warn.mock.calls[1]![0];
    expect(second).toEqual(expect.stringContaining(BARE));
    expect(second).not.toEqual(expect.stringContaining("not-a-shape"));
    warn.mockRestore();
  });
});

describe("weightedMinutes", () => {
  it("scales wall minutes by the shape weight", () => {
    expect(weightedMinutes("createos-2vcpu-2gb", BARE, DEF, 30 * 60_000)).toBe(30);
    expect(weightedMinutes(BARE, BARE, DEF, 30 * 60_000)).toBe(60);
  });

  it("clamps a negative lifetime to zero", () => {
    expect(weightedMinutes(BARE, BARE, DEF, -5)).toBe(0);
  });
});
