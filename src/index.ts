import { Coordinator } from "./coordinator";
import { handleWebhook, runReaper } from "./handler";

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
    ctx.waitUntil(runReaper(env));
  },
} satisfies ExportedHandler<Bindings>;
