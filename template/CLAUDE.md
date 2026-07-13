# template/ — pre-baked runner rootfs

`Dockerfile` (RUN-only) + `build.ts`. The runner launch script is embedded in the Dockerfile via `printf` (COPY/heredoc are not permitted by the template builder) and that is its single source of truth. `bun run build:template` auto-pulls the latest `actions/runner`, deletes the old template, and rebuilds. `.github/workflows/bump-runner.yml` does this daily (needs repo secret `CREATEOS_API_KEY`). Not part of the Worker bundle.

Docker comes from `get.docker.com` (docker-ce + buildx + compose), **not** Debian's `docker.io` — that package is stuck on 20.10 and ships neither plugin, which breaks `docker/build-push-action` and `services:`. The microVM's pid1 is `fc-spawn`, not systemd, so **nothing starts the daemon for you**: `start-runner.sh` launches `dockerd` and blocks on the socket (~1.4s cold) before `run.sh` accepts a job. Verified on a live box: overlay storage driver, cgroup v2, bridge networking, `docker run` green.
