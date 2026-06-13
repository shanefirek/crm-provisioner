// MCP server — 8 tools, hardening rules enforced at the boundary.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { memoryAdapter } from "../adapters/memory.ts";
import { salesforceAdapter } from "../adapters/salesforce.ts";
import { zohoAdapter } from "../adapters/zoho.ts";
import type { Adapter, ConnectionContext, Plan, RunStepRecord } from "../adapters/types.ts";
import { applyOverlay } from "../core/overlay.ts";
import { DeltaSpecSchema, ProvisionSpecSchema, type ProvisionSpec } from "../core/spec.ts";
import { getTemplate, listTemplates } from "../core/templates.ts";
import { db } from "./db.ts";

type CachedPlan = { plan: Plan; conn_id: string; spec: ProvisionSpec };
const PLAN_CACHE = new Map<string, CachedPlan>();

function adapterFor(crm: string): Adapter {
  if (crm === "salesforce") return salesforceAdapter;
  if (crm === "zoho") return zohoAdapter;
  return memoryAdapter;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const trace = () => crypto.randomUUID();

async function loadConn(id: string): Promise<ConnectionContext | null> {
  const { rows } = await db.query(
    `select id, crm, dc, api_domain, is_demo, writable_org_ids, refresh_token, access_token, access_expires
       from connections where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// Hardening rule 1+2: refuse writes unless connection is_demo AND target org is on the allowlist.
// Returns null when writable; otherwise an error envelope to surface to the caller.
function writableCheck(conn: ConnectionContext): { error: string; message: string } | null {
  if (!conn.is_demo) {
    return {
      error: "CONNECTION_NOT_WRITABLE",
      message:
        "this connection is not marked as a demo (is_demo=false). MVP refuses to write to non-demo connections — recreate the connection with is_demo=true and a writable_org_ids allowlist.",
    };
  }
  if (conn.writable_org_ids.length > 0 && conn.api_domain && !conn.writable_org_ids.includes(conn.api_domain)) {
    return {
      error: "ORG_NOT_ON_ALLOWLIST",
      message: `this connection's api_domain (${conn.api_domain}) is not in the writable_org_ids allowlist (${conn.writable_org_ids.join(", ")}). Refusing to write.`,
    };
  }
  return null;
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
  const server = new McpServer({ name: "crm-provisioner", version: "0.1.0-P1" });

  // 1. list_templates
  server.registerTool(
    "list_templates",
    {
      description:
        "List available templates. Each entry has id, version, description. Templates are versioned data files; the LLM never authors a whole template — it authors a DELTA against one. Current registry: toy-sales@v0 (smoke), real-estate@v1, professional-services@v1, hvac-services@v1, manufacturing@v1. All four verticals share the same extension-point set (fields/stages/pipelines/pipelines[].stages/workflows are appendable; the base is never replaced). Read each template's `extension_points` array before authoring — deltas that touch undeclared paths are REJECTED by validate_spec.",
      inputSchema: {},
    },
    async () => ok(JSON.stringify({ templates: listTemplates() }, null, 2)),
  );

  // 2. connect_crm — hardening: requires is_demo + writable_org_ids
  server.registerTool(
    "connect_crm",
    {
      description:
        "Register a connection to a CRM instance. MVP HARDENING (enforced by apply()): every connection must declare is_demo=true to be writable, AND api_domain must appear in writable_org_ids — non-demo connections are READ-ONLY via inspect_instance, never writable. CRM-specific args: for 'salesforce', P2 reads auth from local `sf` CLI chain (~/.sfdx/{user}.json — token is CLI-encrypted, NEVER from `sf org display`-emitted stdout); for 'zoho', pass refresh_token + dc ('com'|'eu'|'in'|'com.au'). Three crm values: 'memory' (stub, ALL ops supported, in-process state), 'salesforce' (live; see capability map), 'zoho' (live; see capability map). Returns connection_id used by every other tool.",
      inputSchema: {
        crm: z.enum(["memory", "salesforce", "zoho"]).default("memory"),
        org_label: z.string().optional(),
        is_demo: z.boolean().default(true).describe("MVP hard gate — false connections are READ-only via inspect_instance, never writable"),
        writable_org_ids: z
          .array(z.string())
          .default([])
          .describe("Allowlist of api_domain values this connection may write to. Empty array = allow any (demo only)."),
        api_domain: z.string().optional().describe("The CRM instance URL / API domain; checked against writable_org_ids on apply()"),
        access_token: z.string().optional().describe("P2 dev only — paste an existing token. P3 host work replaces with OAuth callback."),
        refresh_token: z.string().optional().describe("Zoho: required for the adapter to mint access tokens from the refresh_token grant."),
        dc: z.string().optional().describe("Zoho only — datacenter ('com' | 'eu' | 'in' | 'com.au'). Determines accounts.zoho.{dc} host for OAuth refresh."),
      },
    },
    async ({ crm, org_label, is_demo, writable_org_ids, api_domain, access_token, refresh_token, dc }) => {
      const id = crypto.randomUUID();
      await db.query(
        `insert into connections (id, crm, org_label, is_demo, writable_org_ids, api_domain, access_token, refresh_token, dc)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, crm, org_label ?? `${crm} connection`, is_demo, writable_org_ids, api_domain ?? null, access_token ?? null, refresh_token ?? null, dc ?? null],
      );
      return ok(JSON.stringify({ connection_id: id, crm, is_demo, writable_org_ids, api_domain: api_domain ?? null, dc: dc ?? null }, null, 2));
    },
  );

  // 3. inspect_instance
  server.registerTool(
    "inspect_instance",
    {
      description:
        "Read the current state of the connected CRM scoped to the spec's vocabulary (fields, stages, pipelines, workflows). ALWAYS SAFE — never writes, hardening rules don't apply. The model SHOULD call this before authoring a delta to ground its choices in the org's actual current state (avoids creating fields that already exist with a different name, choosing stage forecast_categories the org doesn't have, etc.). Snapshot shape is CRM-specific: SFDC returns `fields_lead` + `stages` + `flows`; Zoho returns `fields_lead` + `stages` (with id/probability/forecast_category) + `pipelines` + `stage_field_id` + `default_deals_layout_id`; memory returns the in-process state.",
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
        "Validate a delta against TWO gates before any planning: (1) zod schema (.strict() — unknown keys REJECTED, not silently dropped); (2) the template's declared extension points (delta touching an undeclared path rejected). Returns ok=true with the resolved effective spec_hash, or ok=false with instructive errors naming the json_path and what's required. Use this BEFORE plan() to catch authoring errors without needing a connection. Never writes anywhere.",
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
        "Validate (template + delta), inspect the live CRM, and compute the diff per step: 'create' | 'update' | 'noop' | 'unsupported'. Each step also carries `destructive: bool` (true when reverse is lossy — e.g. SFDC stage deactivate-not-delete) and optional `notes` (e.g. round_robin_assignment in Zoho is 'manual' — note tells the human to paste the canonical Deluge script once in UI). Output includes `unsupported_count` and `destructive_count`. Returns a plan_id (single-use, in-process cache only — re-plan if the server restarts). Nothing is written. Per-CRM adapter knowledge the model should KNOW when authoring deltas: SFDC fields require a paired permset for FLS (handled automatically by the adapter); SFDC stages deactivate-not-delete (residue persists); Zoho fields are visible-by-default; Zoho stages use whole-array-replace semantics (adapter handles the merge); Zoho underscores in stage api_names normalize to spaces (Lead_In → Lead In, adapter normalizes lookups). Workflow shapes: idle_deal_alert (SFDC Flow + Zoho workflow_rule+task; both create supported) / field_derivation (both supported) / round_robin_assignment (SFDC stub Flow, Zoho MANUAL with Deluge instructions in the note).",
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
      // Re-derive counts at the host boundary (defense-in-depth — adapters MUST set, host VERIFIES).
      plan.unsupported_count = plan.steps.filter((s) => s.diff === "unsupported").length;
      plan.destructive_count = plan.steps.filter((s) => s.destructive).length;

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
            destructive_count: plan.destructive_count,
            next:
              plan.destructive_count > 0
                ? "Plan contains destructive operations. Pass confirm_destructive:true to apply()."
                : "Pass plan_id to apply() to execute. Plans are cached in-process for the lifetime of the server.",
          },
          null,
          2,
        ),
      );
    },
  );

  // 6. apply — hardening: refuses non-demo connections; requires confirm_destructive when needed
  server.registerTool(
    "apply",
    {
      description:
        "Execute a previously-computed plan. THREE GATES, all checked at the boundary, in order: (1) plan_id must be in cache → else PLAN_NOT_FOUND; (2) connection must be is_demo=true AND api_domain on writable_org_ids → else CONNECTION_NOT_WRITABLE / ORG_NOT_ON_ALLOWLIST; (3) if plan.destructive_count > 0, caller must pass confirm_destructive:true → else DESTRUCTIVE_NOT_CONFIRMED. Records a run + per-step rows + trace_id in Postgres. Returns {run_id, trace_id, status, step_count}. Status 'partial' means at least one step failed — use get_run to see which. SFDC apply is multi-step async (metadata deploys take ~10-30s); Zoho apply is REST-fast but batches stages into one PATCH for whole-array-replace semantics.",
      inputSchema: {
        plan_id: z.string(),
        confirm_destructive: z.boolean().default(false).describe("Must be true when the plan has destructive_count > 0"),
      },
    },
    async ({ plan_id, confirm_destructive }) => {
      const cached = PLAN_CACHE.get(plan_id);
      if (!cached) {
        return ok(
          JSON.stringify({
            ok: false,
            error: "PLAN_NOT_FOUND",
            message: "plan_id not in cache. Call plan() first, then pass its plan_id directly to apply().",
          }),
        );
      }
      const conn = await loadConn(cached.conn_id);
      if (!conn) return ok(JSON.stringify({ ok: false, error: "CONNECTION_NOT_FOUND" }));

      // Hardening rule 1+2: writability check
      const blocked = writableCheck(conn);
      if (blocked) return ok(JSON.stringify({ ok: false, ...blocked }));

      // Hardening rule 3: destructive confirmation
      if (cached.plan.destructive_count > 0 && !confirm_destructive) {
        return ok(
          JSON.stringify({
            ok: false,
            error: "DESTRUCTIVE_NOT_CONFIRMED",
            destructive_count: cached.plan.destructive_count,
            message: `plan contains ${cached.plan.destructive_count} destructive step(s). Re-call apply() with confirm_destructive:true to proceed.`,
          }),
        );
      }

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
              `insert into run_steps (run_id, seq, operation, target, payload_json, status, result_json, error_code, error_message, destructive, started_at, finished_at)
                 values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, extract(epoch from now())::integer, extract(epoch from now())::integer)`,
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
                planStep?.destructive ?? false,
              ],
            ),
          );
        });
        await Promise.all(stepWrites);

        await client.query(`update runs set status = $1, finished_at = extract(epoch from now())::integer where id = $2`, [result.status, run_id]);
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
        "Read a run by id with all its steps in order. Returns {run: {id, status, trace_id, connection_id, spec_hash, template, teardown_of_run, started_at, finished_at}, steps: [{seq, operation, target, status, result_json, error_code, error_message, destructive}]}. Step status: 'succeeded' | 'failed' | 'skipped_unsupported'. Errors are typed (per the adapter's error-class) — e.g. Zoho returns 'DEPENDENT_MISMATCH' / 'INVALID_DATA' / 'REQUIRED_DATA_NOT_FOUND' with helpful json_path + value pointers, which the LLM can use to re-author the delta. Use this to verify apply results, diagnose partial runs, OR confirm what a teardown_run reversed.",
      inputSchema: { run_id: z.string() },
    },
    async ({ run_id }) => {
      const r = await db.query(
        `select id, connection_id, spec_hash, template_id, template_version, status, trace_id, started_at, finished_at, teardown_of_run
           from runs where id = $1`,
        [run_id],
      );
      if (!r.rows.length) return ok(JSON.stringify({ ok: false, error: "RUN_NOT_FOUND", run_id }));
      const run = r.rows[0];
      const s = await db.query(
        `select seq, operation, target, payload_json, status, result_json, error_code, error_message, destructive
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
              teardown_of_run: run.teardown_of_run,
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

  // 8. teardown_run — reverses a prior run's successful steps; demo-only by the same writability gate
  server.registerTool(
    "teardown_run",
    {
      description:
        "Reverse the successful steps of a previous run, newest-first. Idempotent — already-absent resources count as success. Requires the original run's connection to still satisfy the writability gate (is_demo + allowlist). Records a NEW run row with teardown_of_run linking back to the original. Per-CRM teardown semantics that callers should expect (some leave residue, honestly recorded): SFDC create_field is reversed via destructiveChanges deploy (clean); SFDC add_stage records 'stage_deactivated_only' (SFDC deactivate-not-delete); Zoho create_field is reversed via DELETE (clean); Zoho add_stage records 'stage_picklist_value_remains' (whole-array PATCH-only); Zoho create_pipeline records 'pipeline_remains_in_layout_residue' (S0 found DELETE returns 400). Use after every demo to leave the org clean for the next session — but check the residue notes in the response.",
      inputSchema: { run_id: z.string() },
    },
    async ({ run_id }) => {
      const origRun = await db.query(`select id, connection_id from runs where id = $1`, [run_id]);
      if (!origRun.rows.length) return ok(JSON.stringify({ ok: false, error: "RUN_NOT_FOUND", run_id }));
      const conn = await loadConn(origRun.rows[0].connection_id);
      if (!conn) return ok(JSON.stringify({ ok: false, error: "CONNECTION_NOT_FOUND" }));

      const blocked = writableCheck(conn);
      if (blocked) return ok(JSON.stringify({ ok: false, ...blocked }));

      const steps = await db.query(
        `select seq, operation, target, payload_json, result_json, status
           from run_steps where run_id = $1 order by seq`,
        [run_id],
      );
      const history: RunStepRecord[] = steps.rows.map((r) => ({
        seq: r.seq,
        operation: r.operation,
        target: r.target,
        payload: r.payload_json,
        result: r.result_json,
        status: r.status,
      }));

      const teardown_id = `run_${crypto.randomUUID()}`;
      const trace_id = trace();

      const client = await db.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into runs (id, connection_id, spec_hash, template_id, template_version, status, plan_json, trace_id, teardown_of_run)
             values ($1, $2, '', null, null, 'running', $3::jsonb, $4, $5)`,
          [teardown_id, conn.id, JSON.stringify({ teardown_of: run_id }), trace_id, run_id],
        );

        const adapter = adapterFor(conn.crm);
        const writes: Array<Promise<unknown>> = [];
        const result = await adapter.teardown(conn, history, (step) => {
          writes.push(
            client.query(
              `insert into run_steps (run_id, seq, operation, target, payload_json, status, result_json, error_code, error_message, destructive, started_at, finished_at)
                 values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, false, extract(epoch from now())::integer, extract(epoch from now())::integer)`,
              [
                teardown_id,
                step.seq,
                `teardown:${history.find((h) => h.seq === step.seq)?.operation ?? "unknown"}`,
                history.find((h) => h.seq === step.seq)?.target ?? null,
                JSON.stringify(history.find((h) => h.seq === step.seq)?.payload ?? null),
                step.status,
                step.result ? JSON.stringify(step.result) : null,
                step.error?.code ?? null,
                step.error?.message ?? null,
              ],
            ),
          );
        });
        await Promise.all(writes);

        await client.query(`update runs set status = $1, finished_at = extract(epoch from now())::integer where id = $2`, [result.status, teardown_id]);
        await client.query("commit");

        return ok(
          JSON.stringify(
            {
              ok: true,
              teardown_run_id: teardown_id,
              of_run: run_id,
              trace_id,
              status: result.status,
              reversed_steps: result.steps.length,
            },
            null,
            2,
          ),
        );
      } catch (e) {
        await client.query("rollback");
        return ok(JSON.stringify({ ok: false, error: "TEARDOWN_FAILED", message: String(e) }));
      } finally {
        client.release();
      }
    },
  );

  return server;
}
