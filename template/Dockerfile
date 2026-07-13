FROM nodeops/sandbox:debian

# Runner + docker + git + the launch script. Pin the runner version; bump to
# rebuild. Verify the download checksum from the runner release page.
ARG RUNNER_VERSION=2.335.1
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq sudo unzip libicu-dev \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/actions-runner && cd /opt/actions-runner \
 && curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && tar xzf runner.tar.gz && rm runner.tar.gz \
 && ./bin/installdependencies.sh

# Docker engine, from Docker's own convenience script rather than Debian's
# `docker.io` (which is stuck on 20.10 and ships neither buildx nor compose, so
# docker/build-push-action and `services:` would fail). This pulls docker-ce plus
# the buildx and compose plugins. The script's systemd path is a no-op here — the
# microVM's pid1 is fc-spawn, so start-runner.sh launches dockerd itself.
RUN curl -fsSL https://get.docker.com | sh \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m runner && usermod -aG docker runner \
 && chown -R runner:runner /opt/actions-runner

# The runner launch script, and its ONLY source of truth. COPY is not permitted
# by the template builder, and heredocs are not either: the builder parses each
# physical line as a Dockerfile instruction (no heredoc awareness), so a
# `set -euo pipefail` body line is read as a `SET` instruction and rejected —
# hence this single-line printf. Single-quoted printf args keep ${JIT_CONFIG}
# literal so it expands at runtime, not build time.
#
# Docker: the microVM has no init, so the script starts dockerd itself and blocks
# until the socket answers (~1.4s measured, cold) before handing control to the runner —
# the runner must never accept a job it cannot serve `docker` to. The wait is
# bounded at 30s and says so on stderr if it ever binds.
#
# Teardown: when the ephemeral runner exits (job done, already deregistered from
# GitHub), the script self-deletes the VM via the guest agent's loopback-only
# self-signal endpoint (127.0.0.1:1029, POST /self/delete) — the fast path that
# reclaims the host VM in seconds without waiting on the `completed` webhook. It
# is best-effort (`|| true`): if the agent predates self-signal or the call
# fails, the `completed` webhook + reaper cron still tear the VM down. The trailing
# halt/poweroff/sysrq is a last-ditch fallback and a no-op on the minimal base.
RUN printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'dockerd >/var/log/dockerd.log 2>&1 &' 'for i in $(seq 1 60); do if docker info >/dev/null 2>&1; then break; fi; sleep 0.5; done' 'docker info >/dev/null 2>&1 || echo "WARN: dockerd not ready after 30s; docker steps will fail — see /var/log/dockerd.log" >&2' 'cd /opt/actions-runner' 'RUNNER_ALLOW_RUNASROOT=1 ./run.sh --jitconfig "${JIT_CONFIG}" || true' 'curl -fsS -m 5 -X POST "http://127.0.0.1:1029/self/delete?reason=job-done" || true' 'halt -f 2>/dev/null || poweroff -f 2>/dev/null || echo o > /proc/sysrq-trigger' > /opt/start-runner.sh \
 && chmod +x /opt/start-runner.sh
