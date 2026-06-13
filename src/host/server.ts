// Express host — Streamable HTTP MCP transport at /mcp, OAuth callback stub at /oauth/callback, /health.

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import "dotenv/config";
import express from "express";
import { db, ensureUp } from "./db.ts";
import { buildMcpServer } from "./mcp.ts";

const PORT = Number(process.env.PORT ?? 8788);

// One transport per session (per MCP Streamable HTTP semantics).
// Lives for the process lifetime; a long-running Node process is exactly what we want for this.
const transports = new Map<string, StreamableHTTPServerTransport>();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "crm-provisioner", phase: "P0", host: "express" });
});

app.get("/health/db", async (_req, res, next) => {
  try { await ensureUp(); res.json({ ok: true }); } catch (e) { next(e); }
});

// P0 OAuth callback stub — records a 'memory' connection. P3 replaces with the real exchange.
app.get("/oauth/callback", async (req, res) => {
  const connId = String(req.query.connection_id ?? crypto.randomUUID());
  await db.query(
    `insert into connections (id, crm, org_label) values ($1, 'memory', 'P0 stub connection')
       on conflict (id) do nothing`,
    [connId],
  );
  res.json({ ok: true, connection_id: connId, note: "P0 stub — no real OAuth exchange" });
});

// MCP — Streamable HTTP. Initialize creates a session; subsequent POSTs reuse it.
app.post("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id") ?? undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => { transports.set(id, transport!); },
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    const server = buildMcpServer();
    await server.connect(transport);
  } else if (!transport) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: missing or unknown session id (initialize first)" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /mcp + DELETE /mcp are used by Streamable HTTP for SSE notifications and session termination.
const reuseTransport: express.RequestHandler = async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("invalid or missing session id");
    return;
  }
  await transport.handleRequest(req, res);
};
app.get("/mcp", reuseTransport);
app.delete("/mcp", reuseTransport);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`crm-provisioner listening on :${PORT}`);
});
