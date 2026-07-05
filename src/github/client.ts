import type { Config } from "../types";
import { TokenCache } from "./auth";

type FetchLike = typeof fetch;
const UA = "createos-sandbox-ghar";

export class GitHubClient {
  #tokens: TokenCache;
  constructor(
    private config: Config,
    // Bound to globalThis so `this.fetchImpl(...)` keeps fetch's own `this`
    // (Workers throws Illegal invocation otherwise).
    private fetchImpl: FetchLike = fetch.bind(globalThis),
  ) {
    this.#tokens = new TokenCache(
      config.githubAppId,
      config.githubAppPrivateKeyPkcs8,
      config.githubInstallationId,
      config.githubApiUrl,
      fetchImpl,
    );
  }

  async #headers(): Promise<HeadersInit> {
    return {
      Authorization: `Bearer ${await this.#tokens.token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      "Content-Type": "application/json",
    };
  }

  /** Creates a JIT ephemeral org runner config; returns encoded_jit_config. */
  async generateJitConfig(runnerName: string): Promise<string> {
    const res = await this.fetchImpl(
      `${this.config.githubApiUrl}/orgs/${this.config.githubOrg}/actions/runners/generate-jitconfig`,
      {
        method: "POST",
        headers: await this.#headers(),
        body: JSON.stringify({
          name: runnerName,
          runner_group_id: 1,
          labels: [this.config.runnerLabel],
          work_folder: "_work",
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`generate-jitconfig failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { encoded_jit_config: string };
    return body.encoded_jit_config;
  }

  /**
   * Resolves whether a workflow run originates from a fork. Only called under
   * the fork-gated policy. Uses the run's head_repository vs the base repo.
   */
  async isForkJob(repoFullName: string, runId: number): Promise<boolean> {
    const res = await this.fetchImpl(
      `${this.config.githubApiUrl}/repos/${repoFullName}/actions/runs/${runId}`,
      { method: "GET", headers: await this.#headers() },
    ).catch(() => null);
    if (!res || !res.ok) return true; // fail closed: treat unknown as fork
    const body = (await res.json()) as {
      head_repository?: { fork?: boolean; owner?: { login?: string } };
    };
    const head = body.head_repository;
    if (!head) return true;
    if (head.fork === true) return true;
    const login = head.owner?.login;
    return login !== undefined && login.toLowerCase() !== this.config.githubOrg.toLowerCase();
  }
}
