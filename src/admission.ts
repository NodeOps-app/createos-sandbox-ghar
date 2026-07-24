import { shouldProvision } from "./policy";
import { shapeForLabel, type Catalog } from "./shapes";
import type { Config, PendingJob } from "./types";

export interface JobCandidate {
  jobId: number;
  runId: number;
  repoFullName: string;
  labels: string[];
}

export type IdentifiedJob =
  | { kind: "none" }
  | { kind: "ambiguous"; labels: string[] }
  | { kind: "identified"; job: PendingJob };

export type AdmissionDecision =
  | { kind: "admitted"; job: PendingJob }
  | { kind: "refused"; reason: "no-label" }
  | { kind: "refused"; reason: "ambiguous-label"; labels: string[] }
  | { kind: "refused"; reason: "policy-skip" }
  | { kind: "refused"; reason: "catalog-unavailable"; label: string }
  | { kind: "refused"; reason: "unknown-shape"; label: string; shape: string };

export interface AdmissionDeps {
  isForkJob(repoFullName: string, runId: number): Promise<boolean>;
  loadCatalog(): Promise<Catalog>;
}

/**
 * Identifies the ONE createos label a job asked for. `none` when it names no
 * createos label (someone else's job), `ambiguous` when it names more than one
 * (no defensible way to pick a winner — ADR-0004), else the single label as a
 * PendingJob. Pure: no policy, no network.
 */
export function identifyJob(candidate: JobCandidate, config: Config): IdentifiedJob {
  const shapedPrefix = `${config.runnerLabel}-`;
  const requested = candidate.labels.filter(
    (label) => label === config.runnerLabel || label.startsWith(shapedPrefix),
  );
  if (requested.length === 0) return { kind: "none" };
  if (requested.length > 1) return { kind: "ambiguous", labels: requested };
  return {
    kind: "identified",
    job: {
      jobId: candidate.jobId,
      runId: candidate.runId,
      repoFullName: candidate.repoFullName,
      label: requested[0]!,
      tenant: null, // Task 6 wires the real tenant onto the webhook intake path
    },
  };
}

/**
 * The one ordered admission rule, shared by webhook intake and the Reconciler:
 * identify exactly one label, apply policy BEFORE any catalog read, then (only
 * for a shaped label) validate the shape against a lazily-loaded catalog. Bare
 * `createos` never touches the catalog, so a shapes outage can't stop the jobs
 * that work today. One catalog promise is shared across every job this factory
 * admits, so a batch pays for at most one catalog fetch.
 */
export function createJobAdmission(
  config: Config,
  deps: AdmissionDeps,
): (candidate: JobCandidate) => Promise<AdmissionDecision> {
  let catalogPromise: Promise<Catalog> | undefined;
  const catalog = (): Promise<Catalog> => (catalogPromise ??= deps.loadCatalog());

  return async (candidate) => {
    const identified = identifyJob(candidate, config);
    if (identified.kind === "none") return { kind: "refused", reason: "no-label" };
    if (identified.kind === "ambiguous") {
      return { kind: "refused", reason: "ambiguous-label", labels: identified.labels };
    }

    const eligible = await shouldProvision(config, candidate, () =>
      deps.isForkJob(candidate.repoFullName, candidate.runId),
    );
    if (!eligible) return { kind: "refused", reason: "policy-skip" };

    const { job } = identified;
    if (job.label === config.runnerLabel) return { kind: "admitted", job };

    const loaded = await catalog();
    if (!loaded.ok) {
      return { kind: "refused", reason: "catalog-unavailable", label: job.label };
    }
    const shape = shapeForLabel(job.label, config);
    if (!loaded.usable.has(shape)) {
      return { kind: "refused", reason: "unknown-shape", label: job.label, shape };
    }
    return { kind: "admitted", job };
  };
}
