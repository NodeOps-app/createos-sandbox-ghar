import { Coordinator } from "./coordinator";

export { Coordinator };

export interface Bindings {
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  [key: string]: unknown;
}

export default {
  async fetch(req: Request, _env: Bindings): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Bindings>;
