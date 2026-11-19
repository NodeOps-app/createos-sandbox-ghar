# OTEL beta collector sandbox

Files for the `ghar-otel` sandbox (see the "OTEL tracing (beta)" section of the main README). They are pushed into `/root/otel/` and started with `createos sandbox process start <id> -- bash /root/otel/<script>`:

| File | Becomes | Runs |
|---|---|---|
| `collector.yaml`, `start-collector.sh` | `config.yaml`, `start.sh` | OpenTelemetry Collector contrib: `githubreceiver` on :19418, OTLP on loopback :14318, exports to Tempo |
| `start-proxy.sh` | `proxy-start.sh` | `scripts/otel-auth-proxy.ts` (+ `src/otel.ts`) under `proxy/`, on the public :4318 |
| `tempo.yaml`, `start-tempo.sh` | `tempo.yaml`, `start-tempo.sh` | Tempo 3.x monolithic, local disk, loopback only (OTLP gRPC :4319, query :3200) |
| `grafana-dashboards.yaml`, `dashboard.json` | `grafana-provisioning/dashboards/ghar.yaml`, `dashboards/ghar-ci-tracing.json` | the "ghar CI tracing (beta)" dashboard: queue wait, step p95 by job, runner-side span rates, run / slow-step / failure tables |
| `grafana-datasource.yaml`, `start-grafana.sh` | `grafana-provisioning/datasources/tempo.yaml`, `start-grafana.sh` | Grafana OSS on the public :3000, with its own login (no sign-up, no anonymous) |

Untracked env files hold the secrets: `otel.env` (`SPIKE_SECRET` = the webhook secret, `OTEL_TOKEN_KEY` = the per-run token key) and `grafana.env` (`GF_SECURITY_ADMIN_USER`, `GF_SECURITY_ADMIN_PASSWORD`). Binaries are downloaded on first start and checked against pinned sha256 digests (Grafana's comes from dl.grafana.com only). Tempo keeps traces on local disk; the collector also appends to `/root/otel/traces.jsonl`.
