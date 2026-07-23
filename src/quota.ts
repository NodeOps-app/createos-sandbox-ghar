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

// Requires the decimal point immediately after the leading digits, so the
// match anchors at the *start* of a fractional count instead of a suffix of
// one: real createos shapes include fractional vCPU counts (s-0.5vcpu-1gb,
// s-0.25vcpu-512mb — see docs/superpowers/specs/2026-07-09-shape-labels-design.md),
// and an unanchored /(\d+)vcpu/ matches "5vcpu" inside "0.5vcpu" — reading a
// count 10x too high instead of failing to match. `(?:\.\d+)?` only extends a
// match that already started at the first digit, so it can't itself start
// mid-number the way the old bare `\d+` did.
// Match the LAST vcpu token: the shape suffix is always last, so a stale label
// carrying an old prefix ("ci-16vcpu-2vcpu-2gb" after a RUNNER_LABEL rename)
// bills its shape, not its prefix. Belt-and-braces under the Plan 2 fix that
// bills from a shape persisted at provision time.
const VCPU_RE = /(\d+(?:\.\d+)?)vcpu(?!.*vcpu)/;

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
 *
 * There is a third outcome besides bare and correctly-prefixed: a label that
 * carries *neither* the bare label nor the current `runnerLabel` prefix. This
 * is reachable in production, not just defensive — AGENTS.md documents that
 * renaming RUNNER_LABEL while jobs are in flight leaves rows whose persisted
 * `jobs.label` still carries the *old* prefix, which matches neither check
 * against the new config. `shapeForLabel` in shapes.ts throws on this same
 * input, because a wrong-size VM is worse than no VM — but billing runs in
 * the teardown path for a VM that already exists and must never block that
 * teardown, so quota instead falls through to a best-effort parse of the raw
 * label (`src = label`), warning if that also fails to parse. Deliberate
 * asymmetry: provisioning refuses to guess, teardown cannot afford to.
 *
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
        : label; // stale-rename fallthrough (see doc comment above) — best-effort parse of the raw label
  const m = VCPU_RE.exec(src);
  if (m) return Number(m[1]) / 2;
  const d = VCPU_RE.exec(defaultShape);
  if (!d) {
    console.warn(
      `quota: cannot parse vcpu from "${src}" (label "${label}"); default shape "${defaultShape}" has no parseable vcpu either`,
    );
    console.warn(`quota: billing "${label}" at weight 1`);
    return 1;
  }
  console.warn(
    `quota: cannot parse vcpu from "${src}" (label "${label}"); billing at default "${defaultShape}"`,
  );
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
