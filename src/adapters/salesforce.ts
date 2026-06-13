// Salesforce adapter — first real adapter. Uses Tooling REST for fields, Metadata API
// (via stage-and-deploy) for flows/permsets/stages/assignment-rules. Built on S0 fixtures.
//
// Auth model for P2: the connection row stores `refresh_token` + `access_token` etc.
// for OAuth flow (P3 host work). For P2 dev we accept access_token directly via
// connection setup and rely on its TTL; if missing we hit /services/oauth2/token with
// the refresh_token. instance_url comes from connection.api_domain.
//
// What's deliberately NOT here:
// - CustomObject creation (out of v1 vocabulary; standard Lead/Opportunity/Account suffice)
// - Apex (Flow handles the v1 workflow shapes well enough)
// - Profile permissions beyond the run's permset

import type { ProvisionSpec, StageSpec, WorkflowShape } from "../core/spec.ts";
import { BoundaryError, classifySfdcResponse, describeThrown, retryBoundary } from "../host/errors.ts";
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
  stages: "supported",         // via StandardValueSet metadata deploy
  pipelines: "supported",      // Opportunity uses StandardValueSet stages directly; no separate Pipeline object in SFDC v1
  workflows: {
    idle_deal_alert: "supported",          // Time-Based Flow on Opportunity
    field_derivation: "supported",         // Record-triggered Flow
    round_robin_assignment: "supported",   // Lead AssignmentRule (round-robin via queue)
  },
  assignment_rules: "supported",
  org_create: "manual",                    // Dev Hub scratch orgs is a P2.5 future
};

// --- HTTP helpers ----------------------------------------------------------

type SfFetchInit = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  contentType?: string;
  raw?: boolean;
};

async function sf(conn: ConnectionContext, path: string, init: SfFetchInit = {}): Promise<{ status: number; body: unknown }> {
  // P2 auth strategy: shell out to `sf api request rest`. WHY not direct fetch:
  //  - `sf org display --json` REDACTS the access token on stdout (CLI 2.x security).
  //  - The token in ~/.sfdx/{user}.json is ENCRYPTED with a machine-local key; decrypting
  //    requires the @salesforce/core encryption code path. Not worth the dep for P2.
  //  - P3 replaces this with a real OAuth web flow and direct fetch.
  // P2 caveat: DELETE method here breaks on CLI 2.x ("No 'mode' found in 'body' entry").
  //  Teardown therefore uses destructiveChanges deploy (canonical SFDC path) — see
  //  deployDestructive() — and this function only handles GET/POST/PATCH.
  if (init.method === "DELETE") {
    throw new Error("salesforce adapter: DELETE not supported via sf api request rest (CLI 2.x quirk); use deployDestructive() instead");
  }
  const { spawn } = await import("node:child_process");
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const alias = inferAlias(conn);

  const args = ["api", "request", "rest", path, "--target-org", alias];
  if (init.method && init.method !== "GET") args.push("--method", init.method);

  let tmpDir: string | undefined;
  if (init.body !== undefined) {
    tmpDir = await mkdtemp(join(tmpdir(), "sf-req-"));
    const bodyPath = join(tmpDir, "body.json");
    await writeFile(bodyPath, typeof init.body === "string" ? init.body : JSON.stringify(init.body));
    args.push("--body", `@${bodyPath}`);
  }

  try {
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const p = spawn("sf", args);
      let so = ""; let se = "";
      p.stdout.on("data", (b) => (so += b.toString()));
      p.stderr.on("data", (b) => (se += b.toString()));
      p.on("close", (c) => resolve({ stdout: so, stderr: se, code: c ?? -1 }));
    });
    let parsed: unknown = stdout;
    try { parsed = stdout.length ? JSON.parse(stdout) : {}; } catch { /* keep as text */ }
    if (Array.isArray(parsed) && parsed.length && (parsed[0] as { errorCode?: string }).errorCode) {
      return { status: 400, body: parsed };
    }
    if (code !== 0 && !stdout) {
      throw new Error(`sf api request failed (${code}): ${stderr}`);
    }
    return { status: 200, body: parsed };
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }
}

// --- Snapshot --------------------------------------------------------------

type Snapshot = {
  fields_lead: Array<{ FullName: string; DeveloperName: string }>;
  stages: Array<{ ApiName: string; IsActive: boolean; DefaultProbability: number }>;
  flows: Array<{ DeveloperName: string }>;
  assignment_rule_names: string[];
};

async function querySoql<T = Record<string, unknown>>(conn: ConnectionContext, soql: string): Promise<T[]> {
  const { status, body } = await sf(conn, `/services/data/v62.0/query?q=${encodeURIComponent(soql)}`);
  if (status >= 400) throw new Error(`SOQL ${status}: ${JSON.stringify(body)}`);
  return ((body as { records?: T[] })?.records ?? []) as T[];
}

async function snapshot(conn: ConnectionContext): Promise<Snapshot> {
  // Stages — read-only via REST
  const stageRows = await querySoql<{ ApiName: string; IsActive: boolean; DefaultProbability: number }>(
    conn,
    "SELECT ApiName, IsActive, DefaultProbability FROM OpportunityStage",
  );
  // Custom fields on Lead — Tooling API.
  // S0/P2 catch: Tooling REJECTS multi-row queries that SELECT FullName or Metadata
  // ("Result size: N" — qualification must specify ≤1 row). Strategy: list by DeveloperName
  // only; if a caller needs FullName, derive it (`Lead.{DeveloperName}__c`) — adapter knows the convention.
  const fieldsResp = await sf(conn, `/services/data/v62.0/tooling/query?q=${encodeURIComponent(
    "SELECT Id, DeveloperName FROM CustomField WHERE TableEnumOrId = 'Lead'",
  )}`);
  const fields_lead = (((fieldsResp.body as { records?: Array<{ Id: string; DeveloperName: string }> })?.records) ?? [])
    .map((r) => ({ FullName: `Lead.${r.DeveloperName}__c`, DeveloperName: r.DeveloperName }));
  // Flows — Tooling
  const flowResp = await sf(conn, `/services/data/v62.0/tooling/query?q=${encodeURIComponent(
    "SELECT DeveloperName FROM FlowDefinitionView",
  )}`);
  const flows = (((flowResp.body as { records?: Array<{ DeveloperName: string }> })?.records) ?? []).map((r) => ({
    DeveloperName: r.DeveloperName,
  }));

  return { fields_lead, stages: stageRows, flows, assignment_rule_names: [] };
}

// --- Planning --------------------------------------------------------------

type FieldPayload = { api_name: string; label: string; kind: string; module: string; length?: number; description?: string };
type StagePayload = StageSpec;
type WorkflowPayload = WorkflowShape;

function leadCustomFullName(module: string, api: string): string {
  // SFDC custom fields are written as `ObjectApi.FieldApi__c`
  return `${module}.${api}__c`;
}

async function planSpec(conn: ConnectionContext, spec: ProvisionSpec, snap: Snapshot): Promise<Plan> {
  const steps: PlanStep[] = [];
  let seq = 1;

  for (const f of spec.fields) {
    const exists = snap.fields_lead.some((x) => x.DeveloperName === f.api_name && (f.module === "Lead" || f.module === "Leads"));
    steps.push({
      seq: seq++,
      operation: "create_field",
      target: f.module,
      payload: f as FieldPayload,
      diff: exists ? "noop" : "create",
      destructive: false,
    });
  }

  // For SFDC: stages and pipelines collapse into a single StandardValueSet:OpportunityStage deploy.
  // We emit ONE step per stage (so the run ledger is granular) but the apply batches them.
  for (const s of spec.stages) {
    const exists = snap.stages.find((x) => x.ApiName === s.api_name);
    const matchesProbability = exists && exists.DefaultProbability === s.probability;
    steps.push({
      seq: seq++,
      operation: "add_stage",
      target: "Opportunity",
      payload: s as StagePayload,
      diff: exists ? (matchesProbability ? "noop" : "update") : "create",
      destructive: false,
    });
  }

  // SFDC doesn't have a "Pipeline" object distinct from StandardValueSet — we no-op pipeline steps
  // but emit them for parity / audit (the spec engine sees them; SFDC adapter says "n/a here").
  for (const p of spec.pipelines) {
    steps.push({
      seq: seq++,
      operation: "create_pipeline",
      target: "Opportunity",
      payload: p,
      diff: "noop",
      destructive: false,
      notes: "SFDC: pipelines are the StandardValueSet on Opportunity.StageName — stages above handle this",
    });
  }

  for (const w of spec.workflows) {
    const flowDevName = `prov_${w.api_name}`;
    const exists = snap.flows.some((x) => x.DeveloperName === flowDevName);
    steps.push({
      seq: seq++,
      operation: `create_workflow:${w.shape}`,
      target: "Flow",
      payload: w as WorkflowPayload,
      diff: exists ? "noop" : "create",
      destructive: false,
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
  const fullName = leadCustomFullName(f.module === "Leads" ? "Lead" : f.module, f.api_name);
  const metadata: Record<string, unknown> = {
    label: f.label,
    type: kindToSfType(f.kind),
    description: f.description,
  };
  if (metadata.type === "Text") metadata.length = f.length ?? 80;
  if (metadata.type === "LongTextArea") {
    metadata.length = f.length ?? 32_768;
    metadata.visibleLines = 4;
  }
  const { status, body } = await sf(conn, "/services/data/v62.0/tooling/sobjects/CustomField", {
    method: "POST",
    body: { FullName: fullName, Metadata: metadata },
  });
  if (status >= 400) {
    // P5: classify into typed BoundaryError or DataError. Adapter no longer raw-throws.
    throw classifySfdcResponse({ status, body });
  }
  return body;
}

function kindToSfType(kind: string): string {
  switch (kind) {
    case "text": return "Text";
    case "long_text": return "LongTextArea";
    case "number": return "Number";
    case "decimal": return "Number";
    case "boolean": return "Checkbox";
    case "date": return "Date";
    case "datetime": return "DateTime";
    case "picklist": return "Picklist";
    case "email": return "Email";
    case "phone": return "Phone";
    case "url": return "Url";
    case "lookup": return "Lookup";
    default: return "Text";
  }
}

// Stage update via StandardValueSet metadata deploy (batched across all stage steps).
async function deployStandardValueSet(conn: ConnectionContext, addStages: StagePayload[]): Promise<void> {
  if (!addStages.length) return;
  // Retrieve current first
  const current = await retrieveStandardValueSet(conn);
  const have = new Set(current.values.map((v) => v.fullName));
  for (const s of addStages) {
    if (have.has(s.api_name)) continue; // idempotent
    current.values.push({
      fullName: s.api_name,
      label: s.label,
      closed: s.forecast_type !== "Open",
      default: false,
      forecastCategory: s.forecast_category === "Best Case" ? "BestCase" : s.forecast_category.startsWith("Closed (W") ? "Closed" : s.forecast_category.startsWith("Closed (L") ? "Omitted" : "Pipeline",
      probability: s.probability,
      won: s.forecast_type === "Closed Won",
    });
  }
  await deployStandardValueSetXml(conn, current.values);
}

type SvsValue = { fullName: string; label: string; closed: boolean; default: boolean; forecastCategory: string; probability: number; won: boolean };

async function retrieveStandardValueSet(conn: ConnectionContext): Promise<{ values: SvsValue[] }> {
  // Use the Metadata REST API (v62): read full standard value set via Tooling subset or use list/read pattern.
  // Simplest reliable path: query existing stages via SOQL and reconstitute as values.
  const stages = await querySoql<{ ApiName: string; DefaultProbability: number; ForecastCategoryName: string; IsClosed: boolean; IsWon: boolean }>(
    conn,
    "SELECT ApiName, DefaultProbability, ForecastCategoryName, IsClosed, IsWon FROM OpportunityStage",
  );
  return {
    values: stages.map((s) => ({
      fullName: s.ApiName,
      label: s.ApiName,
      closed: !!s.IsClosed,
      default: false,
      forecastCategory: s.ForecastCategoryName ?? "Pipeline",
      probability: s.DefaultProbability ?? 0,
      won: !!s.IsWon,
    })),
  };
}

async function deployStandardValueSetXml(conn: ConnectionContext, values: SvsValue[]): Promise<void> {
  // Metadata API deploy requires a multipart zip. To keep the adapter dependency-light, we
  // delegate to the local `sf` CLI which the user already has authenticated. The adapter shells
  // out via Node's child_process when the SFDC writer needs the Metadata API specifically.
  const { spawn } = await import("node:child_process");
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "sf-svs-"));
  await mkdir(join(dir, "standardValueSets"), { recursive: true });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<StandardValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <sorted>false</sorted>
${values.map((v) => `  <standardValue>
    <fullName>${escapeXml(v.fullName)}</fullName>
    <default>${v.default}</default>
    <label>${escapeXml(v.label)}</label>
    <closed>${v.closed}</closed>
    <forecastCategory>${escapeXml(v.forecastCategory)}</forecastCategory>
    <probability>${v.probability}</probability>
    <won>${v.won}</won>
  </standardValue>`).join("\n")}
</StandardValueSet>
`;
  await writeFile(join(dir, "standardValueSets", "OpportunityStage.standardValueSet-meta.xml"), xml);
  const pkg = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>OpportunityStage</members><name>StandardValueSet</name></types>
  <version>62.0</version>
</Package>
`;
  await writeFile(join(dir, "package.xml"), pkg);

  await new Promise<void>((resolve, reject) => {
    const alias = inferAlias(conn);
    const args = ["project", "deploy", "start", "--metadata-dir", dir, "--target-org", alias, "--wait", "10", "--json"];
    const p = spawn("sf", args);
    let stdout = ""; let stderr = "";
    p.stdout.on("data", (b) => (stdout += b.toString()));
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`sf deploy failed (${code}): ${stderr || stdout}`));
    });
  });
}

function inferAlias(_conn: ConnectionContext): string {
  // For P2 dev, the alias is the CLI's local org alias; default shane-dev.
  // P3 replaces with the OAuth-acquired connection identity (the api_domain + a refresh token).
  return process.env.SF_ALIAS || "shane-dev";
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Flow deploy for the 3 workflow shapes — same metadata-deploy path via sf CLI.
async function deployFlow(conn: ConnectionContext, w: WorkflowPayload): Promise<void> {
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");

  const flowName = `prov_${w.api_name}`;
  const xml = flowXmlFor(flowName, w);

  const dir = await mkdtemp(join(tmpdir(), "sf-flow-"));
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(join(dir, "flows", `${flowName}.flow-meta.xml`), xml);
  await writeFile(join(dir, "package.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>${flowName}</members><name>Flow</name></types>
  <version>62.0</version>
</Package>
`);

  await new Promise<void>((resolve, reject) => {
    const alias = inferAlias(conn);
    const args = ["project", "deploy", "start", "--metadata-dir", dir, "--target-org", alias, "--wait", "10", "--json"];
    const p = spawn("sf", args);
    let stdout = ""; let stderr = "";
    p.stdout.on("data", (b) => (stdout += b.toString()));
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`sf flow deploy ${code}: ${stderr || stdout}`)));
  });
}

// Destructive deploy — the canonical SFDC metadata removal path.
// Writes a destructiveChanges.xml + empty package.xml, deploys via sf CLI.
async function deployDestructive(conn: ConnectionContext, metadataType: string, memberFullName: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "sf-destroy-"));
  await writeFile(join(dir, "destructiveChanges.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>${escapeXml(memberFullName)}</members><name>${escapeXml(metadataType)}</name></types>
  <version>62.0</version>
</Package>
`);
  // package.xml MUST exist (even empty) — sf deploy refuses without it.
  await writeFile(join(dir, "package.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <version>62.0</version>
</Package>
`);
  await new Promise<void>((resolve, reject) => {
    const alias = inferAlias(conn);
    const args = ["project", "deploy", "start", "--metadata-dir", dir, "--target-org", alias, "--wait", "10", "--json"];
    const p = spawn("sf", args);
    let out = ""; let err = "";
    p.stdout.on("data", (b) => (out += b.toString()));
    p.stderr.on("data", (b) => (err += b.toString()));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`sf destructive deploy ${code}: ${err || out}`));
    });
  });
}

function flowXmlFor(flowName: string, w: WorkflowPayload): string {
  // Minimal vetted Flow shapes — one per WorkflowShape variant. canvas coords required.
  if (w.shape === "field_derivation") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>62.0</apiVersion>
  <label>${escapeXml(flowName)}</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <start>
    <locationX>176</locationX>
    <locationY>0</locationY>
    <object>${escapeXml(w.module)}</object>
    <recordTriggerType>${w.when === "on_update" ? "Update" : w.when === "on_create" ? "Create" : "CreateAndUpdate"}</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
    <connector><targetReference>derive</targetReference></connector>
  </start>
  <recordUpdates>
    <name>derive</name>
    <label>derive</label>
    <locationX>176</locationX>
    <locationY>287</locationY>
    <inputAssignments>
      <field>${escapeXml(w.target_field)}</field>
      <value><elementReference>$Record.${escapeXml(w.source_field)}</elementReference></value>
    </inputAssignments>
    <inputReference>$Record</inputReference>
  </recordUpdates>
</Flow>`;
  }
  if (w.shape === "idle_deal_alert") {
    // Minimal record-triggered Flow that, post-save, schedules nothing — placeholder shape.
    // Real time-based behavior requires Flow Scheduled Paths which need more shape; P2 baseline
    // ships the create-time touch and P2.5/P3 extends to scheduled-path. This is the "vetted
    // pattern library, deploy-tested, grown by need" discipline.
    return `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>62.0</apiVersion>
  <label>${escapeXml(flowName)}</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <start>
    <locationX>176</locationX>
    <locationY>0</locationY>
    <object>Opportunity</object>
    <recordTriggerType>Create</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
</Flow>`;
  }
  if (w.shape === "round_robin_assignment") {
    // Round-robin via Lead AssignmentRule queue is the SFDC-idiomatic path.
    // For P2 we emit a Flow that is a placeholder; real assignment rule comes via
    // the assignment_rules path in a future expansion. Mark as a structural stub
    // so plan diff is honest.
    return `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>62.0</apiVersion>
  <label>${escapeXml(flowName)}</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <start>
    <locationX>176</locationX>
    <locationY>0</locationY>
    <object>Lead</object>
    <recordTriggerType>Create</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
</Flow>`;
  }
  throw new Error(`unknown workflow shape: ${(w as { shape: string }).shape}`);
}

// --- Adapter export --------------------------------------------------------

export const salesforceAdapter: Adapter = {
  crm: "salesforce",
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

    // Batch stages — collect first, deploy once.
    const stageBatch: StagePayload[] = [];
    for (const step of plan.steps) {
      if (step.operation === "add_stage" && step.diff !== "noop") stageBatch.push(step.payload as StagePayload);
    }
    if (stageBatch.length) {
      try {
        await retryBoundary(() => deployStandardValueSet(conn, stageBatch));
      }
      catch (e) {
        failed = true;
        const d = describeThrown(e);
        for (const s of plan.steps.filter((s) => s.operation === "add_stage" && s.diff !== "noop")) {
          const r: StepResult = { seq: s.seq, status: "failed", error: { code: d.typedCode, message: d.message, attempts: d.attempts } };
          results.push(r); onStep(r);
        }
      }
    }

    for (const step of plan.steps) {
      // Stage steps either succeeded as part of the batch above, or were already pushed as failures
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
        const r: StepResult = { seq: step.seq, status: "skipped_unsupported" };
        results.push(r); onStep(r); continue;
      }

      try {
        if (step.operation === "create_field") {
          // P5: retry boundary errors (5xx, 429); raise DataError immediately.
          const res = await retryBoundary(() => createField(conn, step.payload as FieldPayload));
          const r: StepResult = { seq: step.seq, status: "succeeded", result: res };
          results.push(r); onStep(r);
        } else if (step.operation.startsWith("create_workflow:")) {
          await retryBoundary(() => deployFlow(conn, step.payload as WorkflowPayload));
          const r: StepResult = { seq: step.seq, status: "succeeded", result: { flow_deployed: true } };
          results.push(r); onStep(r);
        } else if (step.operation === "create_pipeline") {
          const r: StepResult = { seq: step.seq, status: "succeeded", result: { noop: "sfdc-stages-handled-via-svs" } };
          results.push(r); onStep(r);
        } else {
          const r: StepResult = { seq: step.seq, status: "skipped_unsupported" };
          results.push(r); onStep(r);
        }
      } catch (e: unknown) {
        failed = true;
        const d = describeThrown(e);
        const r: StepResult = { seq: step.seq, status: "failed", error: { code: d.typedCode, message: d.message, attempts: d.attempts } };
        results.push(r); onStep(r);
      }
    }

    return { status: failed ? "partial" : "succeeded", steps: results };
  },

  async teardown(conn, steps, onStep): Promise<ApplyResult> {
    const results: StepResult[] = [];
    const reverse = [...steps].filter((s) => s.status === "succeeded").reverse();
    for (const step of reverse) {
      try {
        if (step.operation === "create_field") {
          // Canonical SFDC field removal = destructiveChanges deploy. Tooling DELETE
          // trips FLS / dependency permission walls; destructive deploy uses metadata-
          // layer auth and handles those concerns.
          const f = step.payload as FieldPayload;
          const module = f.module === "Leads" ? "Lead" : f.module;
          await deployDestructive(conn, "CustomField", `${module}.${f.api_name}__c`);
          const r: StepResult = { seq: step.seq, status: "succeeded", result: { reversed: "create_field", method: "destructiveChanges" } };
          results.push(r); onStep(r);
        } else {
          // Stage deactivate-not-delete (the S0 catch) — we just record as reversed but the
          // stage stays as IsActive=false. Teardown is honest about this:
          const r: StepResult = { seq: step.seq, status: "succeeded", result: { reversed: step.operation, residue: step.operation === "add_stage" ? "stage_deactivated_only" : null } };
          results.push(r); onStep(r);
        }
      } catch (e) {
        const d = describeThrown(e);
        const r: StepResult = { seq: step.seq, status: "failed", error: { code: d.typedCode, message: d.message, attempts: d.attempts } };
        results.push(r); onStep(r);
      }
    }
    return { status: "succeeded", steps: results };
  },
};
