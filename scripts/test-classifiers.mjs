#!/usr/bin/env node
// P11 boundary test: vendor error envelopes from fixtures/{salesforce,zoho}/ route
// through classifySfdcResponse / classifyZohoResponse to the correct typed error class.
//
// Catches regressions like the audit-time gap: the classifier was never exercised
// against the captured real-vendor shapes — only against the in-process synthetic
// throws. The fixtures encode the actual edge cases (DUPLICATE_DEVELOPER_NAME envelope
// shape, FLS-invisible-field error message, wrapped envelopes with `fields[]` /
// `workflow_rules[]`). This file makes them load-bearing.
//
// Runs standalone — no server, no DB.

import { readFileSync } from "node:fs";
import { classifySfdcResponse, classifyZohoResponse, BoundaryError, DataError } from "../src/host/errors.ts";

let passed = 0;
let failed = 0;
const assertClass = (name, got, expectedClass, expectedKind, expectedVendor) => {
  let ok = got instanceof expectedClass;
  let detail = `class=${got?.constructor?.name}`;
  if (ok && expectedKind !== undefined) {
    ok = got.kind === expectedKind;
    detail += ` kind=${got.kind ?? "n/a"}`;
  }
  if (ok && expectedVendor !== undefined) {
    ok = got.vendorCode === expectedVendor;
    detail += ` vendor=${got.vendorCode ?? "n/a"}`;
  }
  if (ok) {
    passed++;
    console.log(`  ✓ ${name} → ${detail}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}\n    └ expected ${expectedClass.name}${expectedKind ? `:${expectedKind}` : ""}${expectedVendor ? ` vendor=${expectedVendor}` : ""}, got ${detail}`);
  }
};

const load = (path) => JSON.parse(readFileSync(path, "utf8"));

console.log("== P11: SFDC fixtures → classifySfdcResponse ==");

// 400 + DUPLICATE_DEVELOPER_NAME → DataError (not retryable, cacheable)
assertClass(
  "create-customfield-duplicate-error.json (400) → DataError:DUPLICATE_DEVELOPER_NAME",
  classifySfdcResponse({ status: 400, body: load("fixtures/salesforce/create-customfield-duplicate-error.json") }),
  DataError,
  undefined,
  "DUPLICATE_DEVELOPER_NAME",
);

// 400 + INVALID_FIELD (the FLS-invisible-field shape) → DataError
assertClass(
  "fls-invisible-field-error.json (400) → DataError:INVALID_FIELD",
  classifySfdcResponse({ status: 400, body: load("fixtures/salesforce/fls-invisible-field-error.json") }),
  DataError,
  undefined,
  "INVALID_FIELD",
);

// Synthetic 503 → BoundaryError:transient (retryable)
assertClass(
  "synthetic 503 envelope → BoundaryError:transient",
  classifySfdcResponse({ status: 503, body: [{ message: "Service Unavailable", errorCode: "SERVICE_UNAVAILABLE" }] }),
  BoundaryError,
  "transient",
);

// Synthetic 429 → BoundaryError:rate_limit
assertClass(
  "synthetic 429 envelope → BoundaryError:rate_limit",
  classifySfdcResponse({ status: 429, body: [{ message: "Too many", errorCode: "REQUEST_LIMIT_EXCEEDED" }] }),
  BoundaryError,
  "rate_limit",
);

// Synthetic 401 → BoundaryError:permanent (cacheable, no retry)
assertClass(
  "synthetic 401 envelope → BoundaryError:permanent",
  classifySfdcResponse({ status: 401, body: [{ message: "Auth failed", errorCode: "INVALID_AUTH_HEADER" }] }),
  BoundaryError,
  "permanent",
);

console.log("\n== P11: Zoho fixtures → classifyZohoResponse ==");

// 400 + wrapped {fields:[{code:"DUPLICATE_DATA"}]} → DataError
assertClass(
  "create-customfield-duplicate-error.json (400, fields[] wrapped) → DataError:DUPLICATE_DATA",
  classifyZohoResponse({ status: 400, body: load("fixtures/zoho/create-customfield-duplicate-error.json") }),
  DataError,
  undefined,
  "DUPLICATE_DATA",
);

// Synthetic 503 → BoundaryError:transient
assertClass(
  "synthetic Zoho 503 → BoundaryError:transient",
  classifyZohoResponse({ status: 503, body: { code: "INTERNAL_ERROR", message: "Server down" } }),
  BoundaryError,
  "transient",
);

// Synthetic 429 with Retry-After header → BoundaryError:rate_limit with retryAfterSec
const rateLimited = classifyZohoResponse({
  status: 429,
  body: { code: "OVER_LIMIT", message: "Rate limit hit" },
  retryAfterHeader: "60",
});
assertClass(
  "synthetic Zoho 429 with Retry-After: 60 → BoundaryError:rate_limit",
  rateLimited,
  BoundaryError,
  "rate_limit",
);
if (rateLimited.retryAfterSec === 60) {
  passed++;
  console.log(`  ✓ Retry-After header parsed as retryAfterSec=60`);
} else {
  failed++;
  console.log(`  ✗ Retry-After header parsing\n    └ expected retryAfterSec=60, got ${rateLimited.retryAfterSec}`);
}

// Synthetic 401 → BoundaryError:permanent
assertClass(
  "synthetic Zoho 401 → BoundaryError:permanent",
  classifyZohoResponse({ status: 401, body: { code: "INVALID_TOKEN", message: "Token expired" } }),
  BoundaryError,
  "permanent",
);

console.log(`\n  ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
