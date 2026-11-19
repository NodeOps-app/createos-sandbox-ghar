#!/usr/bin/env bash
set -euo pipefail
mkdir -p /root/otel && cd /root/otel
if [ ! -x otelcol-contrib ]; then
  curl -fsSL -o oc.tgz https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.165.0/otelcol-contrib_0.165.0_linux_amd64.tar.gz
  echo "bd6e73d94bf3359ad6fac25529a8ee308adb9b0b8a0e8af034ed3891fbe5aa33  oc.tgz" | sha256sum -c -
  tar xzf oc.tgz otelcol-contrib && rm oc.tgz
fi
set -a; . /root/otel/otel.env; set +a
exec ./otelcol-contrib --config /root/otel/config.yaml
