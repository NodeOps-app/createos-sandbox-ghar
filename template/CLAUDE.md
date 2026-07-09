# template/ — pre-baked runner rootfs

`Dockerfile` (RUN-only) + `build.ts`. The runner launch script is embedded in the Dockerfile via `printf` (COPY/heredoc are not permitted by the template builder) and that is its single source of truth. `bun run build:template` auto-pulls the latest `actions/runner`, deletes the old template, and rebuilds. `.github/workflows/bump-runner.yml` does this daily (needs repo secret `CREATEOS_API_KEY`). Not part of the Worker bundle.
