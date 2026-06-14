// P16: shared adapter apply() lifecycle. Both real adapters (salesforce.ts, zoho.ts)
// had grown ~150-LOC parallel structures with identical control flow but no shared
// scaffold — the parallel evolution caused two of the four P15 bugs (duplicate
// stage-emit, plus near-identical diff/abort handling). At three adapter implementations
// (memory, salesforce, zoho), testing-philosophy's "rule of three" threshold for
// extraction is met.
//
// What the scaffold OWNS:
//  - pre-batch shouldAbort gate (P12 audit fix #2)
//  - dedup-by-seq guard against double-emit (P15 fix #4)
//  - aborted_by skip cascade in the main loop
//  - diff=noop / unsupported / blocked_by_prior_failure standard handling
//  - try/catch describeThrown → typed-failed StepResult
//  - per-step shouldAbort check (only after real dispatch — noop/skip don't trigger)
//  - status aggregation (succeeded / partial / aborted)
//
// What the adapter PROVIDES via hooks:
//  - Optional batch (stage-batch collect + deploy)
//  - Per-step dispatch for create/update steps (vendor REST/CLI calls)
//
// What stays adapter-specific (NOT extracted — vendor-shape divergence):
//  - snapshot() — each vendor's REST surface is too different
//  - planSpec() — each vendor's diff semantics differ
//  - teardown() — vendor-specific reverse-ops; revisit at adapter #4

import { describeThrown } from "../host/errors.ts";
import type { ApplyResult, ConnectionContext, Plan, PlanStep, ShouldAbortFn, StepResult } from "./types.ts";

export type LifecycleHooks = {
  /**
   * Optional pre-loop batch. The scaffold checks shouldAbort BEFORE invoking deploy
   * (defense in depth — metadata deploys can take seconds and commit a real write).
   * If deploy throws, every batched step is marked failed with describeThrown details.
   * The returned `operationName` is used by the main loop to recognize batch-affected
   * steps and emit the post-batch success result (noop vs deployed_in_batch).
   */
  batch?: {
    collect: (steps: PlanStep[]) => PlanStep[];
    deploy: () => Promise<void>;
    operationName: string;
  };

  /**
   * Per-step dispatch for steps with diff="create"/"update" that are NOT in the batch
   * and NOT one of the standard skip cases (noop/unsupported/blocked). Receives the
   * step plus the running results array so an adapter step can inspect prior outcomes
   * (e.g. P15 fix #2: grant_field_visibility filters its payload.fields to fullnames
   * whose earlier create_field steps actually succeeded). Returns the result blob —
   * the scaffold wraps it into a succeeded StepResult; thrown errors become failed
   * StepResults via describeThrown.
   */
  dispatch: (step: PlanStep, priorResults: ReadonlyArray<StepResult>) => Promise<unknown>;
};

export async function runApplyLoop(
  _conn: ConnectionContext,
  plan: Plan,
  onStep: (step: StepResult) => void,
  shouldAbort: ShouldAbortFn | undefined,
  hooks: LifecycleHooks,
): Promise<ApplyResult> {
  const results: StepResult[] = [];
  let failed = false;
  let aborted_by: string | undefined;

  // ---- Optional batch ----
  if (hooks.batch) {
    const batchedSteps = hooks.batch.collect(plan.steps);
    if (batchedSteps.length > 0) {
      const preVerdict = shouldAbort?.();
      if (preVerdict) {
        aborted_by = preVerdict.reason;
        for (const s of batchedSteps) {
          const r: StepResult = { seq: s.seq, status: "skipped_by_watchdog", result: { reason: preVerdict.reason } };
          results.push(r);
          onStep(r);
        }
      } else {
        try {
          await hooks.batch.deploy();
        } catch (e) {
          failed = true;
          const d = describeThrown(e);
          for (const s of batchedSteps) {
            const r: StepResult = { seq: s.seq, status: "failed", error: { code: d.typedCode, message: d.message, attempts: d.attempts } };
            results.push(r);
            onStep(r);
          }
        }
      }
    }
  }

  // ---- Main loop ----
  for (const step of plan.steps) {
    // P15 fix #4: dedup BEFORE the aborted_by branch. If the pre-batch shouldAbort
    // gate already pushed a result for this seq, the loop must not push another.
    if (results.some((r) => r.seq === step.seq)) continue;

    if (aborted_by) {
      const r: StepResult = { seq: step.seq, status: "skipped_by_watchdog", result: { reason: aborted_by } };
      results.push(r);
      onStep(r);
      continue;
    }

    // Post-batch: a batched-operation step survived the batch — emit its success result.
    if (hooks.batch && step.operation === hooks.batch.operationName) {
      const r: StepResult = step.diff === "noop"
        ? { seq: step.seq, status: "succeeded", result: { noop: true } }
        : { seq: step.seq, status: "succeeded", result: { deployed_in_batch: true } };
      results.push(r);
      onStep(r);
      continue;
    }

    // Standard skip / noop branches.
    if (step.diff === "noop") {
      const r: StepResult = { seq: step.seq, status: "succeeded", result: { noop: true } };
      results.push(r);
      onStep(r);
      continue;
    }
    if (step.diff === "unsupported") {
      const r: StepResult = { seq: step.seq, status: "skipped_unsupported", result: { reason: step.notes } };
      results.push(r);
      onStep(r);
      continue;
    }
    if (step.diff === "blocked_by_prior_failure") {
      const r: StepResult = { seq: step.seq, status: "skipped_blocked", result: { reason: step.notes } };
      results.push(r);
      onStep(r);
      continue;
    }

    // Real dispatch path — adapter handles vendor call.
    try {
      const result = await hooks.dispatch(step, results);
      const r: StepResult = { seq: step.seq, status: "succeeded", result };
      results.push(r);
      onStep(r);
    } catch (e) {
      failed = true;
      const d = describeThrown(e);
      const r: StepResult = { seq: step.seq, status: "failed", error: { code: d.typedCode, message: d.message, attempts: d.attempts } };
      results.push(r);
      onStep(r);
    }

    // Watchdog check ONLY after real dispatch — noop/skip paths don't observe.
    const verdict = shouldAbort?.();
    if (verdict) aborted_by = verdict.reason;
  }

  if (aborted_by) return { status: "aborted", steps: results, aborted_by };
  return { status: failed ? "partial" : "succeeded", steps: results };
}
