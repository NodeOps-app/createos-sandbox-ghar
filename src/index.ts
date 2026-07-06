import { Coordinator } from "./coordinator";
import { handleWebhook, runReaper, runReconciler } from "./handler";

export { Coordinator };

export interface Bindings {
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  [key: string]: unknown;
}

export default {
  async fetch(req: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (req.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(req, env, ctx);
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    // Reconcile first (re-drive stuck jobs, reap runner-less VMs), then the
    // age-only reaper as a coarse backstop. Sequential: both mutate the one
    // singleton Coordinator, so running them concurrently would race its rows.
    ctx.waitUntil(
      (async () => {
        await runReconciler(env);
        await runReaper(env);
      })(),
    );
  },
} satisfies ExportedHandler<Bindings>;
