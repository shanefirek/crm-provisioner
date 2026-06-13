// ProvisionSpec v0 — the typed artifact the LLM authors as a delta over a template.
// Schema-validated at the MCP boundary; resolved (template + delta) at plan time.
// Closed grammar by design — extension points are declared by the template, not invented by the agent.

import { z } from "zod";

// ---------- Field ----------
export const FieldKindSchema = z.enum([
  "text",
  "long_text",
  "number",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "picklist",
  "lookup",
  "email",
  "phone",
  "url",
]);
export type FieldKind = z.infer<typeof FieldKindSchema>;

export const FieldSpecSchema = z.object({
  api_name: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/, "snake/camel-case identifier"),
  label: z.string().min(1),
  kind: FieldKindSchema,
  module: z.string().min(1),                     // 'Lead' | 'Deal' | etc.
  length: z.number().int().positive().optional(),
  description: z.string().optional(),
  picklist_values: z.array(z.string()).optional(), // when kind=picklist
  required: z.boolean().optional(),
});
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

// ---------- Stage / Pipeline ----------
export const StageSpecSchema = z.object({
  api_name: z.string().min(1),
  label: z.string().min(1),
  forecast_category: z.enum(["Pipeline", "Best Case", "Commit", "Closed (Won)", "Closed (Lost)", "Omitted"]),
  forecast_type: z.enum(["Open", "Closed Won", "Closed Lost"]),
  probability: z.number().min(0).max(100),
});
export type StageSpec = z.infer<typeof StageSpecSchema>;

export const PipelineSpecSchema = z.object({
  api_name: z.string().min(1),
  label: z.string().min(1),
  module: z.literal("Deal"),
  stages: z.array(z.string()).min(2),            // references StageSpec.api_name
});
export type PipelineSpec = z.infer<typeof PipelineSpecSchema>;

// ---------- Workflow shapes (closed library) ----------
export const WorkflowShapeSchema = z.discriminatedUnion("shape", [
  z.object({
    shape: z.literal("idle_deal_alert"),
    api_name: z.string().min(1),
    pipeline: z.string().min(1),                 // references PipelineSpec.api_name
    stage: z.string().min(1),                    // references StageSpec.api_name
    idle_days: z.number().int().positive(),
    notify: z.enum(["owner", "manager"]),
  }),
  z.object({
    shape: z.literal("field_derivation"),
    api_name: z.string().min(1),
    module: z.string().min(1),
    target_field: z.string().min(1),
    source_field: z.string().min(1),
    when: z.enum(["on_create", "on_update", "on_save"]),
  }),
  z.object({
    shape: z.literal("round_robin_assignment"),
    api_name: z.string().min(1),
    module: z.literal("Lead"),
    pool: z.array(z.string().min(1)).min(1),     // user emails or ids
    when_source_equals: z.array(z.string()).optional(),
  }),
]);
export type WorkflowShape = z.infer<typeof WorkflowShapeSchema>;

// ---------- Extension points (declared by templates) ----------
// A template declares WHERE deltas may attach. Default-deny: a delta touching an
// undeclared path is rejected by validate_spec, not silently merged.
export const ExtensionPointSchema = z.object({
  path: z.string().min(1),                       // e.g. 'pipelines[].stages', 'fields'
  allow: z.enum(["append", "append_or_replace", "replace_full"]),
  notes: z.string().optional(),
});
export type ExtensionPoint = z.infer<typeof ExtensionPointSchema>;

// ---------- ProvisionSpec (the artifact) ----------
export const ProvisionSpecSchema = z.object({
  spec_version: z.literal(0),
  extends: z.string().optional(),                // 'real-estate@v1' — null = no-template path
  description: z.string().optional(),
  fields: z.array(FieldSpecSchema).default([]),
  stages: z.array(StageSpecSchema).default([]),
  pipelines: z.array(PipelineSpecSchema).default([]),
  workflows: z.array(WorkflowShapeSchema).default([]),
});
export type ProvisionSpec = z.infer<typeof ProvisionSpecSchema>;

// ---------- DeltaSpec (what the LLM actually writes) ----------
// Same shape as ProvisionSpec minus `extends` (which is in the parent template ref).
// .strict() so unknown keys are REJECTED, not silently dropped — fail-closed schema,
// same principle as the overlay resolver's default-deny on extension points.
export const DeltaSpecSchema = ProvisionSpecSchema.omit({ extends: true, spec_version: true }).extend({
  spec_version: z.literal(0),
}).strict();
export type DeltaSpec = z.infer<typeof DeltaSpecSchema>;

// ---------- Template (data, not code) ----------
export const TemplateSchema = z.object({
  id: z.string().min(1),                         // 'real-estate'
  version: z.string().min(1),                    // 'v1'
  description: z.string().min(1),
  extension_points: z.array(ExtensionPointSchema).min(1),
  base: ProvisionSpecSchema,
});
export type Template = z.infer<typeof TemplateSchema>;
