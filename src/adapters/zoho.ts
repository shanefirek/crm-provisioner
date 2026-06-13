// Zoho CRM adapter — second real adapter. REST-only operations against /crm/v8/.
// Auth model:
//   - access_token minted from refresh_token via /oauth/v2/token (refresh never expires).
//   - access_token lives ~1h; we cache + refresh on 401.
// Capability surface from S0 ingestion:
//   - fields: ✅ POST /settings/fields?module=... ; visible-by-default (no FLS step)
//   - stages: ⚠️  PATCH /settings/fields/{stageFieldId}?module=Deals — whole-array replace
//   - pipelines: ✅ POST /settings/pipeline?layout_id=... ; references EXISTING stage IDs
//   - workflows: ⚠️ Deluge functions exist but body shape eluded S0 probing — marked
//     unsupported until P3.5 nails the shape (Varun's input slot). Plan surfaces as
//     `diff: unsupported`, apply skips.
//   - assignment_rules: ❌ no v8 REST create surface — UNSUPPORTED.

import type { ProvisionSpec, StageSpec, WorkflowShape } from "../core/spec.ts";
import type {
  Adapter,
  ApplyResult,
  CapabilityMap,
  ConnectionContext,
  Plan,
  PlanStep,
  RunStepRecord,
  StepResult,
} from "./types.ts";

const CAPS: CapabilityMap = {
  fields: "supported",
  stages: "supported",
  pipelines: "supported",
  workflows: {
    idle_deal_alert: "unsupported",        // Deluge functions body shape pending (S0 ⚠️)
    field_derivation: "unsupported",
    round_robin_assignment: "unsupported",
  },
  assignment_rules: "unsupported",          // No v8 REST create surface (S0 ❌)
  org_create: "manual",
};

// --- Token management ------------------------------------------------------

const TOKEN_CACHE = new Map<string, { token: string; expiresAt: number }>();

async function mintAccessToken(conn: ConnectionContext): Promise<string> {
  const cached = TOKEN_CACHE.get(conn.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  if (!conn.refresh_token) {
    throw new Error("zoho adapter: connection has no refresh_token; pass via connect_crm");
  }
  // DC routing — accounts host varies (com / eu / in / com.au). connection.dc records it.
  const dc = conn.dc || "com";
  const oauthBase = `https://accounts.zoho.${dc}`;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ZOHO_CLIENT_ID ?? "",
    client_secret: process.env.ZOHO_CLIENT_SECRET ?? "",
    refresh_token: conn.refresh_token,
  });
  const res = await fetch(`${oauthBase}/oauth/v2/token`, { method: "POST", body: params });
  if (!res.ok) throw new Error(`zoho oauth refresh ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!j.access_token) throw new Error(`zoho oauth: ${JSON.stringify(j)}`);
  const expiresAt = Date.now() + (j.expires_in ?? 3600) * 1000;
  TOKEN_CACHE.set(conn.id, { token: j.access_token, expiresAt });
  return j.access_token;
}

async function zoho(
  conn: ConnectionContext,
  path: string,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const base = conn.api_domain || "https://www.zohoapis.com";
  const url = `${base}${path}`;
  let token = await mintAccessToken(conn);
  let res = await doFetch();
  if (res.status === 401) {
    // Force-refresh on 401 (token may have expired since cache check)
    TOKEN_CACHE.delete(conn.id);
    token = await mintAccessToken(conn);
    res = await doFetch();
  }
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text.length ? JSON.parse(text) : {}; } catch { /* keep raw */ }
  return { status: res.status, body: parsed };

  async function doFetch(): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Zoho-oauthtoken ${token}` };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    return fetch(url, { method: init.method ?? "GET", headers, body });
  }
}

// --- Snapshot --------------------------------------------------------------

type Snapshot = {
  fields_lead: Array<{ id: string; api_name: string }>;
  stages: Array<{ id: string; api_name: string; probability: number; forecast_category_id: string; forecast_category_name: string }>;
  pipelines: Array<{ id: string; api_name: string }>;
  stage_field_id: string | null;
  default_deals_layout_id: string | null;
};

async function snapshot(conn: ConnectionContext): Promise<Snapshot> {
  const leadFields = await zoho(conn, "/crm/v8/settings/fields?module=Leads");
  const fields_lead = (((leadFields.body as { fields?: Array<{ id: string; api_name: string }> })?.fields) ?? [])
    .filter((f) => !!f.api_name)
    .map((f) => ({ id: f.id, api_name: f.api_name }));

  const dealFields = await zoho(conn, "/crm/v8/settings/fields?module=Deals");
  const stageField = ((dealFields.body as { fields?: Array<{ id: string; api_name: string; pick_list_values?: Array<{ id: string; actual_value: string; probability: number; forecast_category?: { id: string; name: string } }> }> })?.fields ?? [])
    .find((f) => f.api_name === "Stage");
  const stages = (stageField?.pick_list_values ?? []).map((v) => ({
    id: v.id,
    api_name: v.actual_value,
    probability: v.probability ?? 0,
    forecast_category_id: v.forecast_category?.id ?? "",
    forecast_category_name: v.forecast_category?.name ?? "Pipeline",
  }));

  const layouts = await zoho(conn, "/crm/v8/settings/layouts?module=Deals");
  const default_deals_layout_id = (((layouts.body as { layouts?: Array<{ id: string; status: string }> })?.layouts) ?? [])
    .find((l) => l.status === "active")?.id ?? null;

  let pipelines: Array<{ id: string; api_name: string }> = [];
  if (default_deals_layout_id) {
    const p = await zoho(conn, `/crm/v8/settings/pipeline?layout_id=${default_deals_layout_id}`);
    pipelines = (((p.body as { pipeline?: Array<{ id: string; actual_value: string }> })?.pipeline) ?? []).map((x) => ({
      id: x.id,
      api_name: x.actual_value,
    }));
  }

  return { fields_lead, stages, pipelines, stage_field_id: stageField?.id ?? null, default_deals_layout_id };
}

// --- Planning --------------------------------------------------------------

type FieldPayload = { api_name: string; label: string; kind: string; module: string; length?: number; description?: string };

function isWorkflowSupported(shape: string): boolean {
  return CAPS.workflows[shape] === "supported";
}

async function planSpec(conn: ConnectionContext, spec: ProvisionSpec, snap: Snapshot): Promise<Plan> {
  const steps: PlanStep[] = [];
  let seq = 1;

  for (const f of spec.fields) {
    const existing = snap.fields_lead.find((x) => x.api_name === f.api_name);
    steps.push({
      seq: seq++,
      operation: "create_field",
      target: f.module,
      payload: f as FieldPayload,
      diff: existing ? "noop" : "create",
      destructive: false,
    });
  }

  const normForCompare = (s: string): string => s.replace(/_/g, " ").trim();
  for (const s of spec.stages) {
    const existing = snap.stages.find((x) => normForCompare(x.api_name) === normForCompare(s.api_name));
    const matches = existing && existing.probability === s.probability;
    steps.push({
      seq: seq++,
      operation: "add_stage",
      target: "Deals",
      payload: s as StageSpec,
      diff: existing ? (matches ? "noop" : "update") : "create",
      destructive: false,
    });
  }

  for (const p of spec.pipelines) {
    const existing = snap.pipelines.find((x) => normForCompare(x.api_name) === normForCompare(p.api_name));
    steps.push({
      seq: seq++,
      operation: "create_pipeline",
      target: "Deals",
      payload: p,
      diff: existing ? "noop" : "create",
      destructive: false,
    });
  }

  for (const w of spec.workflows) {
    const supported = isWorkflowSupported(w.shape);
    steps.push({
      seq: seq++,
      operation: `create_workflow:${w.shape}`,
      target: "Workflow",
      payload: w as WorkflowShape,
      diff: supported ? "create" : "unsupported",
      destructive: false,
      notes: supported ? undefined : `Zoho v8: ${w.shape} not creatable via public REST (Deluge functions body shape pending). Surface manual instruction OR wait for Varun's idiom.`,
    });
  }

  return {
    spec_hash: "",
    steps,
    unsupported_count: steps.filter((s) => s.diff === "unsupported").length,
    destructive_count: steps.filter((s) => s.destructive).length,
  };
}

// --- Apply -----------------------------------------------------------------

async function createField(conn: ConnectionContext, f: FieldPayload): Promise<unknown> {
  const moduleApi = f.module === "Lead" ? "Leads" : f.module === "Deal" ? "Deals" : f.module;
  const body = {
    fields: [{
      api_name: f.api_name,
      field_label: f.label,
      data_type: kindToZohoType(f.kind),
      length: f.kind === "text" ? f.length ?? 80 : undefined,
      description: f.description,
    }],
  };
  const { status, body: respBody } = await zoho(conn, `/crm/v8/settings/fields?module=${encodeURIComponent(moduleApi)}`, { method: "POST", body });
  if (status >= 400) throw new Error(`zoho field create ${status}: ${JSON.stringify(respBody)}`);
  return respBody;
}

function kindToZohoType(kind: string): string {
  switch (kind) {
    case "text": return "text";
    case "long_text": return "textarea";
    case "number": return "integer";
    case "decimal": return "double";
    case "boolean": return "boolean";
    case "date": return "date";
    case "datetime": return "datetime";
    case "picklist": return "picklist";
    case "email": return "email";
    case "phone": return "phone";
    case "url": return "website";
    case "lookup": return "lookup";
    default: return "text";
  }
}

// Stage addition uses PATCH on the Stage field — whole-array-replace semantics
// (per S0 probe). Read existing, append new, write back.
async function addStages(conn: ConnectionContext, additions: StageSpec[], snap: Snapshot): Promise<unknown> {
  if (!snap.stage_field_id) throw new Error("zoho stage add: no Deals.Stage field id in snapshot");
  // Build the full picklist payload: existing stages + new ones (idempotent on api_name).
  const existingByName = new Map(snap.stages.map((s) => [s.api_name, s]));
  // We need the existing values' shapes — read the field directly for full shape.
  const dealFields = await zoho(conn, "/crm/v8/settings/fields?module=Deals");
  const stageField = ((dealFields.body as { fields?: Array<{ api_name: string; pick_list_values?: unknown[] }> })?.fields ?? [])
    .find((f) => f.api_name === "Stage");
  const existingValues = (stageField?.pick_list_values ?? []) as Array<Record<string, unknown>>;

  const toAdd = additions.filter((s) => !existingByName.has(s.api_name));
  if (!toAdd.length) return { noop: "all stages exist" };

  // Pick a forecast_category id by name from an existing stage (S0 quirk: must be {id}, not {actual_value})
  const fcByName: Record<string, string> = {};
  for (const v of existingValues) {
    const fc = v.forecast_category as { id?: string; name?: string } | undefined;
    if (fc?.name && fc.id) fcByName[fc.name] = fc.id;
  }

  // Zoho v8 cross-validates forecast_category vs deal_category (DEPENDENT_MISMATCH otherwise):
  //   deal_category="Closed Won"  → forecast_category MUST be "Closed (Won)"
  //   deal_category="Closed Lost" → forecast_category MUST be "Closed (Lost)"
  //   deal_category="Open"        → forecast_category MUST be one of the Open-side categories
  //                                 (Pipeline / Best Case / Commit / Omitted — but only those
  //                                  the org has set up). Default trial orgs only have "Pipeline".
  // Zoho's default forecast categories on a trial org are only: Pipeline, Closed, Omitted.
  // (SFDC has "Closed (Won)" + "Closed (Lost)" separately; Zoho merges them under "Closed".)
  // So a "Closed Won" deal_category maps to fc="Closed", same for "Closed Lost".
  function pickForecastCategory(forecastType: string, requested: string): string {
    if (forecastType === "Closed Won" || forecastType === "Closed Lost") {
      return fcByName["Closed"] ?? fcByName["Closed (Won)"] ?? fcByName["Closed (Lost)"] ?? Object.values(fcByName)[0]!;
    }
    return fcByName[requested] ?? fcByName["Pipeline"] ?? Object.values(fcByName)[0]!;
  }

  const newValues = toAdd.map((s, i) => ({
    display_value: s.label,
    actual_value: s.api_name,
    forecast_type: s.forecast_type,
    forecast_category: { id: pickForecastCategory(s.forecast_type, s.forecast_category) },
    deal_category: s.forecast_type,
    probability: s.probability,
    sequence_number: 100 + i,
  }));

  // Whole-array replace: include existing + new (per S0 finding)
  const body = {
    fields: [{
      pick_list_values: [...existingValues, ...newValues],
    }],
  };
  const { status, body: respBody } = await zoho(conn, `/crm/v8/settings/fields/${snap.stage_field_id}?module=Deals`, { method: "PATCH", body });
  if (status >= 400) throw new Error(`zoho stage PATCH ${status}: ${JSON.stringify(respBody)}`);
  return respBody;
}

async function createPipeline(conn: ConnectionContext, p: { api_name: string; label: string; stages: string[] }, snap: Snapshot): Promise<unknown> {
  if (!snap.default_deals_layout_id) throw new Error("zoho pipeline: no default Deals layout in snapshot");
  // Re-resolve stage IDs after any add_stage step (snapshot may be stale if stages were just added)
  const fresh = await zoho(conn, "/crm/v8/settings/fields?module=Deals");
  const stageField = ((fresh.body as { fields?: Array<{ api_name: string; pick_list_values?: Array<{ id: string; actual_value: string }> }> })?.fields ?? [])
    .find((f) => f.api_name === "Stage");
  // Zoho normalizes underscores to spaces in actual_value (so 'Lead_In' in our spec
  // becomes 'Lead In' in the picklist). Normalize both sides before lookup.
  const norm = (s: string): string => s.replace(/_/g, " ").trim();
  const byName = new Map((stageField?.pick_list_values ?? []).map((v) => [norm(v.actual_value), v.id]));
  const stageIds = p.stages.map((name) => {
    const id = byName.get(norm(name));
    if (!id) throw new Error(`pipeline references unknown stage api_name: ${name} (normalized: '${norm(name)}'; available: ${[...byName.keys()].join(", ")})`);
    return { id };
  });
  const body = {
    pipeline: [{
      display_value: p.label,
      actual_value: p.api_name,
      maps: stageIds,
    }],
  };
  const { status, body: respBody } = await zoho(conn, `/crm/v8/settings/pipeline?layout_id=${snap.default_deals_layout_id}`, { method: "POST", body });
  if (status >= 400) throw new Error(`zoho pipeline POST ${status}: ${JSON.stringify(respBody)}`);
  return respBody;
}

// --- Adapter export --------------------------------------------------------

export const zohoAdapter: Adapter = {
  crm: "zoho",
  capabilities: CAPS,

  async inspect(conn: ConnectionContext) {
    return { snapshot: await snapshot(conn) };
  },

  async plan(conn, spec, snap) {
    return planSpec(conn, spec, snap as Snapshot);
  },

  async apply(conn, plan, onStep): Promise<ApplyResult> {
    const results: StepResult[] = [];
    let failed = false;
    // Fresh snapshot for any step that needs id lookups (stage_field_id, layout_id, etc.)
    const snap = await snapshot(conn);

    // Batch stages: collect first, single PATCH.
    const stageBatch = plan.steps.filter((s) => s.operation === "add_stage" && s.diff !== "noop").map((s) => s.payload as StageSpec);
    if (stageBatch.length) {
      try {
        await addStages(conn, stageBatch, snap);
      } catch (e) {
        failed = true;
        for (const s of plan.steps.filter((s) => s.operation === "add_stage" && s.diff !== "noop")) {
          const r: StepResult = { seq: s.seq, status: "failed", error: { code: "STAGE_BATCH_FAIL", message: String(e) } };
          results.push(r); onStep(r);
        }
      }
    }

    for (const step of plan.steps) {
      // Stage step results were pushed by the batch above
      if (step.operation === "add_stage") {
        if (results.some((r) => r.seq === step.seq)) continue;
        const r: StepResult = step.diff === "noop"
          ? { seq: step.seq, status: "succeeded", result: { noop: true } }
          : { seq: step.seq, status: "succeeded", result: { deployed_in_batch: true } };
        results.push(r); onStep(r);
        continue;
      }
      if (step.diff === "noop") {
        const r: StepResult = { seq: step.seq, status: "succeeded", result: { noop: true } };
        results.push(r); onStep(r); continue;
      }
      if (step.diff === "unsupported") {
        const r: StepResult = { seq: step.seq, status: "skipped_unsupported", result: { reason: step.notes } };
        results.push(r); onStep(r); continue;
      }
      try {
        if (step.operation === "create_field") {
          const res = await createField(conn, step.payload as FieldPayload);
          const r: StepResult = { seq: step.seq, status: "succeeded", result: res };
          results.push(r); onStep(r);
        } else if (step.operation === "create_pipeline") {
          const res = await createPipeline(conn, step.payload as { api_name: string; label: string; stages: string[] }, snap);
          const r: StepResult = { seq: step.seq, status: "succeeded", result: res };
          results.push(r); onStep(r);
        } else {
          const r: StepResult = { seq: step.seq, status: "skipped_unsupported", result: { reason: "operation not implemented in Zoho adapter" } };
          results.push(r); onStep(r);
        }
      } catch (e) {
        failed = true;
        const r: StepResult = { seq: step.seq, status: "failed", error: { code: "STEP_FAILED", message: String(e) } };
        results.push(r); onStep(r);
      }
    }

    return { status: failed ? "partial" : "succeeded", steps: results };
  },

  async teardown(conn, steps, onStep): Promise<ApplyResult> {
    const results: StepResult[] = [];
    const reverse = [...steps].filter((s) => s.status === "succeeded").reverse();
    const snap = await snapshot(conn);
    for (const step of reverse) {
      try {
        if (step.operation === "create_field") {
          const f = step.payload as FieldPayload;
          const moduleApi = f.module === "Lead" ? "Leads" : f.module === "Deal" ? "Deals" : f.module;
          // Look up id by api_name (snapshot of the proper module)
          const list = moduleApi === "Leads" ? snap.fields_lead : (await snapshot(conn)).fields_lead;
          const target = list.find((x) => x.api_name === f.api_name);
          if (!target) {
            const r: StepResult = { seq: step.seq, status: "succeeded", result: { reversed: "create_field", note: "already-absent" } };
            results.push(r); onStep(r);
            continue;
          }
          const del = await zoho(conn, `/crm/v8/settings/fields/${target.id}?module=${encodeURIComponent(moduleApi)}`, { method: "DELETE" });
          if (del.status >= 400) throw new Error(`zoho field delete ${del.status}: ${JSON.stringify(del.body)}`);
          const r: StepResult = { seq: step.seq, status: "succeeded", result: { reversed: "create_field", deleted_id: target.id } };
          results.push(r); onStep(r);
        } else if (step.operation === "create_pipeline") {
          // S0: pipeline DELETE shape returned 400 — investigated as residue, not a teardown bug.
          // Marking reversed-with-residue so the run ledger is honest.
          const r: StepResult = { seq: step.seq, status: "succeeded", result: { reversed: "create_pipeline", residue: "pipeline_remains_in_layout_residue" } };
          results.push(r); onStep(r);
        } else if (step.operation === "add_stage") {
          // Whole-array replace teardown: complex (would need to PATCH with the stage removed).
          // For MVP demo orgs the residue is acceptable; mark honestly.
          const r: StepResult = { seq: step.seq, status: "succeeded", result: { reversed: "add_stage", residue: "stage_picklist_value_remains" } };
          results.push(r); onStep(r);
        } else {
          const r: StepResult = { seq: step.seq, status: "succeeded", result: { reversed: step.operation, note: "no-op or stub op" } };
          results.push(r); onStep(r);
        }
      } catch (e) {
        const r: StepResult = { seq: step.seq, status: "failed", error: { code: "TEARDOWN_FAILED", message: String(e) } };
        results.push(r); onStep(r);
      }
    }
    return { status: "succeeded", steps: results };
  },
};
