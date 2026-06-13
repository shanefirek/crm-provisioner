// Postgres pool — module-singleton so the host and MCP layer share one pool.
// DATABASE_URL is the convention Railway sets automatically; .env.local for dev.

import pg from "pg";

const url =
  process.env.DATABASE_URL ||
  "postgres://crm:crm@127.0.0.1:5433/crm_provisioner";

export const db = new pg.Pool({
  connectionString: url,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function ensureUp(): Promise<void> {
  // Cheap connectivity check, used by /health.
  const { rows } = await db.query<{ ok: number }>("select 1 as ok");
  if (rows[0]?.ok !== 1) throw new Error("db: unexpected select 1 result");
}
