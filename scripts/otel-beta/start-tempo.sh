#!/usr/bin/env bash
set -euo pipefail
mkdir -p /root/otel/tempo && cd /root/otel/tempo
if [ ! -x tempo ]; then
  curl -fsSL -o t.tgz https://github.com/grafana/tempo/releases/download/v3.1.1/tempo_3.1.1_linux_amd64.tar.gz
  echo "cc7efc370d2e5cfdf93792060da4ea9d6c2a3aae348ccc95cbaaaf3393e1d339  t.tgz" | sha256sum -c -
  tar xzf t.tgz tempo && rm t.tgz
fi
exec ./tempo -config.file=/root/otel/tempo.yaml
