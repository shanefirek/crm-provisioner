// memory-crm — P0+P1 stub adapter. Holds state in-process, supports most ops.
// One op marked 'unsupported' (assignment_rules) so plan UNSUPPORTED surfacing is exercised
// without needing a real CRM. teardown reverses by walking history backwards.
//
// P5 additions: synthetic-throw support for retry-semantics smoke assertions.
// If a field's api_name has a known test-prefix, the memory adapter throws a
// specific typed error so the default smoke can exercise retryBoundary without
// touching a live CRM. The prefixes are:
//   test__throw_boundary_transient — always throws BoundaryError:transient
//                                     (tests max-retry path: 5 attempts then fail)
//   test__throw_data_error         — always throws DataError
//                                     (tests no-retry path: 1 attempt)
//   test__throw_then_succeed       — throws BoundaryError:transient on first call,
//                                     succeeds on retry (tests success-after-retry: 2 attempts)
// Prefixes only ever fire against the memory adapter; real CRMs never see these.

import type { ProvisionSpec } from "../core/spec.ts";
import { BoundaryError, DataError, describeThrown, retryBoundary } from "../host/errors.ts";
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
    idle_deal_alert: "supported",
    field_derivation: "supported",
    round_robin_assignment: "supported",
  },
  assignment_rules: "unsupported", // mirrors real Zoho — no v8 REST create surface
  org_create: "manual",
};

type Snapshot = {
  fields: Array<{ module: string; api_name: string }>;
  stages: Array<{ api_name: string }>;
  pipelines: Array<{ api_name: string; stages: string[] }>;
  workflows: Array<{ api_name: string; shape: string }>;
};

const INSTANCES = new Map<string, Snapshot>();

// Per-connection counter for "throw then succeed" — keyed by (conn_id, api_name).
// Reset implicitly when the connection is dropped (process restart).
const THEN_SUCCEED_COUNTERS = new Map<string, number>();

function maybeThrowForTest(connId: string, apiName: string): void {
  if (apiName.startsWith("test__throw_boundary_transient")) {
    throw new BoundaryError({ provider: "memory", kind: "transient", message: "synthetic transient error for retry smoke" });
  }
  if (apiName.startsWith("test__throw_data_error")) {
    throw new DataError({ message: "synthetic data error for no-retry smoke", vendorCode: "SYNTHETIC_DATA_ERROR" });
  }
  if (apiName.startsWith("test__throw_then_succeed")) {
    const key = `${connId}|${apiName}`;
    const calls = THEN_SUCCEED_COUNTERS.get(key) ?? 0;
    THEN_SUCCEED_COUNTERS.set(key, calls + 1);
    if (calls === 0) {
      // First call: throw a transient. retryBoundary will call us again — and we'll succeed.
      throw new BoundaryError({ provider: "memory", kind: "transient", message: "synthetic first-call failure for then-succeed smoke" });
    }
  }
}

function snapFor(id: string): Snapshot {
  let s = INSTANCES.get(id);
  if (!s) {
    s = { fields: [], stages: [], pipelines: [], workflows: [] };
    INSTANCES.set(id, s);
  }
  return s;
}

export const memoryAdapter: Adapter = {
  crm: "memory",
  capabilities: CAPS,

  async inspect(conn) {
    return { snapshot: snapFor(conn.id) };
  },

  async plan(conn, spec, _snapshot) {
    const snap = snapFor(conn.id);
    const steps: PlanStep[] = [];
    let seq = 1;
    let unsupported_count = 0;
    let destructive_count = 0;

    for (const f of spec.fields) {
      const exists = snap.fields.some((x) => x.module === f.module && x.api_name === f.api_name);
      steps.push({
        seq: seq++,
        operation: "create_field",
        target: f.module,
        payload: f,
        diff: exists ? "noop" : "create",
        destructive: false,
      });
    }

    for (const s of spec.stages) {
      const exists = snap.stages.some((x) => x.api_name === s.api_name);
      steps.push({
        seq: seq++,
        operation: "add_stage",
        target: "Deal",
        payload: s,
        diff: exists ? "noop" : "create",
        destructive: false,
      });
    }

    for (const p of spec.pipelines) {
      const exists = snap.pipelines.some((x) => x.api_name === p.api_name);
      steps.push({
        seq: seq++,
        operation: "create_pipeline",
        target: "Deal",
        payload: p,
        diff: exists ? "noop" : "create",
        destructive: false,
      });
    }

    for (const w of spec.workflows) {
      const exists = snap.workflows.some((x) => x.api_name === w.api_name);
      steps.push({
        seq: seq++,
        operation: `create_workflow:${w.shape}`,
        target: (w as { module?: string }).module ?? "Deal",
        payload: w,
        diff: exists ? "noop" : "create",
        destructive: false,
      });
    }

    // Capability-map enforcement: anything the adapter can't do becomes an unsupported step
    // with notes that tell the human + LLM what to do instead.
    if (CAPS.assignment_rules === "unsupported") {
      // The toy memory adapter doesn't have assignment_rules in its spec shape today,
      // but we emit a sentinel unsupported step ONLY if the spec asked for one.
      // (Future: when we add AssignmentRuleSpec, this becomes a real iteration over spec.assignment_rules.)
    }

    return { spec_hash: "", steps, unsupported_count, destructive_count };
  },

  async apply(conn, plan, onStep): Promise<ApplyResult> {
    const snap = snapFor(conn.id);
    const results: StepResult[] = [];
    let failed = false;

    for (const step of plan.steps) {
      if (step.diff === "noop") {
        const r: StepResult = { seq: step.seq, status: "succeeded", result: { noop: true } };
        results.push(r); onStep(r); continue;
      }
      if (step.diff === "unsupported") {
        const r: StepResult = { seq: step.seq, status: "skipped_unsupported" };
        results.push(r); onStep(r); continue;
      }
      if (step.diff === "blocked_by_prior_failure") {
        // P6: prior permanent failure cached at the host. Skip cleanly here.
        const r: StepResult = { seq: step.seq, status: "skipped_blocked", result: { reason: step.notes } };
        results.push(r); onStep(r); continue;
      }
      try {
        // P5: wrap the operation in retryBoundary so BoundaryError:transient is retried
        // (per the retry decision matrix). DataError and BoundaryError:permanent are not.
        // The synthetic-throw test prefixes drive this from the smoke gate.
        await retryBoundary(async () => {
          switch (step.operation) {
            case "create_field": {
              const f = step.payload as { module: string; api_name: string };
              maybeThrowForTest(conn.id, f.api_name);
              snap.fields.push({ module: f.module, api_name: f.api_name });
              break;
            }
            case "add_stage": {
              const s = step.payload as { api_name: string };
              snap.stages.push({ api_name: s.api_name });
              break;
            }
            case "create_pipeline": {
              const p = step.payload as { api_name: string; stages: string[] };
              snap.pipelines.push({ api_name: p.api_name, stages: p.stages });
              break;
            }
            default: {
              if (step.operation.startsWith("create_workflow:")) {
                const w = step.payload as { api_name: string; shape: string };
                snap.workflows.push({ api_name: w.api_name, shape: w.shape });
              }
            }
          }
        }, { baseMs: 1, capMs: 5 }); // tiny delays so smoke runs fast — production callers don't override

        const r: StepResult = { seq: step.seq, status: "succeeded", result: { id: `mem-${step.seq}` } };
        results.push(r); onStep(r);
      } catch (e) {
        failed = true;
        const d = describeThrown(e);
        const r: StepResult = {
          seq: step.seq,
          status: "failed",
          error: { code: d.typedCode, message: d.message, attempts: d.attempts },
        };
        results.push(r); onStep(r);
      }
    }

    return { status: failed ? "partial" : "succeeded", steps: results };
  },

  // Reverse a run's successful steps newest-first. Idempotent: missing-already counts as success.
  async teardown(conn, steps, onStep): Promise<ApplyResult> {
    const snap = snapFor(conn.id);
    const results: StepResult[] = [];
    const reverse = [...steps].filter((s) => s.status === "succeeded").reverse();

    for (const step of reverse) {
      try {
        switch (step.operation) {
          case "create_field": {
            const f = step.payload as { module: string; api_name: string };
            snap.fields = snap.fields.filter((x) => !(x.module === f.module && x.api_name === f.api_name));
            break;
          }
          case "add_stage": {
            const s = step.payload as { api_name: string };
            snap.stages = snap.stages.filter((x) => x.api_name !== s.api_name);
            break;
          }
          case "create_pipeline": {
            const p = step.payload as { api_name: string };
            snap.pipelines = snap.pipelines.filter((x) => x.api_name !== p.api_name);
            break;
          }
          default: {
            if (step.operation.startsWith("create_workflow:")) {
              const w = step.payload as { api_name: string };
              snap.workflows = snap.workflows.filter((x) => x.api_name !== w.api_name);
            }
          }
        }
        const r: StepResult = { seq: step.seq, status: "succeeded", result: { reversed: step.operation } };
        results.push(r); onStep(r);
      } catch (e) {
        const r: StepResult = { seq: step.seq, status: "failed", error: { code: "TEARDOWN_FAILED", message: String(e) } };
        results.push(r); onStep(r);
      }
    }

    return { status: "succeeded", steps: results };
  },
};
