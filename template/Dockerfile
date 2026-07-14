FROM nodeops/sandbox:debian

# The runner, docker, and the slice of `ubuntu-latest` that workflows assume is
# always there. Pin what we fetch by hand; bump to rebuild.
#
# Language runtimes are deliberately NOT baked in. `actions/setup-{go,node,python}`,
# `oven-sh/setup-bun` and `asdf-vm/actions/install` all install into the tool cache
# at job time, and every repo pins its own version (`.tool-versions`, matrix, `go.mod`).
# Baking Go 1.26.3 into the image means rebuilding the template on every bump and
# still missing whatever a repo actually asked for — so we ship the *substrate* those
# actions need (a C toolchain, archivers, a writable tool cache) and let them install.
ARG RUNNER_VERSION=2.335.1
ARG GH_VERSION=2.96.0
ARG GH_SHA256=83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60

# One transaction for every apt package, so the index is fetched once and one sweep
# cleans up. Docs, man pages and locales are excluded at the dpkg level — dead weight
# in a VM that lives for the length of one job.
#
# Docker comes from Docker's own apt repo, not Debian's `docker.io` (stuck on 20.10,
# ships neither buildx nor compose, so `docker/build-push-action` and `services:` would
# fail) and not `get.docker.com` (which also drags in docker-ce-rootless-extras — the
# runner is root in its own microVM and will never use rootless). The repo's systemd
# units are inert here: pid1 is fc-spawn, so start-runner.sh launches dockerd itself.
#
# Toolchain rationale, one line each:
#   gcc g++ make libc6-dev  cgo, `go test -race` (repo-template's Go CI does this), node-gyp
#   python3                 workflows that call bare `python3` the way ubuntu-latest lets them
#   zstd                    actions/cache's default codec; without it, every cache silently gzips
#   zip bzip2 xz-utils file wget  the long tail of `run:` steps that assume a GNU-ish box
RUN printf '%s\n' 'path-exclude /usr/share/doc/*' 'path-include /usr/share/doc/*/copyright' 'path-exclude /usr/share/man/*' 'path-exclude /usr/share/locale/*' > /etc/dpkg/dpkg.cfg.d/01-nodoc \
 && apt-get update -qq \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable' > /etc/apt/sources.list.d/docker.list \
 && apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      git jq sudo openssl \
      wget unzip zip xz-utils bzip2 zstd file \
      gcc g++ make libc6-dev \
      python3 \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# gh: 9 of the org's active repos shell out to it (`gh api`, `gh pr merge`, `gh release
# create`) because ubuntu-latest preinstalls it. Taken as the release tarball rather than
# the .deb — same binary, no third apt repo to trust, and the man pages stay behind.
RUN curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
 && tar xzf /tmp/gh.tar.gz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64"

# The runner itself. installdependencies.sh pulls the .NET runtime libs (libicu,
# libkrb5, liblttng-ust) — do not hand-install libicu-dev, the headers are 40 MiB of
# nothing. /opt/hostedtoolcache is the tool cache: it MUST be that literal path, see
# start-runner.sh.
RUN mkdir -p /opt/actions-runner /opt/hostedtoolcache && cd /opt/actions-runner \
 && curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && tar xzf runner.tar.gz && rm runner.tar.gz \
 && ./bin/installdependencies.sh \
 && rm -rf /var/lib/apt/lists/*

# The runner launch script, and its ONLY source of truth. COPY is not permitted by the
# template builder, and heredocs are not either: the builder parses each physical line as
# a Dockerfile instruction (no heredoc awareness), so a `set -euo pipefail` body line is
# read as a `SET` instruction and rejected — hence this single-line printf. Single-quoted
# printf args keep ${JIT_CONFIG} literal so it expands at runtime, not build time.
#
# /dev: the microVM boots devtmpfs over /dev, which shadows anything the image put there —
# so these fixups have to happen at runtime, not in a RUN. Without /dev/fd, bash process
# substitution (`<(...)`) fails outright, which kills asdf's golang plugin mid-checksum
# ("sha256sum: /dev/fd/63: No such file or directory") and any `tee /dev/stderr` /
# `diff <(a) <(b)` in a workflow. Without /dev/shm there is no POSIX shared memory:
# Python multiprocessing and headless Chromium both die.
#
# RUNNER_TOOL_CACHE: actions/setup-python ships a python whose RUNPATH is hard-coded to
# /opt/hostedtoolcache/Python/<v>/x64/lib. A self-hosted runner defaults its tool cache to
# _work/_tool, so the interpreter cannot find libpython and every setup-python job dies.
# Pinning both env vars to the path the binaries were linked against is the whole fix.
#
# os-release: THE BOX LIES ABOUT ITS DISTRO, ON PURPOSE. actions/python-versions publishes
# Ubuntu builds only, and setup-python gates on the running distro before it ever consults
# the tool cache — on Debian it hard-fails with "version 3.12 ... not found for debian 12",
# so every setup-python job in the org dies. The base image allowlist is
# {nodeops/sandbox:debian, nodeops/sandbox:alpine}, so we cannot simply be Ubuntu; claiming
# to be is the only zero-cost fix that works for every Python version, now and later.
#
# 22.04 and not 24.04: the 24.04 python builds link glibc 2.39, this box has 2.36, so they
# would download and then refuse to run. The 22.04 builds (glibc 2.35) run clean here —
# verified: Python 3.12.13 + 3.13.14, ssl/sqlite3/lzma/ctypes all import.
#
# The lie is load-bearing but narrow: apt reads sources.list, not os-release, so package
# installs are unaffected. What it WILL break is a workflow step that derives an apt repo
# from the codename (`. /etc/os-release; ... $VERSION_CODENAME`) — that now yields `jammy`
# on a bookworm box and apt will fail. Loudly, at least. The truth is kept at
# /etc/os-release.debian for anything that needs to know what it is really running on.
#
# Docker: the microVM has no init, so the script starts dockerd itself and blocks until the
# socket answers (~1.4s measured, cold) before handing control to the runner — the runner
# must never accept a job it cannot serve `docker` to. The wait is bounded at 30s and says
# so on stderr if it ever binds.
#
# Teardown: when the ephemeral runner exits (job done, already deregistered from GitHub),
# the script self-deletes the VM via the guest agent's loopback-only self-signal endpoint
# (127.0.0.1:1029, POST /self/delete) — the fast path that reclaims the host VM in seconds
# without waiting on the `completed` webhook. It is best-effort (`|| true`): if the agent
# predates self-signal or the call fails, the `completed` webhook + reaper cron still tear
# the VM down. The trailing halt/poweroff/sysrq is a last-ditch fallback.
RUN printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'ln -sfn /proc/self/fd /dev/fd; ln -sfn /proc/self/fd/0 /dev/stdin; ln -sfn /proc/self/fd/1 /dev/stdout; ln -sfn /proc/self/fd/2 /dev/stderr' 'mkdir -p /dev/shm; grep -q " /dev/shm " /proc/mounts || mount -t tmpfs -o rw,nosuid,nodev,size=1g tmpfs /dev/shm || echo "WARN: no /dev/shm; shared-memory workloads will fail" >&2' 'cp -L /etc/os-release /etc/os-release.debian' 'printf "%s\n" "NAME=\"Ubuntu\"" "VERSION=\"22.04 LTS (Jammy Jellyfish)\"" "ID=ubuntu" "ID_LIKE=debian" "PRETTY_NAME=\"Ubuntu 22.04 LTS\"" "VERSION_ID=\"22.04\"" "VERSION_CODENAME=jammy" "UBUNTU_CODENAME=jammy" > /etc/os-release' 'export RUNNER_TOOL_CACHE=/opt/hostedtoolcache AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache' 'dockerd >/var/log/dockerd.log 2>&1 &' 'for i in $(seq 1 60); do if docker info >/dev/null 2>&1; then break; fi; sleep 0.5; done' 'docker info >/dev/null 2>&1 || echo "WARN: dockerd not ready after 30s; docker steps will fail — see /var/log/dockerd.log" >&2' 'cd /opt/actions-runner' 'RUNNER_ALLOW_RUNASROOT=1 ./run.sh --jitconfig "${JIT_CONFIG}" || true' 'curl -fsS -m 5 -X POST "http://127.0.0.1:1029/self/delete?reason=job-done" || true' 'halt -f 2>/dev/null || poweroff -f 2>/dev/null || echo o > /proc/sysrq-trigger' > /opt/start-runner.sh \
 && chmod +x /opt/start-runner.sh
