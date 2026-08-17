declare namespace Cloudflare {
  interface Env {
    COORDINATOR: DurableObjectNamespace<import("../src/coordinator").Coordinator>;
    GITHUB_APP_ID: string;
    GITHUB_INSTALLATION_ID: string;
    GITHUB_WEBHOOK_SECRET: string;
    CREATEOS_API_KEY: string;
    GITHUB_APP_PRIVATE_KEY: string;
  }
}
