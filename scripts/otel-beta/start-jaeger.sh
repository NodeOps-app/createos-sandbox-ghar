#!/usr/bin/env bash
set -euo pipefail
mkdir -p /root/otel/jaeger && cd /root/otel/jaeger
if [ ! -x jaeger ]; then
  curl -fsSL -o j.tgz https://github.com/jaegertracing/jaeger/releases/download/v2.23.0/jaeger-2.23.0-linux-amd64.tar.gz
  echo "4b7bd152ed31d2205e4e73b873d289c61cd3fabaecc86443070143448d40b753  j.tgz" | sha256sum -c -
  tar xzf j.tgz --strip-components=1 --wildcards '*/jaeger' && rm j.tgz
fi
exec ./jaeger --config /root/otel/jaeger-config.yaml
