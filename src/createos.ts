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
 * than the SDK's client on purpose: `SandboxDeps<C>` lets each call site
 * require only the capability it uses (e.g. shapes.ts only ever calls
 * `listShapes`), so a test stub missing a method that path DOES call is a
 * compile error instead of a runtime "x is not a function".
 */
export interface CreateosClient {
  createSandbox(
    request: CreateSandboxRequest,
    options?: CreateSandboxOptions,
  ): Promise<SandboxHandle>;
  getSandbox(id: string, options?: RequestOptions): Promise<DestroyableSandbox>;
  listShapes(options?: RequestOptions): Promise<Shape[]>;
}

export interface SandboxDeps<C extends Partial<CreateosClient> = CreateosClient> {
  /** Injection seam for tests. Defaults to a real client from config. */
  makeClient?: (config: Config) => C;
  /** Injection seam for tests. 2-char token discriminating provision attempts. */
  attemptId?: () => string;
}

/**
 * The single place a createos SDK client is constructed. Lives apart from
 * sandbox.ts so shapes.ts can build a client without importing sandbox.ts,
 * which imports shapes.ts for shapeForLabel — a cycle otherwise.
 */
export function makeSandboxClient<C extends Partial<CreateosClient> = CreateosClient>(
  config: Config,
  deps: SandboxDeps<C>,
): C {
  if (deps.makeClient) return deps.makeClient(config);
  // The real client structurally satisfies CreateosClient (and thus any
  // narrower capability C a caller asks for) — asserted once, here, at the
  // single boundary between the SDK's concrete class and the generic C.
  return new CreateosSandboxClient({
    baseUrl: config.createosBaseUrl,
    apiKey: config.createosApiKey,
    // Workers rejects an unbound fetch called off the SDK's config object.
    fetch: globalThis.fetch.bind(globalThis),
  }) as unknown as C;
}
