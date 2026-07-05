/// <reference types="@cloudflare/vitest-pool-workers" />

declare module "cloudflare:test" {
  interface ProvidedEnv {
    COORDINATOR: DurableObjectNamespace<import("../src/coordinator").Coordinator>;
    GITHUB_APP_ID: string;
    GITHUB_INSTALLATION_ID: string;
    GITHUB_WEBHOOK_SECRET: string;
    CREATEOS_API_KEY: string;
    GITHUB_APP_PRIVATE_KEY: string;
  }
}
