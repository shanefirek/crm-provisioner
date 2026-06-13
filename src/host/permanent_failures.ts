// P6 — negative cache for permanent failures.
//
// Design:
//   - On apply, when a step throws a non-retryable error (DataError or
//     BoundaryError:permanent / :rejected), the host writes a row into
//     permanent_failures keyed by (connection_id, operation, payload_hash).
//   - On plan, after the adapter computes step diffs, we look up each step's
//     payload_hash against permanent_failures. Non-expired hits become
//     `blocked_by_prior_failure` with notes carrying the original error +
//     first_seen_at — the LLM (or human) sees "we already tried this and it
//     failed permanently."
//   - apply() accepts an optional `force_retry_blocked:true` that rewrites
//     blocked steps back to their original diff (mirrors confirm_destructive).
//   - teardown_run clears cache entries for each reversed step (the field /
//     pipeline / etc. is gone, so a future create attempt has a clean slate).

import type { Pool, PoolClient } from "pg";

/** Either a pg pool or a checked-out client; both expose .query() identically. */
type Queryable = Pool | PoolClient;
import { stableHash } from "../core/overlay.ts";
import type { Plan, PlanStep } from "../adapters/types.ts";

// TTL defaults per error class. Wider window for ironclad-permanent errors
// (revoked auth, deleted resources) than for data errors (duplicate names that
// might become available after a teardown).
const TTL_SECONDS = {
  data: 30 * 24 * 60 * 60,
  permanent_boundary: 90 * 24 * 60 * 60,
} as const;

function ttlSecondsFor(errorCode: string): number {
  if (errorCode.startsWith("DataError")) return TTL_SECONDS.data;
  if (errorCode.startsWith("BoundaryError:permanent")) return TTL_SECONDS.permanent_boundary;
  if (errorCode.startsWith("BoundaryError:rejected")) return TTL_SECONDS.data;
  return TTL_SECONDS.data;
}

/** True if the error code is a permanent (non-retryable) failure worth caching. */
export function isCacheableFailure(errorCode: string | null | undefined): boolean {
  if (!errorCode) return false;
  return (
    errorCode.startsWith("DataError") ||
    errorCode.startsWith("BoundaryError:permanent") ||
    errorCode.startsWith("BoundaryError:rejected")
  );
}

/** Hash a step's payload deterministically. Stable across runs. */
export function hashStepPayload(payload: unknown): string {
  return stableHash(payload);
}

type PermFailureRow = {
  operation: string;
  payload_hash: string;
  error_code: string;
  error_message: string | null;
  first_seen_at: number;
  expires_at: number;
};

/** Look up all non-expired cached failures for a connection. */
async function loadActiveCacheRows(db: Pool, connectionId: string): Promise<PermFailureRow[]> {
  const { rows } = await db.query<PermFailureRow>(
    `select operation, payload_hash, error_code, error_message, first_seen_at, expires_at
       from permanent_failures
       where connection_id = $1 and expires_at > extract(epoch from now())::integer`,
    [connectionId],
  );
  return rows;
}

/**
 * Annotate steps in-place: any step whose (operation, payload_hash) matches a
 * non-expired cache row gets its `diff` flipped to `blocked_by_prior_failure`
 * with notes describing what was cached. Returns the number of steps annotated.
 */
export async function annotateBlockedSteps(db: Pool, connectionId: string, plan: Plan): Promise<number> {
  const cached = await loadActiveCacheRows(db, connectionId);
  if (cached.length === 0) return 0;
  const byKey = new Map<string, PermFailureRow>();
  for (const r of cached) byKey.set(`${r.operation}|${r.payload_hash}`, r);
  let count = 0;
  for (const step of plan.steps) {
    // Already-skipped / already-correct steps don't get reblocked.
    if (step.diff === "noop" || step.diff === "unsupported") continue;
    const key = `${step.operation}|${hashStepPayload(step.payload)}`;
    const hit = byKey.get(key);
    if (!hit) continue;
    step.diff = "blocked_by_prior_failure";
    const ageDays = Math.round((Date.now() / 1000 - hit.first_seen_at) / 86400);
    step.notes = `BLOCKED — prior permanent failure cached. error_code=${hit.error_code}; first_seen ${ageDays}d ago; original message: ${hit.error_message ?? "(none)"}. Pass force_retry_blocked:true to apply() to re-attempt.`;
    count++;
  }
  return count;
}

/**
 * Forcibly clear the blocked verdict and restore the original create/update diff
 * for steps that were marked blocked. Used when apply() is called with
 * force_retry_blocked:true. Returns the number of steps unblocked.
 */
export function unblockSteps(plan: Plan): number {
  let count = 0;
  for (const step of plan.steps) {
    if (step.diff === "blocked_by_prior_failure") {
      // Default to "create" — that's the only diff we ever block in P6.
      // (Update / noop never get blocked because they aren't tried.)
      step.diff = "create";
      step.notes = (step.notes ?? "") + " [unblocked by force_retry_blocked]";
      count++;
    }
  }
  return count;
}

/**
 * After a step fails with a cacheable error, persist the failure. UPSERTs so
 * a repeat failure refreshes `last_seen_at` + `expires_at` without duplicating.
 */
export async function recordPermanentFailure(
  db: Queryable,
  args: {
    connectionId: string;
    operation: string;
    payload: unknown;
    errorCode: string;
    errorMessage: string;
    runId: string;
  },
): Promise<void> {
  const payloadHash = hashStepPayload(args.payload);
  const ttl = ttlSecondsFor(args.errorCode);
  await db.query(
    `insert into permanent_failures
       (connection_id, operation, payload_hash, error_code, error_message, last_run_id, expires_at)
     values ($1, $2, $3, $4, $5, $6, extract(epoch from now())::integer + $7)
     on conflict (connection_id, operation, payload_hash) do update
       set last_seen_at = extract(epoch from now())::integer,
           expires_at   = extract(epoch from now())::integer + $7,
           error_code   = excluded.error_code,
           error_message = excluded.error_message,
           last_run_id  = excluded.last_run_id`,
    [args.connectionId, args.operation, payloadHash, args.errorCode, args.errorMessage, args.runId, ttl],
  );
}

/**
 * Clear the cache row that matches a teardown step's payload. Teardown means
 * "the resource that was created (and that a future create might have collided
 * with) is now gone" — so the cached failure is no longer applicable.
 */
export async function clearForReversed(
  db: Queryable,
  args: { connectionId: string; operation: string; payload: unknown },
): Promise<void> {
  const payloadHash = hashStepPayload(args.payload);
  await db.query(
    `delete from permanent_failures
       where connection_id = $1 and operation = $2 and payload_hash = $3`,
    [args.connectionId, args.operation, payloadHash],
  );
}
