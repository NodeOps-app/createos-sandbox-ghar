import type { Shape } from "@nodeops-createos/sandbox";
import type { Config } from "./types";
import { makeSandboxClient, type SandboxDeps } from "./createos";

const CACHE_TTL_MS = 300_000;

let cache: { fetchedAt: number; minRunnerMemMib: number; ids: Set<string> } | null = null;

/**
 * The one fetch-in-progress, if any. Concurrent callers that arrive before it
 * settles await this same promise instead of each issuing their own request —
 * without it, a burst of N concurrent callers against a cold cache makes N
 * `listShapes()` calls, not 1. Keyed on `minRunnerMemMib` like the settled
 * cache so a floor change is still a miss; a single slot (not a map) because
 * the catalog is one global thing, not a per-key resource.
 */
let inflight: { minRunnerMemMib: number; promise: Promise<Set<string>> } | null = null;

/** Test-only: drops the module-level cache so cases don't leak into each other. */
export function resetShapeCacheForTests(): void {
  cache = null;
  inflight = null;
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
 *
 * Concurrent callers that arrive before a cold-cache fetch resolves share the
 * one in-flight request (see `inflight`) instead of each issuing their own —
 * a GitHub Actions matrix burst delivers exactly that shape of traffic.
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

  if (inflight && inflight.minRunnerMemMib === config.minRunnerMemMib) {
    return inflight.promise;
  }

  const promise = (async () => {
    let shapes: Shape[];
    try {
      shapes = await makeSandboxClient(config, deps).listShapes();
    } catch (err) {
      // Warned exactly once per actual fetch attempt, here — this body runs
      // once no matter how many concurrent callers coalesce onto `promise`
      // below. Warning in `fetchCatalog` instead (the per-caller side of the
      // coalescing) would fire once per caller sharing the same rejection.
      console.warn(`shapes: catalog fetch failed, shaped labels denied: ${String(err)}`);
      throw err;
    }
    if (shapes.length === 0) {
      console.warn(
        "shapes: catalog fetch returned an empty list; every shaped label will be denied",
      );
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
  })();

  inflight = { minRunnerMemMib: config.minRunnerMemMib, promise };
  try {
    return await promise;
  } finally {
    // Only clear if we still own the slot — a differing-floor request that
    // raced in after us and replaced it must not have its own entry evicted.
    if (inflight?.promise === promise) inflight = null;
  }
}

/**
 * The shape catalog, or the fact that it couldn't be fetched. A distinct
 * `{ok: false}` rather than an empty `Set` — an outage and an authoritative
 * empty catalog are different situations and must not be conflated: the
 * former means "unknown, retry later", the latter means "no shape is usable
 * right now" (see the `usableShapes` empty-catalog warning above).
 */
export type Catalog = { ok: true; usable: Set<string> } | { ok: false };

/**
 * Fetches the live shape catalog for the admission check, converting a failed
 * fetch into `{ok: false}` rather than throwing — the caller (webhook
 * handler, reconciler) decides what an unavailable catalog means for the job
 * in front of it (202 + retry via the cron reconciler), not this function.
 *
 * Silent on failure: the cause is already warned exactly once, inside
 * `usableShapes`' coalesced fetch attempt (see there) — warning again here
 * would either duplicate that line, or (worse) fire once per caller sharing a
 * coalesced rejection, which is the bug this split fixed.
 */
export async function fetchCatalog(config: Config, deps: SandboxDeps): Promise<Catalog> {
  try {
    return { ok: true, usable: await usableShapes(config, deps) };
  } catch {
    return { ok: false };
  }
}
