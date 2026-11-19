#!/usr/bin/env bash
set -euo pipefail
mkdir -p /root/otel/caddy && cd /root/otel/caddy
if [ ! -x caddy ]; then
  curl -fsSL -o c.tgz https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_amd64.tar.gz
  echo "5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb  c.tgz" | sha256sum -c -
  tar xzf c.tgz caddy && rm c.tgz
fi
set -a; . /root/otel/jaeger.env; set +a
export JAEGER_PASS_HASH="$(./caddy hash-password --plaintext "$JAEGER_PASSWORD")"
exec ./caddy run --config /root/otel/Caddyfile --adapter caddyfile
