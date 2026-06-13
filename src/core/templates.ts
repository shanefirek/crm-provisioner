// Template library — data, not code. P0 ships one toy template so the lifecycle is exercised.
// P4 lands real templates (real-estate, professional-services) from UD's configs.

import type { Template } from "./spec.ts";

const TOY_SALES: Template = {
  id: "toy-sales",
  version: "v0",
  description: "P0 toy template: bare sales-function shape — one pipeline, three stages, no fields, no workflows. Exists to exercise the lifecycle.",
  extension_points: [
    { path: "fields",               allow: "append" },
    { path: "stages",               allow: "append" },
    { path: "pipelines",            allow: "append" },
    { path: "pipelines[].stages",   allow: "append", notes: "core stages cannot be removed; appended stages allowed" },
    { path: "workflows",            allow: "append" },
  ],
  base: {
    spec_version: 0,
    description: "toy sales template",
    fields: [],
    stages: [
      { api_name: "Lead_In",   label: "Lead In",   forecast_category: "Pipeline",     forecast_type: "Open",       probability: 10 },
      { api_name: "Qualified", label: "Qualified", forecast_category: "Best Case",    forecast_type: "Open",       probability: 50 },
      { api_name: "Won",       label: "Won",       forecast_category: "Closed (Won)", forecast_type: "Closed Won", probability: 100 },
    ],
    pipelines: [
      { api_name: "Standard", label: "Standard", module: "Deal", stages: ["Lead_In", "Qualified", "Won"] },
    ],
    workflows: [],
  },
};

const REGISTRY: Record<string, Template> = {
  [`${TOY_SALES.id}@${TOY_SALES.version}`]: TOY_SALES,
};

export function listTemplates(): Array<{ id: string; version: string; description: string }> {
  return Object.values(REGISTRY).map((t) => ({ id: t.id, version: t.version, description: t.description }));
}

export function getTemplate(ref: string): Template | undefined {
  // ref forms: 'toy-sales' (latest) or 'toy-sales@v0' (pinned)
  if (REGISTRY[ref]) return REGISTRY[ref];
  for (const t of Object.values(REGISTRY)) if (t.id === ref) return t;
  return undefined;
}
