FROM nodeops/sandbox:debian

# Runner + docker + git + the launch script. Pin the runner version; bump to
# rebuild. Verify the download checksum from the runner release page.
ARG RUNNER_VERSION=2.330.0
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

# start-runner.sh via RUN heredoc (COPY is not permitted by the template builder).
RUN cat > /opt/start-runner.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/actions-runner
RUNNER_ALLOW_RUNASROOT=1 ./run.sh --jitconfig "${JIT_CONFIG}" || true
sudo halt -f
EOF
RUN chmod +x /opt/start-runner.sh
