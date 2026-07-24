import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            // Pin the default tenancy for the pre-tenant integration fixtures:
            // vitest reads wrangler.toml, which prod now sets to "multi" — without
            // this, every pre-tenant webhook test hits multi-mode admission with no
            // installation.id and refuses. Multi-mode suites override this per-suite.
            TENANCY_MODE: "single",
            MAX_CONCURRENT: "2",
            GITHUB_ORG: "nodeops-app",
            RUNNER_LABEL: "createos",
            GITHUB_APP_ID: "1",
            GITHUB_INSTALLATION_ID: "2",
            GITHUB_WEBHOOK_SECRET: "test-secret",
            ADMIN_TOKEN: "test-admin-token",
            CREATEOS_API_KEY: "k",
            GITHUB_APP_PRIVATE_KEY:
              "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC4ayzd36sPruIn\nFkps5O4enl1N/yeJuCEHF/d+5EahCDiJXUiyUWllRY3ilm0ZnKm0OMaZHGo/SKI3\nM5qCB/hSTleOi1v6K6aajDF24vXkDqaLsWL77WNw4KqXRL064AgdabqQjvLlzyW+\nE2kpmaF6mWUMHeDuC631AnZz1z94IRLfexilDLMovse38503nF5drFdrr4/2XlXF\nCTvs2p2rmIvkHnTXJq5epeMkLB7cNN+lzpdu3yHJqnn41fZMPRKDCdFpKQ79bIyc\nj2XymSQGOjnxzhepp1llWcWBta7IZ4xAwpK/plKrtonFxzSnlE7C7mi0TISjPuBM\nSWMA843LAgMBAAECggEADbgvbMwkcjS871J5s/MuAcofP9uxCc5QarIuP9rkpDsz\n1YhCjb1/vUB45zfwotykRVuJ7r8N6mpRYxDsOCs2nozkd57Hd2uC5/FxBpqo10/9\ntNu79Oj6ol2cY0eCWlxrTiDc978is9T+xk60Xptmx3Oc8FNStfLZfKYzwLdtKdcP\nl5jwDzALvXbFU24EDoQL7n4+bufAwjYNDHrLa1WpSfL9kZEtU7rd0F2Si3DfdxzC\n7RdOoclVUzQBXTOgRY5kBGfLV9fHuZfxAGViacqGaqAp/6b/ypBtB+Y3h08+ZNl8\niv6BLstF88jZs3rNcGeLbBrjVB8SIyReNISc5adapQKBgQDtRJmHMCZul3BIbGd7\nHJ6EvnZ5HeLHWMBmzty1yQjy9IVBX8Mevq9rbfmG5stl5WOOhrmAz1S6iYM/8eVZ\nnb+Bxva9rZ+X2v5MvXFaFnRbKebSSYFsFDP7PyT4E+/e8xfhg8MyzYm4sKaLOEdf\n2BQg4vIJkk5SzdB7TvwaBDX37wKBgQDG+nFuKkEwMbddmd7cAaAFpbZOMH2y599Y\nFHPjC4e0ImmB4hHU2nh+PC9YRlWstFTR2eQ+p7vOlVRGRteKh9zczWlwUn1Hs15j\nI4phEf5JJ5dKXi9z7C55GECljEqeZIFYOU5xEuDwqt4jqHzr4G9pg/n8axatAUZQ\nJmYFQ9KL5QKBgFt0Pq1CHP4xtyDjT/u/K0bFV0sV/uyRxA+cmqwjIiTrpVVugPof\ny+Pfzvd1jF7pTTeJrIT+5YzFJmcGaT3itQdj1oWEH+jbi3uu5bswvobJHuRdWtp6\n6xJj428P2DyafND7BclWOkiLJpaxCani0tdeQqb30uLN3Bc7eabZiqfXAoGBAMGB\n2ARSNZlgEDqIJNMDBZPYZ6Y8xFHT7EHliho5IV1OxhrZN4wwd1QUxdpsdG+D5KU8\n6RsB1sR+NzotNPr1TBaz8aGZp1qultGFQ9NJQ2nzhc9+L1nmS//aVSxqdjr59UxO\nVvniaT3EfkphVjOyzcbo4ZnYr3HKto3F+huOrNj9AoGBAKvgk3DdwORiyctXL2Pr\n9hmT7+ZcZ8MlV+SIws+IuwEbSmtt9MLYu2EQbo59p5md57Rz8HwNkDHvEFAecrlb\nV0IsLnXpGiVHXaH1jF5Y2YJkVxmoMFZ58yC5ZJeAwwsjlMqYcv3yZbFEZn/fAKj2\nyP+g75b6RJGkEqvhsVhuVc+N\n-----END PRIVATE KEY-----\n",
          },
        },
      },
    },
  },
});
