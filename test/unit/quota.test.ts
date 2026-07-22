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
    expect(weightForLabel(BARE, BARE, DEF)).toBe(2);
  });

  it("bills shaped labels by their own vCPU", () => {
    expect(weightForLabel("createos-2vcpu-2gb", BARE, DEF)).toBe(1);
    expect(weightForLabel("createos-4vcpu-8gb", BARE, DEF)).toBe(2);
    expect(weightForLabel("createos-8vcpu-16gb", BARE, DEF)).toBe(4);
  });

  it("falls back to the default weight on an unparseable label, loudly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(weightForLabel("createos-huge", BARE, DEF)).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0]![0];
    expect(message).toEqual(expect.stringContaining("createos-huge"));
    expect(message).toEqual(expect.stringContaining(DEF));
    warn.mockRestore();
  });

  it("falls back to weight 1 when the default shape is also unparseable, loudly twice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(weightForLabel("createos-huge", BARE, "not-a-shape")).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
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
