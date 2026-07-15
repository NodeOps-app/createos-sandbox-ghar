import type { Config } from "./types";

/**
 * Posts a failure alert to the configured webhook (Slack-compatible `{ text }`
 * payload). A no-op when ALERT_WEBHOOK_URL is unset. Never throws — alerting
 * must not break the provisioning/teardown path it reports on.
 */
export async function notify(config: Config, text: string): Promise<void> {
  if (!config.alertWebhookUrl) return;
  try {
    const res = await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    // A non-2xx (a dead/rotated Slack URL 404s, a throttled one 429s) resolves
    // without throwing, so an unchecked response silently swallows the alert —
    // and this is the failure path, the one moment alerting has to work. Still
    // never throw on the caller; a lost alert must at least leave a trace.
    if (!res.ok) {
      console.error(`notify: alert webhook returned ${res.status} — alert not delivered: ${text}`);
    }
  } catch (err) {
    // A network-level failure is the same silent loss; log it, don't rethrow.
    console.error(
      `notify: alert webhook request failed (${String(err)}) — alert not delivered: ${text}`,
    );
  }
}
