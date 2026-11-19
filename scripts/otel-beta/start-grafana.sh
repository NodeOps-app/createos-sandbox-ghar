#!/usr/bin/env bash
set -euo pipefail
mkdir -p /root/otel/grafana/data /root/otel/grafana/plugins /root/otel/grafana/logs && cd /root/otel/grafana
if [ ! -x home/bin/grafana ]; then
  curl -fsSL -o g.tgz https://dl.grafana.com/oss/release/grafana-13.3.1.linux-amd64.tar.gz
  echo "6acf8939dd2f73332cbcafc27a33973fb1115b8867e7ffa3223c6e2ecbed8531  g.tgz" | sha256sum -c -
  mkdir -p home && tar xzf g.tgz --strip-components=1 -C home && rm g.tgz
fi
set -a; . /root/otel/grafana.env; set +a
export GF_SERVER_HTTP_ADDR=0.0.0.0 GF_SERVER_HTTP_PORT=3000
export GF_PATHS_DATA=/root/otel/grafana/data GF_PATHS_PLUGINS=/root/otel/grafana/plugins GF_PATHS_LOGS=/root/otel/grafana/logs
export GF_PATHS_PROVISIONING=/root/otel/grafana-provisioning
# Behind the sandbox ingress the Host Grafana sees is not the public one, so a browser's
# POST (Origin = the public host) is refused as "origin not allowed". Name the public host.
export GF_SERVER_DOMAIN=01m7say7btb3aq4c3vcr68ryqk-3000.app.sb.createos.sh GF_SERVER_ROOT_URL=https://01m7say7btb3aq4c3vcr68ryqk-3000.app.sb.createos.sh/
export GF_SECURITY_CSRF_TRUSTED_ORIGINS=01m7say7btb3aq4c3vcr68ryqk-3000.app.sb.createos.sh
# Its own login is the only way in: no sign-up, no anonymous.
export GF_USERS_ALLOW_SIGN_UP=false GF_AUTH_ANONYMOUS_ENABLED=false
export GF_ANALYTICS_REPORTING_ENABLED=false GF_ANALYTICS_CHECK_FOR_UPDATES=false
cd home && exec ./bin/grafana server --homepath .
