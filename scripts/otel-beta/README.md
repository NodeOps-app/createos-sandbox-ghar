# OTEL beta collector sandbox

Files for the `ghar-otel` sandbox (see the "OTEL tracing (beta)" section of the main README). They are pushed into `/root/otel/` and started with `createos sandbox process start <id> -- bash /root/otel/<script>`:

| File | Becomes | Runs |
|---|---|---|
| `collector.yaml` | `config.yaml` | read by `start-collector.sh` (OpenTelemetry Collector contrib, `githubreceiver` on :19418, OTLP on loopback :14318, exports to Jaeger) |
| `start-proxy.sh` | `proxy-start.sh` | `scripts/otel-auth-proxy.ts` (+ `src/otel.ts`) under `proxy/`, on the public :4318 |
| `jaeger.yaml`, `start-jaeger.sh` | `jaeger-config.yaml`, `jaeger-start.sh` | Jaeger v2, in memory, loopback only (OTLP gRPC :4317, UI :16687) |
| `Caddyfile`, `start-caddy.sh` | same | Caddy basic-auth login on :16686 in front of the Jaeger UI |

Two untracked env files hold the secrets: `otel.env` (`SPIKE_SECRET` = the webhook secret, `OTEL_TOKEN_KEY` = the per-run token key) and `jaeger.env` (`JAEGER_USER`, `JAEGER_PASSWORD`). Binaries are downloaded on first start and checked against pinned sha256 digests. Traces live in memory, so a Jaeger restart empties the UI; the collector also appends to `/root/otel/traces.jsonl`.
