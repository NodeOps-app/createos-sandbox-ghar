/**
 * Weighted-minute quota math. Pure and import-free on purpose: the Coordinator
 * DO must bill VM lifetimes at teardown but is forbidden from importing
 * shapes.ts (it stays passive), so the label→weight parse lives here where
 * both Worker and DO can reach it.
 *
 * A weighted minute is one wall-clock minute of VM lifetime × (vCPU ÷ 2):
 * s-2vcpu-2gb burns 1×, s-4vcpu-8gb burns 2×, s-8vcpu-16gb burns 4×. Memory is
 * deliberately not a factor — vCPU tracks cost closely enough, and one axis
 * keeps the operator-facing unit an honest "minute" (spec D8).
 */

/** The UTC calendar-month bucket a timestamp falls in: "2026-07". The month is
 * part of the usage primary key, so a new month is a new row — no reset job. */
export function monthKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const VCPU_RE = /(\d+)vcpu/;

/**
 * The billing weight of the shape a runner label names. The bare label bills
 * at the default shape; a shaped label ("createos-4vcpu-8gb") bills by its own
 * vCPU. Either way, the string actually parsed is `src` — the label itself
 * with the shaped-label prefix stripped, or defaultShape when the label is
 * bare. The prefix must be stripped before parsing, not just checked for
 * bareness: shapes.ts maps a shaped label by slicing off `runnerLabel + "-"`
 * first, and `runnerLabel` is an unrestricted env value that can itself
 * contain a vCPU-like token (e.g. "ci-16vcpu") — VCPU_RE is unanchored and
 * returns the first match, so parsing the whole label would read the prefix's
 * count instead of the shape's. Quota can't import shapeForLabel to share
 * this (the DO importing quota.ts must stay import-free), so the substring
 * rule is duplicated here — that duplication is the price of the import ban.
 * When `src` has no parseable vcpu, weightForLabel falls back to the default
 * shape's weight instead — billing runs inside the teardown path and must
 * never block it — but warns, because a silent fallback would misprice
 * quietly (no-silent-bounds rule); the warning only claims that outcome once
 * the default is confirmed to parse. If the default shape is itself
 * unparseable (a typo'd RUNNER_SHAPE env var), that fallback has nothing to
 * fall back to either — it warns a second time and bills at weight 1, so a
 * bad env var misprices loudly instead of silently forever.
 */
export function weightForLabel(label: string, runnerLabel: string, defaultShape: string): number {
  const src =
    label === runnerLabel
      ? defaultShape
      : label.startsWith(`${runnerLabel}-`)
        ? label.slice(runnerLabel.length + 1)
        : label;
  const m = VCPU_RE.exec(src);
  if (m) return Number(m[1]) / 2;
  const d = VCPU_RE.exec(defaultShape);
  if (!d) {
    console.warn(
      `quota: cannot parse vcpu from "${src}"; default shape "${defaultShape}" has no parseable vcpu either`,
    );
    console.warn(`quota: billing "${label}" at weight 1`);
    return 1;
  }
  console.warn(`quota: cannot parse vcpu from "${src}"; billing at default "${defaultShape}"`);
  return Number(d[1]) / 2;
}

/** Weighted minutes one VM lifetime burned. Negative lifetimes clamp to 0. */
export function weightedMinutes(
  label: string,
  runnerLabel: string,
  defaultShape: string,
  lifetimeMs: number,
): number {
  return (Math.max(0, lifetimeMs) / 60_000) * weightForLabel(label, runnerLabel, defaultShape);
}
