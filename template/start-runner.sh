#!/usr/bin/env bash
set -euo pipefail
cd /opt/actions-runner
# --jitconfig runs a single ephemeral job then exits. Root is acceptable here:
# the VM is single-use + isolated + ephemeral.
RUNNER_ALLOW_RUNASROOT=1 ./run.sh --jitconfig "${JIT_CONFIG}" || true
# Self-reap: halt the VM so fc's liveness watcher destroys it (~30s).
# Upgrades to explicit guest self-destruct when NodeOps-app/fc#520 ships.
sudo halt -f
