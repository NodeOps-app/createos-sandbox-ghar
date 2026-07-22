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
 * vCPU. An unparseable label falls back to the default's weight — billing runs
 * inside the teardown path and must never block it — but warns, because a
 * silent fallback would misprice quietly (no-silent-bounds rule). If the
 * default shape is itself unparseable (a typo'd RUNNER_SHAPE env var), that
 * fallback has nothing to fall back to either — it warns a second time and
 * bills at weight 1, so a bad env var misprices loudly instead of silently
 * forever.
 */
export function weightForLabel(label: string, runnerLabel: string, defaultShape: string): number {
  const src = label === runnerLabel ? defaultShape : label;
  const m = VCPU_RE.exec(src);
  if (m) return Number(m[1]) / 2;
  console.warn(`quota: cannot parse vcpu from "${label}"; billing at default "${defaultShape}"`);
  const d = VCPU_RE.exec(defaultShape);
  if (d) return Number(d[1]) / 2;
  console.warn(
    `quota: default shape "${defaultShape}" has no parseable vcpu either; billing "${label}" at weight 1`,
  );
  return 1;
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
