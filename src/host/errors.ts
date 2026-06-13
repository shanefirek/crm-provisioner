// Typed error hierarchy + retry-with-backoff for boundary errors.
// Mirrors error-handling-philosophy.md's 5 categories, applied to crm-provisioner's
// vendor-API integrations. LLMError is N/A here (we don't call LLMs ourselves —
// the calling Claude session does).
//
// The retry decision matrix from the principle doc:
//   Boundary (5xx, 429)        → YES, exponential jittered, max 5 attempts
//   Boundary (network timeout) → YES, exponential, max 3
//   Boundary (4xx rejected)    → NO
//   Boundary (404/410/401)     → NO + flag for negative-cache (P6)
//   Data error                 → NO (bad input; same input → same failure)
//   Config error               → NO (system needs human)
//   Logic error                → NO (bug; alert)

// ----------------------------------------------------------------------------
// Base error class
// ----------------------------------------------------------------------------

abstract class CrmProvisionerError extends Error {
  abstract readonly category: "BoundaryError" | "DataError" | "ConfigError" | "LogicError" | "WatchdogError";
  abstract readonly retryable: boolean;
  /** Typed code string for the run_steps.error_code column — "BoundaryError:transient" etc. */
  abstract readonly typedCode: string;
  /** How many attempts were made before this error settled — set by retryBoundary. */
  attempts: number = 1;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

// ----------------------------------------------------------------------------
// BoundaryError — external dependency failures
// ----------------------------------------------------------------------------

export type BoundaryKind = "transient" | "rate_limit" | "permanent" | "rejected";

export class BoundaryError extends CrmProvisionerError {
  readonly category = "BoundaryError" as const;
  readonly kind: BoundaryKind;
  readonly provider: string;
  readonly retryable: boolean;
  /** From `Retry-After` header on 429 responses; seconds. */
  readonly retryAfterSec?: number;
  /** Original vendor error code (e.g. "INVALID_DATA", "DEPENDENT_MISMATCH"). Preserved for audit. */
  readonly vendorCode?: string;

  constructor(args: {
    provider: string;
    kind: BoundaryKind;
    message: string;
    retryAfterSec?: number;
    vendorCode?: string;
  }) {
    super(args.message);
    this.provider = args.provider;
    this.kind = args.kind;
    this.retryAfterSec = args.retryAfterSec;
    this.vendorCode = args.vendorCode;
    // transient and rate_limit are retryable; permanent and rejected are not.
    this.retryable = args.kind === "transient" || args.kind === "rate_limit";
  }

  get typedCode(): string {
    return `BoundaryError:${this.kind}`;
  }
}

// ----------------------------------------------------------------------------
// DataError — input is malformed
// ----------------------------------------------------------------------------

export class DataError extends CrmProvisionerError {
  readonly category = "DataError" as const;
  readonly retryable = false;
  readonly vendorCode?: string;

  constructor(args: { message: string; vendorCode?: string }) {
    super(args.message);
    this.vendorCode = args.vendorCode;
  }

  get typedCode(): string {
    return this.vendorCode ? `DataError:${this.vendorCode}` : "DataError";
  }
}

// ----------------------------------------------------------------------------
// ConfigError — system misconfigured
// ----------------------------------------------------------------------------

export class ConfigError extends CrmProvisionerError {
  readonly category = "ConfigError" as const;
  readonly retryable = false;

  get typedCode(): string {
    return "ConfigError";
  }
}

// ----------------------------------------------------------------------------
// LogicError — our bug; fail loud
// ----------------------------------------------------------------------------

export class LogicError extends CrmProvisionerError {
  readonly category = "LogicError" as const;
  readonly retryable = false;

  get typedCode(): string {
    return "LogicError";
  }
}

// ----------------------------------------------------------------------------
// WatchdogError — quality metric (failure-rate or silent-success) tripped mid-run
// ----------------------------------------------------------------------------

export type WatchdogKind = "failure_rate" | "silent_success_rate";

export class WatchdogError extends CrmProvisionerError {
  readonly category = "WatchdogError" as const;
  readonly retryable = false;
  readonly kind: WatchdogKind;
  readonly window: number;
  readonly observed: number;

  constructor(args: { kind: WatchdogKind; message: string; window: number; observed: number }) {
    super(args.message);
    this.kind = args.kind;
    this.window = args.window;
    this.observed = args.observed;
  }

  get typedCode(): string {
    return `WatchdogError:${this.kind}`;
  }
}

// ----------------------------------------------------------------------------
// retryBoundary — exponential jittered backoff per the retry decision matrix
// ----------------------------------------------------------------------------

export type RetryOpts = {
  maxAttempts?: number;       // default 5 for boundary errors
  baseMs?: number;            // default 250ms
  capMs?: number;             // default 10s — cap for backoff
  /** Honor Retry-After header from rate_limit errors. Default true. */
  honorRetryAfter?: boolean;
  /**
   * Cap (ms) on vendor-provided Retry-After. Default 5 minutes (300_000).
   * Distinct from `capMs` (the backoff cap) — when a vendor SAYS retry in 60s, we
   * trust them; the previous shared 10s cap silently burned attempts on a 429 with
   * Retry-After: 60 by retrying after 10s. Set lower only if you have evidence the
   * vendor lies about Retry-After values.
   */
  retryAfterCapMs?: number;
};

/**
 * Run `fn` with retry-on-boundary-errors semantics.
 * Returns whatever `fn` returns on success; on terminal failure throws the last error
 * (with `attempts` set to the number of attempts made).
 *
 * Non-retryable errors (DataError, ConfigError, LogicError, BoundaryError:permanent,
 * BoundaryError:rejected) are re-thrown immediately on first occurrence.
 *
 * For rate_limit errors with a Retry-After value, that exact delay is used.
 */
export async function retryBoundary<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseMs = opts.baseMs ?? 250;
  const capMs = opts.capMs ?? 10_000;
  const retryAfterCapMs = opts.retryAfterCapMs ?? 300_000;
  const honorRetryAfter = opts.honorRetryAfter ?? true;

  let attempt = 0;
  let lastErr: unknown;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Non-retryable → throw immediately (preserve attempts at current count).
      if (!(e instanceof BoundaryError) || !e.retryable) {
        if (e instanceof CrmProvisionerError) e.attempts = attempt;
        throw e;
      }
      // Retryable boundary error — back off and try again, unless out of attempts.
      if (attempt >= maxAttempts) {
        e.attempts = attempt;
        throw e;
      }
      const delayMs = computeDelay(attempt, baseMs, capMs, retryAfterCapMs, honorRetryAfter ? e.retryAfterSec : undefined);
      await sleep(delayMs);
    }
  }
  // Unreachable in practice, but TypeScript needs a return path.
  throw lastErr;
}

/**
 * Compute the next backoff delay.
 * - Vendor-provided Retry-After (rate_limit): honored up to `retryAfterCapMs` (default 5min).
 *   Previously shared `capMs` — a 60s Retry-After got clamped to 10s, burning an attempt.
 * - Otherwise: exponential ±25% jitter, capped at `capMs`.
 *
 * Exported for boundary testing.
 */
export function computeDelay(attempt: number, baseMs: number, capMs: number, retryAfterCapMs: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, retryAfterCapMs);
  }
  // Exponential with jitter: base * 2^(attempt-1), jittered ±25%, capped.
  const exp = baseMs * Math.pow(2, attempt - 1);
  const jitter = exp * (0.75 + Math.random() * 0.5);
  return Math.min(Math.round(jitter), capMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------------------------
// Helpers — classify common vendor error shapes into our typed errors
// ----------------------------------------------------------------------------

/**
 * Classify a Salesforce REST error envelope (always an array of {message, errorCode, ...})
 * plus the HTTP status into a typed error.
 */
export function classifySfdcResponse(args: {
  status: number;
  body: unknown;
}): BoundaryError | DataError {
  const arr = Array.isArray(args.body) ? (args.body as Array<{ message?: string; errorCode?: string }>) : [];
  const first = arr[0] ?? {};
  const message = first.message ?? `salesforce error (HTTP ${args.status})`;
  const vendorCode = first.errorCode;

  // 5xx → transient boundary
  if (args.status >= 500 && args.status < 600) {
    return new BoundaryError({ provider: "salesforce", kind: "transient", message, vendorCode });
  }
  // 429 → rate_limit (SFDC rarely uses this for API but possible on org limits)
  if (args.status === 429) {
    return new BoundaryError({ provider: "salesforce", kind: "rate_limit", message, vendorCode });
  }
  // 401/403 → permanent boundary (revoked auth, etc.) — flagged for negative cache (P6)
  if (args.status === 401 || args.status === 403) {
    return new BoundaryError({ provider: "salesforce", kind: "permanent", message, vendorCode });
  }
  // 4xx with a known data-shape error code → DataError (won't retry)
  if (args.status >= 400 && args.status < 500) {
    return new DataError({ message, vendorCode });
  }
  // Anything else → treat as data error (safer than retrying on an unknown)
  return new DataError({ message, vendorCode });
}

/**
 * Classify a Zoho v8 REST error envelope (typically `{code, details, message, status}`,
 * or the array-wrapped variant `{fields:[{code, details, message, status}]}`).
 */
export function classifyZohoResponse(args: {
  status: number;
  body: unknown;
  retryAfterHeader?: string | null;
}): BoundaryError | DataError {
  // Surface the most informative error code Zoho gives us.
  let vendorCode: string | undefined;
  let message: string = `zoho error (HTTP ${args.status})`;
  if (args.body && typeof args.body === "object") {
    const b = args.body as Record<string, unknown>;
    // Plain envelope
    if (typeof b.code === "string") vendorCode = b.code as string;
    if (typeof b.message === "string") message = b.message as string;
    // Wrapped envelopes: {fields: [{code, message}]}, {workflow_rules: [...]}, {tasks: [...]}
    const wrapper = ["fields", "workflow_rules", "tasks", "field_updates", "email_notifications", "pipeline", "assignment_rules"].find(
      (k) => Array.isArray((b as Record<string, unknown>)[k]),
    );
    if (wrapper) {
      const arr = (b as Record<string, unknown>)[wrapper] as Array<{ code?: string; message?: string }>;
      if (arr.length > 0) {
        if (arr[0]?.code) vendorCode = arr[0].code;
        if (arr[0]?.message) message = arr[0].message;
      }
    }
  }

  if (args.status >= 500 && args.status < 600) {
    return new BoundaryError({ provider: "zoho", kind: "transient", message, vendorCode });
  }
  if (args.status === 429) {
    const retryAfterSec = args.retryAfterHeader ? parseInt(args.retryAfterHeader, 10) : undefined;
    return new BoundaryError({
      provider: "zoho",
      kind: "rate_limit",
      message,
      retryAfterSec: Number.isFinite(retryAfterSec as number) ? retryAfterSec : undefined,
      vendorCode,
    });
  }
  if (args.status === 401 || args.status === 403) {
    return new BoundaryError({ provider: "zoho", kind: "permanent", message, vendorCode });
  }
  if (args.status >= 400 && args.status < 500) {
    return new DataError({ message, vendorCode });
  }
  return new DataError({ message, vendorCode });
}

/**
 * Helper to convert ANY thrown value into the typed-code string + attempts count
 * for storage in run_steps. Non-CrmProvisioner errors get classified as LogicError
 * (we shouldn't have any — by the principle, they're our bugs).
 */
export function describeThrown(e: unknown): { typedCode: string; message: string; attempts: number } {
  if (e instanceof CrmProvisionerError) {
    return { typedCode: e.typedCode, message: e.message, attempts: e.attempts };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { typedCode: "LogicError", message: msg, attempts: 1 };
}
