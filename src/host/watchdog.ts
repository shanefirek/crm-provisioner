// P7 — quality watchdog.
//
// The principle (error-handling-philosophy.md §"The quality watchdog"):
// a circuit breaker trips on errors, but the worst dependency failures are
// SILENT — every record "succeeds," just emptier. The defense is a watchdog
// on an outcome metric over a trailing window, with PAUSE (abort) as the
// action.
//
// Two trip conditions tracked here, both over the last N steps:
//   1. failure_rate — fraction of failed steps > threshold
//   2. silent_success_rate — fraction of "succeeded with noop result, even
//      though the plan said create" > threshold
//
// Defaults from the principle doc + the plan: window=10, threshold=0.5,
// min_steps=5 (don't trip on the first few outliers).

import type { Plan, StepResult } from "../adapters/types.ts";

export type WatchdogConfig = {
  window: number;
  threshold: number;
  minSteps: number;
};

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  window: 10,
  threshold: 0.5,
  minSteps: 5,
};

export type WatchdogVerdict =
  | { tripped: false }
  | { tripped: true; kind: "failure_rate" | "silent_success_rate"; message: string; observed: number };

export class WatchdogTracker {
  private readonly cfg: WatchdogConfig;
  // Each entry: outcome of one step in arrival order. We slide a window over this.
  private outcomes: Array<"failed" | "silent_success" | "ok" | "skipped"> = [];
  private totalSeen = 0;

  constructor(cfg: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG) {
    this.cfg = cfg;
  }

  /**
   * Observe a step result + what the plan expected of it. Returns a verdict —
   * if `tripped: true`, the caller (the apply loop) should stop dispatching
   * new steps and mark the rest skipped_by_watchdog.
   */
  observe(plan: Plan, step: StepResult): WatchdogVerdict {
    const planStep = plan.steps[step.seq - 1];
    let outcome: "failed" | "silent_success" | "ok" | "skipped";
    if (step.status === "failed") outcome = "failed";
    else if (step.status === "succeeded" && planStep?.diff === "create" && isNoopResult(step.result)) {
      // Plan said "create" but the adapter returned a noop-shaped result.
      // This is the silent-failure signature the principle names.
      outcome = "silent_success";
    } else if (step.status === "skipped_unsupported" || step.status === "skipped_blocked") {
      outcome = "skipped";
    } else {
      outcome = "ok";
    }
    this.outcomes.push(outcome);
    this.totalSeen++;
    if (this.totalSeen < this.cfg.minSteps) return { tripped: false };

    const window = this.outcomes.slice(-this.cfg.window);
    const failureCount = window.filter((o) => o === "failed").length;
    const silentCount = window.filter((o) => o === "silent_success").length;
    const windowSize = window.length;

    const failureRate = failureCount / windowSize;
    if (failureRate > this.cfg.threshold) {
      return {
        tripped: true,
        kind: "failure_rate",
        observed: failureRate,
        message: `watchdog tripped: ${failureCount}/${windowSize} (${(failureRate * 100).toFixed(0)}%) recent steps failed — above ${this.cfg.threshold * 100}% threshold`,
      };
    }
    const silentRate = silentCount / windowSize;
    if (silentRate > this.cfg.threshold) {
      return {
        tripped: true,
        kind: "silent_success_rate",
        observed: silentRate,
        message: `watchdog tripped: ${silentCount}/${windowSize} (${(silentRate * 100).toFixed(0)}%) recent steps reported succeeded-with-noop when plan said create — vendor may be silently dropping writes`,
      };
    }
    return { tripped: false };
  }

  /** Count of failures observed in the trailing window — used for forensics on the run row. */
  failuresInWindow(): number {
    return this.outcomes.slice(-this.cfg.window).filter((o) => o === "failed").length;
  }
}

function isNoopResult(result: unknown): boolean {
  if (result == null) return true;
  if (typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  // Adapters mark "no-op" with various shapes; we match the truthy noop key shape.
  if (r.noop === true) return true;
  // Also empty object — equally suspicious from the host's point of view.
  if (Object.keys(r).length === 0) return true;
  return false;
}
