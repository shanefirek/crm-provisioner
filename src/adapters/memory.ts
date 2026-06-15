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
//   test__throw_boundary_rate_limit (P11) — always throws BoundaryError:rate_limit
//                                            with retryAfterSec=0 (tests rate_limit retry path
//                                            without slowing the smoke; covers the retryAfterCapMs
//                                            branch added in P10)
//   test__throw_boundary_rejected  (P11) — always throws BoundaryError:rejected (4xx-rejected)
//                                          (tests no-retry + permanent-failure-cache path,
//                                          a typed kind defined but never exercised pre-P11)
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
  ShouldAbortFn,
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
  fields: Array<{ module: string; api_name: string; kind: string; length?: number }>;
  stages: Array<{ api_name: string }>;
  pipelines: Array<{ api_name: string; stages: string[] }>;
  workflows: Array<{ api_name: string; shape: string }>;
};

const INSTANCES = new Map<string, Snapshot>();

// Per-connection counter for "throw then succeed" — keyed by (conn_id, api_name).
// Reset implicitly when the connection is dropped (process restart).
const THEN_SUCCEED_COUNTERS = new Map<string, number>();

/**
 * P7 synthetic-silent-success: when api_name starts with `test__silent_success`,
 * the memory adapter returns successfully but does NOT mutate the snapshot AND
 * returns a noop-shaped result — even though the plan said "create". The host
 * watchdog detects this as a silent failure (vendor reporting success while
 * dropping the write) and trips.
 */
function isSilentSuccessTest(apiName: string): boolean {
  return apiName.startsWith("test__silent_success");
}

function maybeThrowForTest(connId: string, apiName: string): void {
  if (apiName.startsWith("test__throw_boundary_transient")) {
    throw new BoundaryError({ provider: "memory", kind: "transient", message: "synthetic transient error for retry smoke" });
  }
  if (apiName.startsWith("test__throw_boundary_rate_limit")) {
    // retryAfterSec=0 → falls through to exponential jitter; smoke stays fast.
    // (We're testing that rate_limit is retried at all; the specific delay math is
    //  covered by scripts/test-retry-after.mjs against computeDelay directly.)
    throw new BoundaryError({ provider: "memory", kind: "rate_limit", message: "synthetic rate-limit error for retry smoke", retryAfterSec: 0 });
  }
  if (apiName.startsWith("test__throw_boundary_rejected")) {
    throw new BoundaryError({ provider: "memory", kind: "rejected", message: "synthetic 4xx-rejected error", vendorCode: "SYNTHETIC_REJECTED" });
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
      const existing = snap.fields.find((x) => x.module === f.module && x.api_name === f.api_name);
      let diff: PlanStep["diff"] = "create";
      if (existing) {
        if (f.adopt_if_exists === false) {
          throw new DataError({
            message: `field ${f.module}.${f.api_name} already exists but adopt_if_exists=false — refusing to recreate. Set adopt_if_exists=true to attach to the existing field, or remove it from the delta.`,
            vendorCode: "FIELD_EXISTS_NO_ADOPT",
          });
        }
        // P20: shape-compatibility check. Same kind, and the existing field is at least as
        // wide as the spec requires. Incompatible → DataError (instructive), not a silent noop.
        const compatible = existing.kind === f.kind && (f.length == null || existing.length == null || f.length <= existing.length);
        if (!compatible) {
          throw new DataError({
            message: `field ${f.module}.${f.api_name} exists with kind='${existing.kind}'${existing.length != null ? ` length=${existing.length}` : ""} but the spec wants kind='${f.kind}'${f.length != null ? ` length=${f.length}` : ""}. Cannot adopt an incompatible field — rename the spec field or align its kind/length.`,
            vendorCode: "SHAPE_CONFLICT",
          });
        }
        diff = "adopt";
      }
      steps.push({
        seq: seq++,
        operation: "create_field",
        target: f.module,
        payload: f,
        diff,
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

  async apply(conn, plan, onStep, shouldAbort?: ShouldAbortFn): Promise<ApplyResult> {
    const snap = snapFor(conn.id);
    const results: StepResult[] = [];
    let failed = false;
    let aborted_by: string | undefined;

    for (const step of plan.steps) {
      // P7: watchdog check BEFORE processing each step (after noop/skip filters below).
      if (aborted_by) {
        const r: StepResult = { seq: step.seq, status: "skipped_by_watchdog", result: { reason: aborted_by } };
        results.push(r); onStep(r); continue;
      }
      if (step.diff === "noop") {
        const r: StepResult = { seq: step.seq, status: "succeeded", result: { noop: true } };
        results.push(r); onStep(r); continue;
      }
      // P20: adopt — attach to the pre-existing field. No mutation; record provenance so
      // teardown never deletes a field we merely adopted.
      if (step.diff === "adopt") {
        const r: StepResult = { seq: step.seq, status: "succeeded", result: { adopted: true, provenance: "adopted" } };
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
      // P7: silent-success test prefix returns success-with-noop without mutating state.
      if (step.operation === "create_field") {
        const f = step.payload as { module: string; api_name: string };
        if (isSilentSuccessTest(f.api_name)) {
          const r: StepResult = { seq: step.seq, status: "succeeded", result: { noop: true } };
          results.push(r); onStep(r);
          // Check watchdog AFTER the silent-success outcome was reported.
          const verdict = shouldAbort?.();
          if (verdict) aborted_by = verdict.reason;
          continue;
        }
      }

      try {
        // P5: wrap the operation in retryBoundary so BoundaryError:transient is retried
        // (per the retry decision matrix). DataError and BoundaryError:permanent are not.
        // The synthetic-throw test prefixes drive this from the smoke gate.
        await retryBoundary(async () => {
          switch (step.operation) {
            case "create_field": {
              const f = step.payload as { module: string; api_name: string; kind: string; length?: number };
              maybeThrowForTest(conn.id, f.api_name);
              snap.fields.push({ module: f.module, api_name: f.api_name, kind: f.kind, length: f.length });
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

        const result = step.operation === "create_field"
          ? { id: `mem-${step.seq}`, provenance: "created" }
          : { id: `mem-${step.seq}` };
        const r: StepResult = { seq: step.seq, status: "succeeded", result };
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
      // P7: watchdog check after each step's outcome was reported.
      const verdict = shouldAbort?.();
      if (verdict) aborted_by = verdict.reason;
    }

    if (aborted_by) return { status: "aborted", steps: results, aborted_by };
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
            // P20: never delete a field we merely adopted — it pre-existed and isn't ours.
            if ((step.result as { provenance?: string } | null)?.provenance === "adopted") {
              const r: StepResult = { seq: step.seq, status: "succeeded", result: { skipped_adopted_not_owned: true, note: "field pre-existed and was adopted, not created — left intact" } };
              results.push(r); onStep(r); continue;
            }
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
