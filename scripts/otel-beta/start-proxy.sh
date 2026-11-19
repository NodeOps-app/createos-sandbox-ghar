#!/usr/bin/env bash
set -euo pipefail
cd /root/otel/proxy
if [ ! -x /root/otel/bun ]; then
  curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip
  echo "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c  /tmp/bun.zip" | sha256sum -c -
  (command -v unzip >/dev/null || (apt-get update -qq && apt-get install -y -qq unzip >/dev/null))
  unzip -oq /tmp/bun.zip -d /tmp
  mv /tmp/bun-linux-x64/bun /root/otel/bun && chmod +x /root/otel/bun
fi
set -a; . /root/otel/otel.env; set +a
exec /root/otel/bun scripts/otel-auth-proxy.ts
