/**
 * Operator tool: the auth front for the OTEL beta collector. Runs INSIDE the
 * collector sandbox, on the port its public HTTPS URL maps to. The collector's
 * stock auth extensions only know static tokens; ours are per-run and expiring
 * (src/otel.ts), so this verifies them and forwards to the collector's loopback
 * OTLP port. Not part of the Worker bundle.
 *
 *   OTEL_TOKEN_KEY=... bun scripts/otel-auth-proxy.ts
 *   bun build --compile --target=bun-linux-x64 scripts/otel-auth-proxy.ts --outfile otel-auth-proxy
 */
import { OTEL_TOKEN_HEADER, verifyOtelToken } from "../src/otel";

const KEY = process.env.OTEL_TOKEN_KEY;
if (!KEY) throw new Error("OTEL_TOKEN_KEY is required");
const PORT = Number(process.env.PORT ?? 4318);
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:14318";
const MAX_BODY_BYTES = 1 << 20;
const MAX_REQUESTS_PER_RUN = 2000;
const MAX_TRACKED_RUNS = 10_000;

const perRun = new Map<string, number>();

Bun.serve({
  port: PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return new Response("ok");
    if (req.method !== "POST" || path !== "/v1/traces")
      return new Response("not found", { status: 404 });

    const check = await verifyOtelToken(KEY, req.headers.get(OTEL_TOKEN_HEADER) ?? "", Date.now());
    if (!check.ok) {
      console.warn(`rejected: ${check.reason}`);
      return new Response("unauthorized", { status: 401 });
    }

    const used = (perRun.get(check.runnerName) ?? 0) + 1;
    if (used > MAX_REQUESTS_PER_RUN) {
      console.warn(`run ${check.runnerName} over ${MAX_REQUESTS_PER_RUN} requests; refusing`);
      return new Response("too many requests", { status: 429 });
    }
    if (perRun.size >= MAX_TRACKED_RUNS && !perRun.has(check.runnerName)) {
      console.warn(`tracking ${MAX_TRACKED_RUNS} runs; clearing counters`);
      perRun.clear();
    }
    perRun.set(check.runnerName, used);

    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      console.warn(
        `run ${check.runnerName} sent ${body.byteLength} bytes; limit ${MAX_BODY_BYTES}`,
      );
      return new Response("too large", { status: 413 });
    }
    const headers = new Headers();
    for (const h of ["content-type", "content-encoding"]) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    return fetch(`${UPSTREAM}/v1/traces`, { method: "POST", headers, body });
  },
});
console.log(`otel-auth-proxy :${PORT} -> ${UPSTREAM}`);
