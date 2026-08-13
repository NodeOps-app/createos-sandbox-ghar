import { Coordinator } from "./coordinator";
import { handleWebhook } from "./handler";
import { runReaper, runReconciler } from "./reconcile";

export { Coordinator };

export interface Bindings {
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  /**
   * Which code is actually live. Optional because the test runtime does not
   * provide it — see the `/version` route.
   */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  [key: string]: unknown;
}

export default {
  async fetch(req: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    // Which version is serving right now. A push to `main` deploys via Workers
    // Builds, which lands ~30-45s AFTER the push — while a smoke job gets a
    // runner in ~5s. So `ghar-test` would provision against the PREVIOUS
    // version and report on code that was never tested. Its wait-for-deploy
    // gate polls this route until `timestamp` passes the push, which is the
    // only thing that makes the smoke a statement about the pushed commit.
    // Unauthenticated on purpose: it is the deploy's own liveness signal, it
    // exposes nothing but a version id, and requiring a token would put a
    // Cloudflare credential in the smoke workflow to learn a public fact.
    if (req.method === "GET" && url.pathname === "/version") {
      const v = env.CF_VERSION_METADATA;
      return Response.json(
        v ? { id: v.id, tag: v.tag, timestamp: v.timestamp } : { error: "no version binding" },
        { status: v ? 200 : 503 },
      );
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
