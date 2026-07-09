import type { Shape } from "@nodeops-createos/sandbox";
import type { Config } from "./types";
import { makeSandboxClient, type SandboxDeps } from "./createos";

const CACHE_TTL_MS = 300_000;

let cache: { fetchedAt: number; minRunnerMemMib: number; ids: Set<string> } | null = null;

/** Test-only: drops the module-level cache so cases don't leak into each other. */
export function resetShapeCacheForTests(): void {
  cache = null;
}

/**
 * The createos labels in a job's `runs-on`: the bare label plus anything
 * prefixed with it. GitHub AND-matches `runs-on` against a runner's label set,
 * so a job's other labels (`self-hosted`, `linux`, `x64`) are carried
 * implicitly by any JIT runner and are irrelevant to shape selection.
 */
export function createosLabels(labels: string[], config: Config): string[] {
  const prefix = `${config.runnerLabel}-`;
  return labels.filter((l) => l === config.runnerLabel || l.startsWith(prefix));
}

/**
 * The createos shape a label names. The bare label means whatever the operator
 * configured; a shaped label carries the id in its suffix. Pure — needs no
 * catalog, so teardown and re-provision never depend on the shapes API.
 *
 * Enforces the prefix invariant explicitly rather than inferring "shaped" from
 * "not equal to the bare label": a persisted `jobs.label` row is validated
 * against a *current* `config.runnerLabel`, and those can disagree if an
 * operator changes RUNNER_LABEL while jobs are in flight. Without this check,
 * a stale bare label (e.g. old label "createos" vs new config "gha") falls
 * into the shaped branch and slices garbage out of it. A label that is
 * neither the bare label nor validly prefixed is corrupt/stale input, not a
 * shape to guess at — throw rather than boot a wrong-size VM.
 */
export function shapeForLabel(label: string, config: Config): string {
  if (label === config.runnerLabel) return config.runnerShape;
  const prefix = `${config.runnerLabel}-`;
  if (!label.startsWith(prefix)) {
    console.warn(
      `shapes: label "${label}" is neither "${config.runnerLabel}" nor prefixed with "${prefix}" — stale/corrupt label`,
    );
    throw new Error(
      `shapeForLabel: label "${label}" does not match runner label "${config.runnerLabel}" or its prefix`,
    );
  }
  return `s-${label.slice(prefix.length)}`;
}

/**
 * Shape ids from the live createos catalog that can actually host an Actions
 * runner. Cached for CACHE_TTL_MS per isolate: a shape added to the API is
 * offered as a label on the next miss, with no redeploy.
 *
 * The floor is not a per-shape allowlist — it is two properties. A shape under
 * MIN_RUNNER_MEM_MIB cannot check out and build. A shape with `cpu_quota_pct`
 * is a throttled fraction of one CPU, not a vCPU, and a runner on it stalls.
 *
 * Blocking network I/O, so this belongs to the Worker; the DO must stay passive
 * to hibernate (ADR-0002).
 *
 * The cache entry also pins the floor (`minRunnerMemMib`) it was computed
 * under: a changed floor is treated as a miss, so an isolate that survives a
 * mid-rollout config change can't serve an admission decision computed under
 * the old floor for up to CACHE_TTL_MS.
 */
export async function usableShapes(
  config: Config,
  deps: SandboxDeps,
  nowMs: number = Date.now(),
): Promise<Set<string>> {
  if (
    cache &&
    nowMs - cache.fetchedAt < CACHE_TTL_MS &&
    cache.minRunnerMemMib === config.minRunnerMemMib
  ) {
    return cache.ids;
  }

  const shapes: Shape[] = await makeSandboxClient(config, deps).listShapes();
  if (shapes.length === 0) {
    console.warn("shapes: catalog fetch returned an empty list; every shaped label will be denied");
  }
  const ids = new Set<string>();
  const excluded: string[] = [];
  for (const s of shapes) {
    if (s.mem_mib >= config.minRunnerMemMib && s.cpu_quota_pct == null) ids.add(s.id);
    else excluded.push(s.id);
  }
  if (excluded.length > 0) {
    console.warn(
      `shapes: ${excluded.length}/${shapes.length} below the runner floor ` +
        `(mem_mib < ${config.minRunnerMemMib} or cpu_quota_pct set), not offered as labels: ${excluded.join(", ")}`,
    );
  }
  cache = { fetchedAt: nowMs, minRunnerMemMib: config.minRunnerMemMib, ids };
  return ids;
}

/**
 * Admission check for one createos label. The bare label short-circuits: its
 * shape comes from config, so a shapes-API outage can never stop the jobs that
 * work today. A shaped label is checked against the live catalog; a fetch
 * failure denies it, and the cron reconciler re-drives the still-`queued` job
 * on its next tick.
 */
export async function isUsableLabel(
  label: string,
  config: Config,
  deps: SandboxDeps,
): Promise<boolean> {
  if (label === config.runnerLabel) return true;
  let usable: Set<string>;
  try {
    usable = await usableShapes(config, deps);
  } catch (err) {
    console.warn(`shapes: catalog fetch failed, denying shaped label ${label}: ${String(err)}`);
    return false;
  }
  return usableLabel(label, usable, config);
}

function usableLabel(label: string, usable: Set<string>, config: Config): boolean {
  const shape = shapeForLabel(label, config);
  if (usable.has(shape)) return true;
  console.warn(`shapes: label ${label} names shape ${shape}, which is not offered`);
  return false;
}

/**
 * The one createos label a job requested, validated against an already-fetched
 * catalog. Used where the catalog is fetched once for many jobs (the
 * reconciler). Returns null when the job is not ours, or when it names more
 * than one createos label — a contradiction with no defensible winner, which we
 * refuse rather than resolve by array order.
 */
export function pickLabel(labels: string[], usable: Set<string>, config: Config): string | null {
  const ours = createosLabels(labels, config);
  if (ours.length === 0) return null;
  if (ours.length > 1) {
    console.warn(
      `shapes: job names ${ours.length} createos labels (${ours.join(", ")}); ignoring it`,
    );
    return null;
  }
  const label = ours[0]!;
  if (label === config.runnerLabel) return label;
  return usableLabel(label, usable, config) ? label : null;
}
