#!/usr/bin/env bash
# Live "is anything stuck right now" check across every tenant, for the
# job-startup-delay incidents (see AGENTS.md, #degrade-ghar). Hits our own
# Worker's admin API — the only source that can see a community tenant's job
# state, since we have no CreateOS/GitHub access of our own to their org.
#
# Shows jobs sitting `pending` or `provisioning` (no VM running yet) longer
# than a threshold, across ALL tenants at once — grouped by org so a single
# large tenant's backlog doesn't bury a small one's. Read-only, safe to run
# as often as needed.
#
# Usage:
#   tools/ghar-degradation.sh [--org ORG] [--threshold-ms MS]
#
# Env:
#   GHAR_ADMIN_TOKEN   required (bearer token for /admin/*; see .env)
#   GHAR_WORKER_URL    optional, defaults to the prod Worker
#
# Examples:
#   tools/ghar-degradation.sh                          # everything, default 60s threshold
#   tools/ghar-degradation.sh --org maximem-ai          # one org only
#   tools/ghar-degradation.sh --threshold-ms 0          # every job with no VM yet, any age

set -uo pipefail

WORKER_URL="${GHAR_WORKER_URL:-https://createos-sandbox-ghar.hello-927.workers.dev}"
ORG_FILTER=""
THRESHOLD_MS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --org) ORG_FILTER="$2"; shift 2 ;;
    --threshold-ms) THRESHOLD_MS="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "${GHAR_ADMIN_TOKEN:-}" ]; then
  echo "GHAR_ADMIN_TOKEN is not set (see .env)" >&2
  exit 1
fi

query=""
[ -n "$THRESHOLD_MS" ] && query="?threshold_ms=${THRESHOLD_MS}"

stale_json=$(curl -sf -H "Authorization: Bearer $GHAR_ADMIN_TOKEN" \
  "${WORKER_URL}/admin/stale-jobs${query}") || {
  echo "GET /admin/stale-jobs failed — check GHAR_ADMIN_TOKEN / WORKER_URL" >&2
  exit 1
}

tenants_json=$(curl -sf -H "Authorization: Bearer $GHAR_ADMIN_TOKEN" \
  "${WORKER_URL}/admin/tenants") || {
  echo "GET /admin/tenants failed — check GHAR_ADMIN_TOKEN / WORKER_URL" >&2
  exit 1
}

echo "$stale_json" | jq -r --arg org "$ORG_FILTER" '
  map(select($org == "" or (.repoFullName | startswith($org + "/"))))
  | sort_by(-.ageMs)
  | if length == 0 then
      "no jobs currently stuck (no VM yet, past threshold)"
    else
      group_by(.repoFullName | split("/")[0])
      | map(
          "== " + (.[0].repoFullName | split("/")[0]) + " (" + (length | tostring) + " stuck) ==\n"
          + ( map(
              "  job=" + (.jobId | tostring)
              + " run=" + (.runId | tostring)
              + " repo=" + .repoFullName
              + " state=" + .state
              + " waiting=" + ((.ageMs / 1000 | floor | tostring) + "s")
            ) | join("\n") )
        )
      | join("\n\n")
    end
'

echo
echo "-- tenant config (for context) --"
echo "$tenants_json" | jq -r --arg org "$ORG_FILTER" '
  .[] | select($org == "" or (.orgLogin | ascii_downcase) == ($org | ascii_downcase))
  | "\(.orgLogin): cap=\(.concurrencyCap) grant=\(.minuteGrant)min shape<=\(.maxShape) status=\(.status)"
'
