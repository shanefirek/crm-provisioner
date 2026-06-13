// Worker entry — serves the MCP transport and the (P2+) OAuth callback.
// P0: only /mcp is wired; /oauth/callback is a stub that records the connection.

import { ProvisionerMCP } from "./mcp.ts";

export { ProvisionerMCP };

// Env shape comes from `wrangler types` → worker-configuration.d.ts (global Cloudflare.Env).
type Env = Cloudflare.Env;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "crm-provisioner", phase: "P0" });
    }

    // OAuth callback stub — P0 records a "memory" connection per ?connection_id, no real exchange.
    if (url.pathname === "/oauth/callback") {
      const connId = url.searchParams.get("connection_id") || crypto.randomUUID();
      await env.DB.prepare(
        "insert or ignore into connections (id, crm, org_label) values (?1, 'memory', 'P0 stub connection')"
      ).bind(connId).run();
      return Response.json({ ok: true, connection_id: connId, note: "P0 stub — no real OAuth exchange" });
    }

    if (url.pathname.startsWith("/mcp")) {
      return ProvisionerMCP.serve("/mcp", { binding: "PROVISIONER_MCP" }).fetch(request, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
};
