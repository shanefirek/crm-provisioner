// Adapter interface — the seam between the deterministic driver and each CRM.
// Adapters know NOTHING about the spec engine, templates, or the MCP host.
// They translate (sub-)spec operations into vendor API calls and report results.

import type { ProvisionSpec } from "../core/spec.ts";

export type Verdict = "supported" | "unsupported" | "manual";

export type CapabilityMap = {
  fields: Verdict;                    // create field on a module
  stages: Verdict;                    // create / append a pipeline stage
  pipelines: Verdict;                 // group of stages on a layout
  workflows: Record<string, Verdict>; // keyed by WorkflowShape.shape
  assignment_rules: Verdict;
  org_create: Verdict;                // expected 'manual' everywhere v1
};

export type PlanStep = {
  seq: number;
  operation: string;                  // 'create_field' | 'add_stage' | 'create_pipeline' | 'create_workflow:idle_deal_alert' | ...
  target?: string;                    // module / object label
  payload: unknown;                   // adapter-specific shape that apply() will execute
  diff: "create" | "update" | "noop" | "unsupported" | "blocked_by_prior_failure";
  destructive: boolean;               // true when the reverse-op is lossy (deactivates-not-deletes, deletes a stage that has records, etc.)
  notes?: string;                     // e.g. "marked unsupported by capability map: assignment_rules"
};

export type Plan = {
  spec_hash: string;
  steps: PlanStep[];
  unsupported_count: number;
  destructive_count: number;
};

export type StepResult = {
  seq: number;
  status: "succeeded" | "failed" | "skipped_unsupported" | "skipped_blocked";
  result?: unknown;
  /** error.code is the typed-class string (e.g. "BoundaryError:transient", "DataError:DUPLICATE_DATA"). */
  error?: { code: string; message: string; attempts?: number };
};

export type ApplyResult = {
  status: "succeeded" | "failed" | "partial";
  steps: StepResult[];
};

export type ConnectionContext = {
  id: string;
  crm: string;
  api_domain?: string;
  dc?: string;                  // Zoho only: 'com' | 'eu' | 'in' | 'com.au'
  is_demo: boolean;
  writable_org_ids: string[];
  // Adapter-specific auth bits stay opaque to the driver.
  refresh_token?: string;
  access_token?: string;
  access_expires?: number;
};

// What teardown_run hands the adapter to reverse a prior run's steps.
export type RunStepRecord = {
  seq: number;
  operation: string;
  target: string | null;
  payload: unknown;
  result: unknown;
  status: "succeeded" | "failed" | "skipped_unsupported";
};

export interface Adapter {
  readonly crm: string;                         // 'salesforce' | 'zoho' | 'memory'
  readonly capabilities: CapabilityMap;

  // Read current state of the connected instance, scoped to the spec's vocabulary.
  inspect(conn: ConnectionContext): Promise<{ snapshot: unknown }>;

  // Compute a plan: spec + snapshot → ordered steps with diff, destructive, and unsupported tags.
  plan(conn: ConnectionContext, spec: ProvisionSpec, snapshot: unknown): Promise<Plan>;

  // Execute steps in order; emit per-step results. Idempotency owned by the adapter.
  apply(conn: ConnectionContext, plan: Plan, onStep: (step: StepResult) => void): Promise<ApplyResult>;

  // Reverse the successful steps of a previous run, newest-first.
  // The driver supplies the run's step history; adapter decides per-op how to reverse.
  teardown(conn: ConnectionContext, steps: RunStepRecord[], onStep: (step: StepResult) => void): Promise<ApplyResult>;
}
