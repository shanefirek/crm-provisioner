// The Durable-Object-backed MCP server. 7 tools, all wired end-to-end against
// the memory stub adapter. Real adapters slot in at P2/P3.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { memoryAdapter } from "../adapters/memory.ts";
import type { Adapter, ConnectionContext, Plan } from "../adapters/types.ts";
import { applyOverlay, stableHash } from "../core/overlay.ts";
import { DeltaSpecSchema, ProvisionSpecSchema, type ProvisionSpec } from "../core/spec.ts";
import { getTemplate, listTemplates } from "../core/templates.ts";

type Env = Cloudflare.Env;

// Tiny in-memory plan cache, scoped to the DO instance.
// apply() requires a plan_id minted by plan() — Terraform-style two-step.
type CachedPlan = { plan: Plan; conn_id: string; spec: ProvisionSpec };
const PLAN_CACHE = new Map<string, CachedPlan>();

function adapterFor(_crm: string): Adapter {
  // P0: every connection routes to the memory stub. P2/P3 dispatch by `crm`.
  return memoryAdapter;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function trace(): string {
  return crypto.randomUUID();
}

export class ProvisionerMCP extends McpAgent<Env, Record<string, never>, {}> {
  server = new McpServer({ name: "crm-provisioner", version: "0.0.0-P0" });

  async init() {
    // ---------- 1. list_templates ----------
    this.server.registerTool(
      "list_templates",
      {
        description:
          "List available templates. Each entry has id, version, and description. Use get_template (via list_templates output) to inspect base + extension points before authoring a delta.",
        inputSchema: {},
      },
      async () => ok(JSON.stringify({ templates: listTemplates() }, null, 2)),
    );

    // ---------- 2. connect_crm ----------
    this.server.registerTool(
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
        await this.env.DB.prepare(
          "insert into connections (id, crm, org_label) values (?1, ?2, ?3)",
        )
          .bind(id, crm, org_label ?? `${crm} P0 stub`)
          .run();
        return ok(JSON.stringify({ connection_id: id, crm }, null, 2));
      },
    );

    // ---------- 3. inspect_instance ----------
    this.server.registerTool(
      "inspect_instance",
      {
        description:
          "Read the current state of the connected CRM scoped to the spec's vocabulary (fields, stages, pipelines, workflows). The model uses this to ground the delta it authors.",
        inputSchema: { connection_id: z.string() },
      },
      async ({ connection_id }) => {
        const conn = await this.loadConn(connection_id);
        if (!conn) return ok(JSON.stringify({ error: "CONNECTION_NOT_FOUND", connection_id }));
        const adapter = adapterFor(conn.crm);
        const { snapshot } = await adapter.inspect(conn);
        return ok(JSON.stringify({ connection_id, crm: conn.crm, snapshot }, null, 2));
      },
    );

    // ---------- 4. validate_spec ----------
    this.server.registerTool(
      "validate_spec",
      {
        description:
          "Validate a delta against the schema AND the template's declared extension points. Returns either ok=true with the resolved effective spec, or ok=false with instructive errors naming the path and required next step.",
        inputSchema: {
          template_ref: z.string().describe("e.g. 'toy-sales@v0' or 'toy-sales'"),
          delta: z.unknown(),
        },
      },
      async ({ template_ref, delta }) => {
        const result = validateAndResolve(template_ref, delta);
        return ok(JSON.stringify(result, null, 2));
      },
    );

    // ---------- 5. plan ----------
    this.server.registerTool(
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
        const conn = await this.loadConn(connection_id);
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
              next: "Pass plan_id to apply() to execute. Plan is cached only on this DO instance.",
            },
            null,
            2,
          ),
        );
      },
    );

    // ---------- 6. apply ----------
    this.server.registerTool(
      "apply",
      {
        description:
          "Execute a previously-computed plan. Gated on a valid plan_id. Records a run + per-step rows in D1. Returns the run_id; poll with get_run.",
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
                "plan_id not in cache. Call plan() first, then pass its plan_id directly to apply(). Plans live only for the lifetime of the DO instance.",
            }),
          );
        }
        const conn = await this.loadConn(cached.conn_id);
        if (!conn) return ok(JSON.stringify({ ok: false, error: "CONNECTION_NOT_FOUND" }));

        const run_id = `run_${crypto.randomUUID()}`;
        const trace_id = trace();
        await this.env.DB.prepare(
          "insert into runs (id, connection_id, spec_hash, template_id, template_version, status, plan_json, trace_id) values (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7)",
        )
          .bind(
            run_id,
            conn.id,
            cached.plan.spec_hash,
            cached.spec.extends?.split("@")[0] ?? null,
            cached.spec.extends?.split("@")[1] ?? null,
            JSON.stringify(cached.plan),
            trace_id,
          )
          .run();

        const adapter = adapterFor(conn.crm);
        const stepStatements: D1PreparedStatement[] = [];
        const result = await adapter.apply(conn, cached.plan, (step) => {
          stepStatements.push(
            this.env.DB.prepare(
              "insert into run_steps (run_id, seq, operation, target, payload_json, status, result_json, error_code, error_message, started_at, finished_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, unixepoch(), unixepoch())",
            ).bind(
              run_id,
              step.seq,
              cached.plan.steps[step.seq - 1]?.operation ?? "unknown",
              cached.plan.steps[step.seq - 1]?.target ?? null,
              JSON.stringify(cached.plan.steps[step.seq - 1]?.payload ?? null),
              step.status,
              step.result ? JSON.stringify(step.result) : null,
              step.error?.code ?? null,
              step.error?.message ?? null,
            ),
          );
        });
        if (stepStatements.length) await this.env.DB.batch(stepStatements);

        await this.env.DB.prepare(
          "update runs set status = ?1, finished_at = unixepoch() where id = ?2",
        )
          .bind(result.status, run_id)
          .run();

        PLAN_CACHE.delete(plan_id);

        return ok(
          JSON.stringify(
            { ok: true, run_id, trace_id, status: result.status, step_count: result.steps.length },
            null,
            2,
          ),
        );
      },
    );

    // ---------- 7. get_run ----------
    this.server.registerTool(
      "get_run",
      {
        description: "Read a run by id, with all its steps in order. Use to verify apply results and to resume a partial run later.",
        inputSchema: { run_id: z.string() },
      },
      async ({ run_id }) => {
        const run = await this.env.DB.prepare("select * from runs where id = ?1").bind(run_id).first();
        if (!run) return ok(JSON.stringify({ ok: false, error: "RUN_NOT_FOUND", run_id }));
        const steps = await this.env.DB.prepare(
          "select seq, operation, target, status, result_json, error_code, error_message from run_steps where run_id = ?1 order by seq",
        )
          .bind(run_id)
          .all();
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
                template: run.template_id && `${run.template_id}@${run.template_version}`,
                started_at: run.started_at,
                finished_at: run.finished_at,
              },
              steps: steps.results,
            },
            null,
            2,
          ),
        );
      },
    );
  }

  private async loadConn(id: string): Promise<ConnectionContext & { crm: string } | null> {
    const row = (await this.env.DB.prepare("select * from connections where id = ?1").bind(id).first()) as {
      id: string;
      crm: string;
      api_domain?: string;
      refresh_token?: string;
      access_token?: string;
      access_expires?: number;
    } | null;
    if (!row) return null;
    return row;
  }
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
  // Defense-in-depth: re-validate the resolved spec.
  const final = ProvisionSpecSchema.safeParse(overlay.spec);
  if (!final.success) {
    return { ok: false, error: "RESOLVED_SPEC_INVALID", details: final.error.issues };
  }
  return { ok: true, spec: final.data, spec_hash: overlay.spec_hash, template: `${template.id}@${template.version}` };
}
