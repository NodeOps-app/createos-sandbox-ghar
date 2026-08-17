import {
  CreateosSandboxApiError,
  CreateosSandboxClient,
  CreateosSandboxConnectionError,
  CreateosSandboxRateLimitError,
  CreateosSandboxServerError,
  CreateosSandboxTimeoutError,
} from "@nodeops-createos/sandbox";
import type {
  CreateSandboxOptions,
  CreateSandboxRequest,
  DestroyedResponse,
  ExecOptions,
  ExecResponse,
  ListSandboxesOptions,
  RequestOptions,
  Shape,
} from "@nodeops-createos/sandbox";
import type { Config, Region } from "./types";

/**
 * What createRunnerSandbox/launchRunner need from a just-created sandbox —
 * not the SDK's full `Sandbox` class, so a test double only needs these two.
 */
export interface SandboxHandle {
  readonly id: string;
  runCommand(cmd: string, args?: string[], options?: ExecOptions): Promise<ExecResponse>;
}

/** What teardownSandbox needs from a sandbox looked up by id. */
interface DestroyableSandbox {
  destroy(options?: RequestOptions): Promise<DestroyedResponse>;
  /** Best-effort egress read at teardown (cost gate: tenant-billed VMs only). */
  getBandwidth(): Promise<{ used_bytes: number }>;
}

/**
 * What the orphaned-sandbox sweep needs from a listed VM: enough to decide
 * whether it is ours and abandoned, and to destroy it if so.
 */
export interface ListedSandbox extends DestroyableSandbox {
  readonly id: string;
  readonly name?: string;
  readonly status: string;
}

/**
 * The subset of CreateosSandboxClient this codebase actually calls. Narrower
 * than the SDK's client on purpose: a test stub only needs these four
 * methods, not the SDK's full surface (templates/networks/disks/...).
 */
export interface CreateosClient {
  createSandbox(
    request: CreateSandboxRequest,
    options?: CreateSandboxOptions,
  ): Promise<SandboxHandle>;
  getSandbox(id: string, options?: RequestOptions): Promise<DestroyableSandbox>;
  listSandboxes(options?: ListSandboxesOptions): Promise<ListedSandbox[]>;
  listShapes(options?: RequestOptions): Promise<Shape[]>;
}

export interface SandboxDeps {
  /** Injection seam for tests. Defaults to a real client from config. Receives
   * the region being dialed so a stub can fail one region and serve another. */
  makeClient?: (config: Config, region?: Region) => CreateosClient;
  /** Injection seam for tests. 2-char token discriminating provision attempts. */
  attemptId?: () => string;
  /** Injection seam for tests. Defaults to a real timer — lets a test assert the
   * post-failover retry without spending its delay in wall-clock. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Whether a createSandbox failure is a REGION-level fault worth failing over to
 * the next control plane: the region is shedding load or unreachable (5xx —
 * capacity exhaustion surfaces as a bare 503 "service unavailable" — plus
 * connection/timeout). A 4xx is a defect in the request itself (bad shape, bad
 * name, oversized envs); it fails identically in every region, so retrying one
 * would only double the latency of a job already doomed.
 */
export function isFailoverEligible(err: unknown): boolean {
  return (
    err instanceof CreateosSandboxServerError ||
    err instanceof CreateosSandboxConnectionError ||
    err instanceof CreateosSandboxTimeoutError
  );
}

/**
 * Whether a provision failure is guaranteed to fail the same way if the job is
 * simply tried again later — which is what decides whether the Coordinator
 * re-queues the row (#requeueForRetry) or drops it.
 *
 * The same reasoning as isFailoverEligible, extended along the time axis instead
 * of the region axis: a CreateOS 4xx is a defect in the request or in account
 * state that no amount of waiting fixes — an unknown shape (400/422), a
 * rejected key (401), a quota or ACL refusal (403), a resource that does not
 * exist (404), an account out of credit (402, which the SDK documents as
 * returning the same error until topped up). Re-queueing those buys nothing and
 * costs a provision-failure alert per attempt.
 *
 * 429 and 409 are the two 4xx worth another go. 429 says "later", literally.
 * 409 on createSandbox means "a sandbox named `gha-ci-<jobId>` already exists"
 * — sandboxNameFor is deliberately per-job, not per-attempt (see sandbox.ts),
 * so this fires when an earlier attempt's VM booted server-side but the client
 * never saw the response and leaked it under this job's name. That is a
 * resource-state conflict, not a request defect: it resolves itself once the
 * orphaned-sandbox sweep (every cron tick) reclaims the leaked VM, which lands
 * inside this job's own retry window. Treating it as permanent instead drops
 * the row and leaves the slow O(installed-repos) reconciler scan as the only
 * way back — measured 654s-1417s to recover a job that a same-tick retry would
 * have fixed in one cron period.
 *
 * Everything that is not a CreateOS API error at all (a GitHub 5xx while
 * minting the JIT config, an unreachable DO, a `shapeForLabel` throw) is
 * treated as retryable: the transient members of that set are exactly the
 * failures a retry exists for, and the deterministic ones are bounded by
 * MAX_PROVISION_ATTEMPTS.
 */
export function isPermanentProvisionFailure(err: unknown): boolean {
  return (
    err instanceof CreateosSandboxApiError &&
    err.statusCode >= 400 &&
    err.statusCode < 500 &&
    !(err instanceof CreateosSandboxRateLimitError) &&
    err.statusCode !== 409
  );
}

/**
 * Resolves the region a row names to its control plane. NULL/absent = a
 * pre-region row → the primary. An UNKNOWN name throws rather than falling back:
 * the fallback's control plane has never heard of the VM, and its 404 would read
 * as "already destroyed" — silently leaking a live VM (see TeardownTask.region).
 * A throw leaves the row `destroying` so the reaper retries and the alert fires.
 */
/** The primary region — admission-time reads and pre-region rows target it. */
export function primaryRegion(config: Config): Region {
  return config.createosRegions[0]!;
}

export function regionByName(config: Config, name: string | null | undefined): Region {
  if (name == null) return primaryRegion(config);
  const region = config.createosRegions.find((r) => r.name === name);
  if (!region) {
    throw new Error(
      `unknown createos region ${JSON.stringify(name)} (configured: ` +
        `${config.createosRegions.map((r) => r.name).join(", ")}) — refusing to guess; ` +
        `the VM it names stays tracked for retry`,
    );
  }
  return region;
}

/**
 * The single place a createos SDK client is constructed. Lives apart from
 * sandbox.ts so shapes.ts can build a client without importing sandbox.ts,
 * which imports shapes.ts for shapeForLabel — a cycle otherwise.
 */
export function makeSandboxClient(
  config: Config,
  deps: SandboxDeps,
  region?: Region,
): CreateosClient {
  if (deps.makeClient) return deps.makeClient(config, region);
  // The real client structurally satisfies CreateosClient — no cast needed.
  return new CreateosSandboxClient({
    baseUrl: (region ?? primaryRegion(config)).baseUrl,
    apiKey: config.createosApiKey,
    // Workers rejects an unbound fetch called off the SDK's config object.
    fetch: globalThis.fetch.bind(globalThis),
  });
}
