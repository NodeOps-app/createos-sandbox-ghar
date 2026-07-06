FROM nodeops/sandbox:debian

# Runner + docker + git + the launch script. Pin the runner version; bump to
# rebuild. Verify the download checksum from the runner release page.
ARG RUNNER_VERSION=2.335.1
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq sudo docker.io libicu-dev \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m runner && usermod -aG docker runner \
 && mkdir -p /opt/actions-runner && cd /opt/actions-runner \
 && curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && tar xzf runner.tar.gz && rm runner.tar.gz \
 && ./bin/installdependencies.sh \
 && chown -R runner:runner /opt/actions-runner

# The runner launch script, and its ONLY source of truth. COPY is not permitted
# by the template builder, and heredocs are not either: the builder parses each
# physical line as a Dockerfile instruction (no heredoc awareness), so a
# `set -euo pipefail` body line is read as a `SET` instruction and rejected —
# hence this single-line printf. Single-quoted printf args keep ${JIT_CONFIG}
# literal so it expands at runtime, not build time.
#
# Teardown: when the ephemeral runner exits (job done, already deregistered from
# GitHub), the script self-deletes the VM via the guest agent's loopback-only
# self-signal endpoint (127.0.0.1:1029, POST /self/delete) — the fast path that
# reclaims the host VM in seconds without waiting on the `completed` webhook. It
# is best-effort (`|| true`): if the agent predates self-signal or the call
# fails, the `completed` webhook + reaper cron still tear the VM down. The trailing
# halt/poweroff/sysrq is a last-ditch fallback and a no-op on the minimal base.
RUN printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'cd /opt/actions-runner' 'RUNNER_ALLOW_RUNASROOT=1 ./run.sh --jitconfig "${JIT_CONFIG}" || true' 'curl -fsS -m 5 -X POST "http://127.0.0.1:1029/self/delete?reason=job-done" || true' 'halt -f 2>/dev/null || poweroff -f 2>/dev/null || echo o > /proc/sysrq-trigger' > /opt/start-runner.sh \
 && chmod +x /opt/start-runner.sh
