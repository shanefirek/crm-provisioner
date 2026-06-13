// MCP server — 7 tools, same surface as the CF version. The pivot: McpAgent → plain Server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { memoryAdapter } from "../adapters/memory.ts";
import type { Adapter, ConnectionContext, Plan } from "../adapters/types.ts";
import { applyOverlay } from "../core/overlay.ts";
import { DeltaSpecSchema, ProvisionSpecSchema, type ProvisionSpec } from "../core/spec.ts";
import { getTemplate, listTemplates } from "../core/templates.ts";
import { db } from "./db.ts";

type CachedPlan = { plan: Plan; conn_id: string; spec: ProvisionSpec };
// In-process cache — survives requests because the server is long-running.
// (This is the "Railway just works" bit we noted in the P0 retro.)
const PLAN_CACHE = new Map<string, CachedPlan>();

function adapterFor(_crm: string): Adapter {
  // P0: all connections route to the memory stub. P2/P3 dispatch by `crm`.
  return memoryAdapter;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const trace = () => crypto.randomUUID();

async function loadConn(id: string): Promise<(ConnectionContext & { crm: string }) | null> {
  const { rows } = await db.query(
    `select id, crm, api_domain, refresh_token, access_token, access_expires
       from connections where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

function validateAndResolve(
  template_ref: string,
  delta: unknown,
):
  | { ok: true; spec: ProvisionSpec; spec_hash: string; template: string }
  | { ok: false; error: string; details?: unknown } {
  const template = getTemplate(template_ref);
  if (!template) {
    return { ok: false, error: "TEMPLATE_NOT_FOUND", details: { template_ref, available: listTemplates() } };
  }
  const parsed = DeltaSpecSchema.safeParse(delta);
  if (!parsed.success) {
    return { ok: false, error: "DELTA_SCHEMA_INVALID", details: parsed.error.issues };
  }
  const overlay = applyOverlay(template, parsed.data);
  if (!overlay.ok) {
    return { ok: false, error: "EXTENSION_POINT_VIOLATION", details: overlay.errors };
  }
  const final = ProvisionSpecSchema.safeParse(overlay.spec);
  if (!final.success) {
    return { ok: false, error: "RESOLVED_SPEC_INVALID", details: final.error.issues };
  }
  return { ok: true, spec: final.data, spec_hash: overlay.spec_hash, template: `${template.id}@${template.version}` };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "crm-provisioner", version: "0.0.0-P0" });

  // 1. list_templates
  server.registerTool(
    "list_templates",
    {
      description:
        "List available templates. Each entry has id, version, and description. Use list_templates output to choose a base template before authoring a delta against its declared extension points.",
      inputSchema: {},
    },
    async () => ok(JSON.stringify({ templates: listTemplates() }, null, 2)),
  );

  // 2. connect_crm
  server.registerTool(
    "connect_crm",
    {
      description:
        "Register a connection to a CRM instance. P0: creates a 'memory' stub connection (no OAuth). Returns connection_id to pass to every other tool.",
      inputSchema: {
        crm: z.enum(["memory", "salesforce", "zoho"]).default("memory"),
        org_label: z.string().optional(),
      },
    },
    async ({ crm, org_label }) => {
      const id = crypto.randomUUID();
      await db.query(
        `insert into connections (id, crm, org_label) values ($1, $2, $3)`,
        [id, crm, org_label ?? `${crm} P0 stub`],
      );
      return ok(JSON.stringify({ connection_id: id, crm }, null, 2));
    },
  );

  // 3. inspect_instance
  server.registerTool(
    "inspect_instance",
    {
      description:
        "Read the current state of the connected CRM scoped to the spec's vocabulary (fields, stages, pipelines, workflows). The model uses this to ground the delta it authors.",
      inputSchema: { connection_id: z.string() },
    },
    async ({ connection_id }) => {
      const conn = await loadConn(connection_id);
      if (!conn) return ok(JSON.stringify({ error: "CONNECTION_NOT_FOUND", connection_id }));
      const adapter = adapterFor(conn.crm);
      const { snapshot } = await adapter.inspect(conn);
      return ok(JSON.stringify({ connection_id, crm: conn.crm, snapshot }, null, 2));
    },
  );

  // 4. validate_spec
  server.registerTool(
    "validate_spec",
    {
      description:
        "Validate a delta against the schema AND the template's declared extension points. Returns either ok=true with the resolved effective spec, or ok=false with instructive errors naming the path and required next step.",
      inputSchema: {
        template_ref: z.string().describe("e.g. 'toy-sales@v0' or 'toy-sales'"),
        delta: z.unknown(),
      },
    },
    async ({ template_ref, delta }) => ok(JSON.stringify(validateAndResolve(template_ref, delta), null, 2)),
  );

  // 5. plan
  server.registerTool(
    "plan",
    {
      description:
        "Validate (template + delta), inspect the connected instance, and compute the diff: create / update / noop / unsupported per step. Returns a plan_id that apply() requires. Nothing is written.",
      inputSchema: {
        connection_id: z.string(),
        template_ref: z.string(),
        delta: z.unknown(),
      },
    },
    async ({ connection_id, template_ref, delta }) => {
      const validated = validateAndResolve(template_ref, delta);
      if (!validated.ok) return ok(JSON.stringify(validated, null, 2));
      const conn = await loadConn(connection_id);
      if (!conn) return ok(JSON.stringify({ ok: false, error: "CONNECTION_NOT_FOUND", connection_id }));
      const adapter = adapterFor(conn.crm);
      const { snapshot } = await adapter.inspect(conn);
      const plan = await adapter.plan(conn, validated.spec, snapshot);
      plan.spec_hash = validated.spec_hash;
      const plan_id = `plan_${crypto.randomUUID()}`;
      PLAN_CACHE.set(plan_id, { plan, conn_id: conn.id, spec: validated.spec });
      return ok(
        JSON.stringify(
          {
            ok: true,
            plan_id,
            connection_id: conn.id,
            spec_hash: plan.spec_hash,
            steps: plan.steps,
            unsupported_count: plan.unsupported_count,
            next: "Pass plan_id to apply() to execute. Plans are cached in-process for the lifetime of the server.",
          },
          null,
          2,
        ),
      );
    },
  );

  // 6. apply
  server.registerTool(
    "apply",
    {
      description:
        "Execute a previously-computed plan. Gated on a valid plan_id. Records a run + per-step rows in Postgres. Returns the run_id; poll with get_run.",
      inputSchema: { plan_id: z.string() },
    },
    async ({ plan_id }) => {
      const cached = PLAN_CACHE.get(plan_id);
      if (!cached) {
        return ok(
          JSON.stringify({
            ok: false,
            error: "PLAN_NOT_FOUND",
            message:
              "plan_id not in cache. Call plan() first, then pass its plan_id directly to apply(). Plans live for the lifetime of the server process.",
          }),
        );
      }
      const conn = await loadConn(cached.conn_id);
      if (!conn) return ok(JSON.stringify({ ok: false, error: "CONNECTION_NOT_FOUND" }));

      const run_id = `run_${crypto.randomUUID()}`;
      const trace_id = trace();
      const [tplId, tplVer] = (cached.spec.extends ?? "@").split("@");

      const client = await db.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into runs (id, connection_id, spec_hash, template_id, template_version, status, plan_json, trace_id)
             values ($1, $2, $3, $4, $5, 'running', $6::jsonb, $7)`,
          [run_id, conn.id, cached.plan.spec_hash, tplId || null, tplVer || null, JSON.stringify(cached.plan), trace_id],
        );

        const stepWrites: Array<Promise<unknown>> = [];
        const adapter = adapterFor(conn.crm);
        const result = await adapter.apply(conn, cached.plan, (step) => {
          const planStep = cached.plan.steps[step.seq - 1];
          stepWrites.push(
            client.query(
              `insert into run_steps (run_id, seq, operation, target, payload_json, status, result_json, error_code, error_message, started_at, finished_at)
                 values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, extract(epoch from now())::integer, extract(epoch from now())::integer)`,
              [
                run_id,
                step.seq,
                planStep?.operation ?? "unknown",
                planStep?.target ?? null,
                JSON.stringify(planStep?.payload ?? null),
                step.status,
                step.result ? JSON.stringify(step.result) : null,
                step.error?.code ?? null,
                step.error?.message ?? null,
              ],
            ),
          );
        });
        await Promise.all(stepWrites);

        await client.query(
          `update runs set status = $1, finished_at = extract(epoch from now())::integer where id = $2`,
          [result.status, run_id],
        );
        await client.query("commit");

        PLAN_CACHE.delete(plan_id);

        return ok(
          JSON.stringify({ ok: true, run_id, trace_id, status: result.status, step_count: result.steps.length }, null, 2),
        );
      } catch (e) {
        await client.query("rollback");
        return ok(JSON.stringify({ ok: false, error: "APPLY_FAILED", message: String(e) }));
      } finally {
        client.release();
      }
    },
  );

  // 7. get_run
  server.registerTool(
    "get_run",
    {
      description:
        "Read a run by id, with all its steps in order. Use to verify apply results and to resume a partial run later.",
      inputSchema: { run_id: z.string() },
    },
    async ({ run_id }) => {
      const r = await db.query(
        `select id, connection_id, spec_hash, template_id, template_version, status, trace_id, started_at, finished_at
           from runs where id = $1`,
        [run_id],
      );
      if (!r.rows.length) return ok(JSON.stringify({ ok: false, error: "RUN_NOT_FOUND", run_id }));
      const run = r.rows[0];
      const s = await db.query(
        `select seq, operation, target, status, result_json, error_code, error_message
           from run_steps where run_id = $1 order by seq`,
        [run_id],
      );
      return ok(
        JSON.stringify(
          {
            ok: true,
            run: {
              id: run.id,
              status: run.status,
              trace_id: run.trace_id,
              connection_id: run.connection_id,
              spec_hash: run.spec_hash,
              template: run.template_id ? `${run.template_id}@${run.template_version}` : null,
              started_at: run.started_at,
              finished_at: run.finished_at,
            },
            steps: s.rows,
          },
          null,
          2,
        ),
      );
    },
  );

  return server;
}
