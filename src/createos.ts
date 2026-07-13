import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import type {
  CreateSandboxOptions,
  CreateSandboxRequest,
  DestroyedResponse,
  ExecOptions,
  ExecResponse,
  RequestOptions,
  Shape,
} from "@nodeops-createos/sandbox";
import type { Config } from "./types";

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
}

/**
 * The subset of CreateosSandboxClient this codebase actually calls. Narrower
 * than the SDK's client on purpose: a test stub only needs these three
 * methods, not the SDK's full surface (templates/networks/disks/...).
 */
export interface CreateosClient {
  createSandbox(
    request: CreateSandboxRequest,
    options?: CreateSandboxOptions,
  ): Promise<SandboxHandle>;
  getSandbox(id: string, options?: RequestOptions): Promise<DestroyableSandbox>;
  listShapes(options?: RequestOptions): Promise<Shape[]>;
}

export interface SandboxDeps {
  /** Injection seam for tests. Defaults to a real client from config. */
  makeClient?: (config: Config) => CreateosClient;
  /** Injection seam for tests. 2-char token discriminating provision attempts. */
  attemptId?: () => string;
}

/**
 * The single place a createos SDK client is constructed. Lives apart from
 * sandbox.ts so shapes.ts can build a client without importing sandbox.ts,
 * which imports shapes.ts for shapeForLabel — a cycle otherwise.
 */
export function makeSandboxClient(config: Config, deps: SandboxDeps): CreateosClient {
  if (deps.makeClient) return deps.makeClient(config);
  // The real client structurally satisfies CreateosClient — no cast needed.
  return new CreateosSandboxClient({
    baseUrl: config.createosBaseUrl,
    apiKey: config.createosApiKey,
    // Workers rejects an unbound fetch called off the SDK's config object.
    fetch: globalThis.fetch.bind(globalThis),
  });
}
