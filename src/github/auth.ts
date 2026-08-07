import { appJwt } from "./jwt";
import type { Config } from "../types";

type FetchLike = typeof fetch;

const UA = "createos-sandbox-ghar";

interface Cached {
  token: string;
  expiresAtMs: number;
}

/**
 * Mints and caches a GitHub App installation token, coalescing concurrent cold
 * callers onto ONE mint. Shared per credential identity via `credentialSession`,
 * so every GitHubClient in a warm isolate reuses one token (and one RSA sign)
 * until it nears expiry — not one mint per client, nor per provision.
 */
export class TokenCache {
  #cached: Cached | null = null;
  #inflight: Promise<string> | null = null;
  constructor(
    private appId: string,
    private pkcs8Pem: string,
    private installationId: string,
    private apiUrl: string = "https://api.github.com",
    // Bound to globalThis: calling via `this.fetchImpl(...)` would otherwise
    // rebind `this` to the instance, which Workers rejects (Illegal invocation).
    private fetchImpl: FetchLike = fetch.bind(globalThis),
  ) {}

  async token(): Promise<string> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAtMs - 60_000 > now) {
      return this.#cached.token;
    }
    // Coalesce: a burst of provisions racing the same cold/expired window must
    // mint ONCE, not once each — a shared cache without this still stampedes at
    // expiry. Cleared on settle so a REJECTED mint is never cached and the next
    // caller retries with a fresh sign.
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#mint().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #mint(): Promise<string> {
    const jwt = await appJwt(this.appId, this.pkcs8Pem);
    const res = await this.fetchImpl(
      `${this.apiUrl}/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": UA,
        },
      },
    );
    if (!res.ok) {
      throw new Error(`installation token failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    this.#cached = { token: body.token, expiresAtMs: Date.parse(body.expires_at) };
    return body.token;
  }
}

/** One installation of our App, as the operator needs to see it. */
export interface AppInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
}

/**
 * Every installation of our GitHub App, newest ids last.
 *
 * App-JWT authed, not installation-token authed, which is the whole reason this
 * lives here and not on GitHubClient: `GET /app/installations` speaks for the
 * App itself, so it works for an org we have no admin rights on. That matters
 * because the operator-side alternative — `GET /orgs/<org>/installations` — needs
 * admin on the TENANT's org, which we never have for a community tenant. The App
 * private key is a Worker secret with no copy on an operator machine, so the
 * Worker is the only place this call can be made from.
 *
 * Uncached on purpose: admin-frequency only, never on the webhook hot path, and
 * a stale list is worse than a slow one when it is what an onboarding decision
 * keys on.
 */
export async function listAppInstallations(
  config: Config,
  fetchImpl: FetchLike = fetch.bind(globalThis),
): Promise<AppInstallation[]> {
  const perPage = 100;
  const jwt = await appJwt(config.githubAppId, config.githubAppPrivateKeyPkcs8);
  const res = await fetchImpl(`${config.githubApiUrl}/app/installations?per_page=${perPage}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
    },
  });
  if (!res.ok) {
    throw new Error(`list app installations failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    id?: number;
    account?: { login?: string; type?: string };
    repository_selection?: string;
  }[];
  // Single page by design — we are nowhere near 100 installs. Warned rather
  // than silently truncated: a full page means the list is incomplete, and an
  // operator reading "org not found" off a truncated list would conclude the
  // applicant never installed the App (repo convention: no silent bounds).
  if (body.length === perPage) {
    console.warn(
      `listAppInstallations: hit the ${perPage}-install page limit; the list is truncated and may omit installations. Add pagination.`,
    );
  }
  return body.map((i) => ({
    installationId: i.id ?? 0,
    accountLogin: i.account?.login ?? "",
    accountType: i.account?.type ?? "",
    repositorySelection: i.repository_selection ?? "",
  }));
}

/**
 * Warm-isolate registry: one TokenCache per credential identity, reused across
 * invocations for as long as the isolate lives (opportunistic — Workers evicts
 * isolates at will, so correctness never depends on reuse). This is the whole
 * point of the module — it moves token locality from the *client* (a fresh cache
 * per GitHubClient, so a recovery tick minting N runners paid N+1 mints, and
 * every webhook provision re-minted) to the *credential*.
 */
const sessions = new Map<string, TokenCache>();

/**
 * The shared credential session for this config. Keyed by the identity that
 * decides which token is valid — app id + installation id + API host — so a warm
 * isolate can NEVER hand a token minted for one installation to another. The
 * private key is deliberately NOT in the key: rotating it ships as a redeploy,
 * which starts a fresh isolate with an empty registry.
 *
 * The session captures the FIRST caller's fetch. In production that is always the
 * bound global fetch, so sharing is transparent; tests inject a fetch per case
 * and must call resetCredentialSessionsForTests() so a mock never leaks forward.
 */
export function credentialSession(
  config: Config,
  fetchImpl: FetchLike = fetch.bind(globalThis),
  installationId?: string,
): TokenCache {
  const effective = installationId ?? config.githubInstallationId;
  const key = `${config.githubAppId}|${effective}|${config.githubApiUrl}`;
  let s = sessions.get(key);
  if (!s) {
    s = new TokenCache(
      config.githubAppId,
      config.githubAppPrivateKeyPkcs8,
      effective,
      config.githubApiUrl,
      fetchImpl,
    );
    sessions.set(key, s);
  }
  return s;
}

/** Test seam: drop all warm sessions so an injected fetch never leaks across cases. */
export function resetCredentialSessionsForTests(): void {
  sessions.clear();
}
