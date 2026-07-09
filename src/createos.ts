import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import type { Config } from "./types";

export interface SandboxDeps {
  /** Injection seam for tests. Defaults to a real client from config. */
  makeClient?: (config: Config) => CreateosSandboxClient;
  /** Injection seam for tests. 2-char token discriminating provision attempts. */
  attemptId?: () => string;
}

/**
 * The single place a createos SDK client is constructed. Lives apart from
 * sandbox.ts so shapes.ts can build a client without importing sandbox.ts,
 * which imports shapes.ts for shapeForLabel — a cycle otherwise.
 */
export function makeSandboxClient(config: Config, deps: SandboxDeps): CreateosSandboxClient {
  if (deps.makeClient) return deps.makeClient(config);
  return new CreateosSandboxClient({
    baseUrl: config.createosBaseUrl,
    apiKey: config.createosApiKey,
    // Workers rejects an unbound fetch called off the SDK's config object.
    fetch: globalThis.fetch.bind(globalThis),
  });
}
