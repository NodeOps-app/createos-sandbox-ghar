import type { Config } from "./types";

/**
 * Posts a failure alert to the configured webhook (Slack-compatible `{ text }`
 * payload). A no-op when ALERT_WEBHOOK_URL is unset. Never throws — alerting
 * must not break the provisioning/teardown path it reports on.
 */
export async function notify(config: Config, text: string): Promise<void> {
  if (!config.alertWebhookUrl) return;
  try {
    await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    // swallow: a failed alert is not worth failing the caller over
  }
}
