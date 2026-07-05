import { appJwt } from "./jwt";

type FetchLike = typeof fetch;

const UA = "createos-sandbox-ghar";

interface Cached {
  token: string;
  expiresAtMs: number;
}

/** Mints and caches a GitHub App installation token. One instance per request. */
export class TokenCache {
  #cached: Cached | null = null;
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
