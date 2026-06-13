#!/usr/bin/env node
// P10 boundary test: computeDelay honors vendor-provided Retry-After up to retryAfterCapMs
// (default 5 min), separate from the exponential-backoff cap (default 10s).
//
// The audit caught: a single `capMs` was shared across both lanes, so a vendor returning
// Retry-After: 60 silently retried after 10s, burning the attempt. This script asserts
// the fix: rate_limit waits the vendor's full delay (subject to the new retryAfterCap).
//
// Runs standalone — no server, no DB. Two ways to invoke:
//   node scripts/test-retry-after.mjs
//   bash scripts/smoke-p0.sh   (smoke calls this script as a sub-test)
//
// Exit 0 = green; non-zero = at least one assertion failed.

import { computeDelay } from "../src/host/errors.ts";

let passed = 0;
let failed = 0;
const assert = (name, actual, expected) => {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}\n    └ expected ${expected}, got ${actual}`);
  }
};

console.log("== P10: computeDelay honors Retry-After up to retryAfterCapMs ==");

// retryAfterSec=30 → 30000ms (the bug: was capped to 10000)
assert(
  "retryAfterSec=30 returns 30000ms",
  computeDelay(1, 250, 10_000, 300_000, 30),
  30_000,
);

// retryAfterSec=60 → 60000ms (vendor's request honored)
assert(
  "retryAfterSec=60 returns 60000ms",
  computeDelay(1, 250, 10_000, 300_000, 60),
  60_000,
);

// retryAfterSec=1 → 1000ms (small values still honored)
assert(
  "retryAfterSec=1 returns 1000ms",
  computeDelay(1, 250, 10_000, 300_000, 1),
  1_000,
);

// retryAfterSec=400 (> retryAfterCapMs/1000=300) → capped to 300000ms
assert(
  "retryAfterSec=400 clamps to retryAfterCapMs (300000ms)",
  computeDelay(1, 250, 10_000, 300_000, 400),
  300_000,
);

// retryAfterSec=0 → falls through to exponential (treated as "no header")
const expBackoff = computeDelay(1, 250, 10_000, 300_000, 0);
if (expBackoff > 100 && expBackoff < 1000) {
  passed++;
  console.log(`  ✓ retryAfterSec=0 falls through to exponential (got ${expBackoff}ms in expected jitter range)`);
} else {
  failed++;
  console.log(`  ✗ retryAfterSec=0 falls through to exponential\n    └ expected 100-1000ms (jittered base 250 * 2^0), got ${expBackoff}`);
}

// No retryAfterSec → exponential backoff capped at capMs=10000
const exp5 = computeDelay(5, 250, 10_000, 300_000);
if (exp5 > 1000 && exp5 <= 10_000) {
  passed++;
  console.log(`  ✓ attempt=5 with no Retry-After honors exponential cap (got ${exp5}ms ≤ 10000)`);
} else {
  failed++;
  console.log(`  ✗ attempt=5 exponential capped at capMs\n    └ expected 1000-10000ms, got ${exp5}`);
}

console.log(`\n  ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
