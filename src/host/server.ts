// Express host — Streamable HTTP MCP transport at /mcp, OAuth callback stub at /oauth/callback, /health.

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import "dotenv/config";
import express from "express";
import { db, ensureUp } from "./db.ts";
import { buildMcpServer } from "./mcp.ts";

const PORT = Number(process.env.PORT ?? 8788);

// P14 + P17 fix #3: fail-at-boot if TOKEN_AT_REST_KEY is missing OR clearly wrong-shaped.
// Decrypting connection secrets requires the key; the server refuses to start rather than
// silently brick every existing connection. Layers (cheap → expensive):
//   1. presence + non-whitespace (P14 original)
//   2. minimum length 32 chars (catches `TOKEN_AT_REST_KEY=x` / typo / Railway-secret-fell-back-to-empty)
//   3. base64-only charset (catches non-base64 keys; also closes the smoke heredoc
//      shell-expansion concern from the review — strict base64 has no shell-special chars)
//   4. pgcrypto round-trip self-test (catches malformed key, missing extension, etc.)
//      — runs lazily after server.listen so DB is available; exits 1 on failure.
const k = process.env.TOKEN_AT_REST_KEY;
if (!k || !k.trim()) {
  console.error(
    "FATAL: TOKEN_AT_REST_KEY env var is required (used to encrypt connections.refresh_token at rest).\n" +
      "       For local dev: add to .dev.vars (gitignored). For production: set via Railway env vars.\n" +
      "       See docs/decision-log.md for the KMS-wrap upgrade path.",
  );
  process.exit(1);
}
if (k.length < 32) {
  console.error(`FATAL: TOKEN_AT_REST_KEY is too short (${k.length} chars; minimum 32). Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
  process.exit(1);
}
if (!/^[A-Za-z0-9+/=]+$/.test(k)) {
  console.error("FATAL: TOKEN_AT_REST_KEY contains non-base64 characters. Strict base64 (A-Z, a-z, 0-9, +, /, =) is required for safe shell/SQL interpolation. Generate a fresh one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
  process.exit(1);
}

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

app.listen(PORT, async () => {
  // eslint-disable-next-line no-console
  console.log(`crm-provisioner listening on :${PORT}`);

  // P17 fix #3: pgcrypto round-trip self-test. Encrypts a known marker with the
  // env key, decrypts it, asserts equality. Catches malformed key, missing pgcrypto
  // extension, wrong-version-pgcrypto, DB connection broken. Failure here is the
  // same "every connect_crm/apply 500s" failure mode that was untraceable pre-P17 —
  // surface it loudly at boot instead.
  try {
    const r = await db.query(
      `select pgp_sym_decrypt(pgp_sym_encrypt('boot-self-test', $1::text), $1::text)::text as roundtrip`,
      [process.env.TOKEN_AT_REST_KEY],
    );
    if (r.rows[0]?.roundtrip !== "boot-self-test") {
      throw new Error(`pgcrypto round-trip mismatch: got '${r.rows[0]?.roundtrip}'`);
    }
    // eslint-disable-next-line no-console
    console.log("✓ pgcrypto round-trip self-test passed (TOKEN_AT_REST_KEY usable)");
  } catch (e) {
    console.error(
      "FATAL: pgcrypto round-trip self-test failed at boot. Likely causes:\n" +
        "  - TOKEN_AT_REST_KEY is malformed (despite passing format checks)\n" +
        "  - pgcrypto extension is missing in this database\n" +
        "  - DB connection is broken\n" +
        `Error: ${String(e)}`,
    );
    process.exit(1);
  }
});
