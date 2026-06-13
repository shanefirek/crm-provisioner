// Template library — data, not code.
// P0 shipped one toy template to exercise the lifecycle. P4 adds two real
// vertical templates (real-estate, professional-services) authored from
// sales-function fundamentals; partners will customize via deltas on contact.

import type { Template } from "./spec.ts";

const COMMON_EXTENSION_POINTS: Template["extension_points"] = [
  { path: "fields",             allow: "append" },
  { path: "stages",             allow: "append" },
  { path: "pipelines",          allow: "append" },
  { path: "pipelines[].stages", allow: "append", notes: "core stages cannot be removed; appended stages allowed" },
  { path: "workflows",          allow: "append" },
];

const TOY_SALES: Template = {
  id: "toy-sales",
  version: "v0",
  description: "P0 toy template: bare sales-function shape — one pipeline, three stages, no fields, no workflows. Exists to exercise the lifecycle and serve as the smoke-test target.",
  extension_points: COMMON_EXTENSION_POINTS,
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

// ---- real-estate@v1 ----
// Authored from generic real-estate brokerage shape: residential agents working
// inquiry → showing → offer → contract → close. No vendor-specific assumptions.
// Partners (UD / Ashim on contact) customize via deltas; the extension-point set
// allows adding new fields, stages, pipelines, and workflows without touching
// the base.
const REAL_ESTATE_V1: Template = {
  id: "real-estate",
  version: "v1",
  description: "Real estate brokerage — residential agent workflow. Inquiry → showing → offer → under contract → closed. Lead-level property + source tracking. Five sales fields, five deal stages, one pipeline.",
  extension_points: COMMON_EXTENSION_POINTS,
  base: {
    spec_version: 0,
    description: "Standard residential real-estate sales template (v1, MVP authored from fundamentals)",
    fields: [
      { module: "Lead", api_name: "property_address", label: "Property Address", kind: "text", length: 255, description: "Address of the property the prospect is inquiring about" },
      { module: "Lead", api_name: "bedrooms",         label: "Bedrooms",         kind: "number",  description: "Bedroom count for the inquired property" },
      { module: "Lead", api_name: "bathrooms",        label: "Bathrooms",        kind: "decimal", description: "Bathroom count (allow half-baths)" },
      { module: "Lead", api_name: "lead_source",      label: "Lead Source",      kind: "text", length: 80, description: "Channel the lead came from (Zillow, Redfin, referral, etc.)" },
      { module: "Lead", api_name: "buyer_or_seller",  label: "Buyer or Seller",  kind: "text", length: 16, description: "'buyer' | 'seller' | 'both'" },
    ],
    stages: [
      { api_name: "Inquiry_Received",   label: "Inquiry Received",   forecast_category: "Pipeline",     forecast_type: "Open",       probability: 10 },
      { api_name: "Showing_Scheduled",  label: "Showing Scheduled",  forecast_category: "Pipeline",     forecast_type: "Open",       probability: 30 },
      { api_name: "Offer_Made",         label: "Offer Made",         forecast_category: "Best Case",    forecast_type: "Open",       probability: 60 },
      { api_name: "Under_Contract",     label: "Under Contract",     forecast_category: "Commit",       forecast_type: "Open",       probability: 85 },
      { api_name: "Closed_Won",         label: "Closed Won",         forecast_category: "Closed (Won)", forecast_type: "Closed Won", probability: 100 },
    ],
    pipelines: [
      { api_name: "Residential", label: "Residential", module: "Deal",
        stages: ["Inquiry_Received", "Showing_Scheduled", "Offer_Made", "Under_Contract", "Closed_Won"] },
    ],
    workflows: [],
  },
};

// ---- professional-services@v1 ----
// Authored from generic prof-services consulting shape: lead → discovery →
// proposal → SOW → booked. Lead-level service-line + budget fields.
const PROFESSIONAL_SERVICES_V1: Template = {
  id: "professional-services",
  version: "v1",
  description: "Professional services / consulting — lead → discovery → proposal → SOW → booked. Service-line and engagement-model tracking. Four sales fields, four deal stages, one pipeline.",
  extension_points: COMMON_EXTENSION_POINTS,
  base: {
    spec_version: 0,
    description: "Standard professional-services sales template (v1, MVP authored from fundamentals)",
    fields: [
      { module: "Lead", api_name: "service_line",     label: "Service Line",     kind: "text", length: 80, description: "Primary service the prospect is asking about (e.g. 'GTM consulting', 'data audit')" },
      { module: "Lead", api_name: "engagement_model", label: "Engagement Model", kind: "text", length: 32, description: "'project' | 'retainer' | 'hourly' | 'equity'" },
      { module: "Lead", api_name: "estimated_hours",  label: "Estimated Hours",  kind: "number", description: "Rough hours estimate for the engagement" },
      { module: "Lead", api_name: "budget_signal",    label: "Budget Signal",    kind: "text", length: 80, description: "Free-text capture of any budget signal from discovery" },
    ],
    stages: [
      { api_name: "Discovery",         label: "Discovery",         forecast_category: "Pipeline",     forecast_type: "Open",       probability: 10 },
      { api_name: "Proposal_Sent",     label: "Proposal Sent",     forecast_category: "Best Case",    forecast_type: "Open",       probability: 40 },
      { api_name: "SOW_Negotiation",   label: "SOW Negotiation",   forecast_category: "Commit",       forecast_type: "Open",       probability: 70 },
      { api_name: "Booked",            label: "Booked",            forecast_category: "Closed (Won)", forecast_type: "Closed Won", probability: 100 },
    ],
    pipelines: [
      { api_name: "Consulting", label: "Consulting", module: "Deal",
        stages: ["Discovery", "Proposal_Sent", "SOW_Negotiation", "Booked"] },
    ],
    workflows: [],
  },
};

const REGISTRY: Record<string, Template> = {
  [`${TOY_SALES.id}@${TOY_SALES.version}`]: TOY_SALES,
  [`${REAL_ESTATE_V1.id}@${REAL_ESTATE_V1.version}`]: REAL_ESTATE_V1,
  [`${PROFESSIONAL_SERVICES_V1.id}@${PROFESSIONAL_SERVICES_V1.version}`]: PROFESSIONAL_SERVICES_V1,
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
