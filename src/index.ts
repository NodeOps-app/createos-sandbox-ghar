import { Coordinator } from "./coordinator";
import { handleWebhook } from "./handler";
import { runReaper, runReconciler } from "./reconcile";

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
    if (url.pathname.startsWith("/admin/")) {
      const { handleAdmin } = await import("./admin");
      return handleAdmin(req, env);
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(
    _event: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Reconcile first (re-drive stuck jobs, reap runner-less VMs), then the
    // age-only reaper as a coarse backstop. Sequential: both mutate the one
    // singleton Coordinator, so running them concurrently would race its rows.
    // runReconciler guards its own per-job admission throws (see reconcile.ts),
    // but this catch is a belt-and-suspenders backstop for anything else that
    // slips past it — the reaper must run regardless, since its leaked-VM
    // cleanup has nothing to do with why the reconciler failed.
    ctx.waitUntil(
      (async () => {
        try {
          await runReconciler(env);
        } catch (err) {
          console.error(`scheduled: runReconciler failed: ${String(err)}`);
        }
        await runReaper(env);
      })(),
    );
  },
} satisfies ExportedHandler<Bindings>;
