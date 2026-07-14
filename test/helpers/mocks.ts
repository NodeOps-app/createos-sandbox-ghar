import { runnerNameFor } from "../../src/sandbox";
type Handler = (req: Request) => Response | Promise<Response>;

/** A fetch double that routes by `METHOD url-substring` → handler. */
export function mockFetch(routes: Record<string, Handler>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = Object.keys(routes).find((k) => {
      const [method, ...rest] = k.split(" ");
      return req.method === method && req.url.includes(rest.join(" "));
    });
    if (!key) return new Response(`unmocked: ${req.method} ${req.url}`, { status: 599 });
    return routes[key]!(req);
  }) as typeof fetch;
}

export const jitToken = "ghs_installation_token";

export function githubRoutes(over: Partial<Record<string, Handler>> = {}): Record<string, Handler> {
  return {
    "POST /access_tokens": () =>
      new Response(
        JSON.stringify({
          token: jitToken,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      ),
    "POST /generate-jitconfig": () =>
      new Response(JSON.stringify({ encoded_jit_config: "ENCODED_JIT_BLOB", runner: { id: 5 } }), {
        status: 201,
      }),
    ...over,
  };
}

/** The `listShapes()` half of a mocked createos client. */
export function shapeCatalog(): {
  id: string;
  vcpu: number;
  mem_mib: number;
  default_disk_mib: number;
}[] {
  return [
    { id: "s-2vcpu-2gb", vcpu: 2, mem_mib: 2048, default_disk_mib: 10240 },
    { id: "s-4vcpu-4gb", vcpu: 4, mem_mib: 4096, default_disk_mib: 10240 },
    { id: "s-8vcpu-16gb", vcpu: 8, mem_mib: 16384, default_disk_mib: 10240 },
  ];
}

/**
 * A runner name for a job, built by the SAME function production mints with —
 * so the format lives in exactly one place (`RUNNER_PREFIX` in sandbox.ts) and
 * renaming the prefix never touches a test again. Tests that only need an opaque
 * runner identity (a DO row's owner) should still use this rather than inventing
 * a literal, so nothing in the suite hardcodes the wire format.
 */
export function runnerName(jobId: number, attemptId = "aa"): string {
  return runnerNameFor(jobId, attemptId);
}
