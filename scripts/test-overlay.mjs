#!/usr/bin/env node
// P11 boundary test: applyOverlay paths unreachable through the MCP boundary.
//
// The MCP smoke covers happy-path + single-error rejection. This script covers:
//  - multi-error accumulation (delta touches two undeclared extension points → both errors returned)
//  - pipelines-vs-pipelines[].stages branch discrimination (different code path per existing-vs-new pipeline)
//  - stableHash determinism across key-order permutations (the snapshot-on-write primitive)
//
// Runs standalone — no server, no DB.

import { applyOverlay, stableHash } from "../src/core/overlay.ts";

let passed = 0;
let failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else      { failed++; console.log(`  ✗ ${name}${detail ? `\n    └ ${detail}` : ""}`); }
};

console.log("== P11: applyOverlay multi-error accumulation ==");

// Template that declares NO extension points (only the empty base is allowed).
const lockedTemplate = {
  id: "locked",
  version: "v1",
  description: "locked test template",
  extension_points: [{ path: "stages", allow: "append" }], // ONLY stages; fields + workflows are off-limits
  base: {
    spec_version: 0,
    fields: [], stages: [], pipelines: [], workflows: [],
  },
};

// Delta touches TWO undeclared points (fields + workflows). Both errors should accumulate.
const multiUndeclaredDelta = {
  spec_version: 0,
  fields: [{ api_name: "x", label: "X", kind: "text", module: "Lead" }],
  stages: [],
  pipelines: [],
  workflows: [{ shape: "field_derivation", api_name: "w", module: "Lead", target_field: "a", source_field: "b", when: "on_create" }],
};
const r1 = applyOverlay(lockedTemplate, multiUndeclaredDelta);
assert("multi-undeclared delta returns { ok: false }", !r1.ok);
if (!r1.ok) {
  assert("both 'fields' and 'workflows' errors are reported (not first-only)", r1.errors.length === 2,
    `got ${r1.errors.length} error(s): ${r1.errors.map((e) => e.path).join(", ")}`);
  assert("error paths include 'fields'", r1.errors.some((e) => e.path === "fields"));
  assert("error paths include 'workflows'", r1.errors.some((e) => e.path === "workflows"));
}

console.log("\n== P11: pipelines vs pipelines[].stages branch discrimination ==");

// Template with a pipeline already in the base + the two distinct extension points.
const pipeTemplate = {
  id: "pipe",
  version: "v1",
  description: "pipeline test",
  extension_points: [
    { path: "stages", allow: "append" },
    { path: "pipelines[].stages", allow: "append" }, // EXISTING-pipeline stage-add allowed
    // Note: 'pipelines' (whole-pipeline append) deliberately NOT declared.
  ],
  base: {
    spec_version: 0,
    fields: [],
    stages: [{ api_name: "S1", label: "S1", forecast_category: "Pipeline", forecast_type: "Open", probability: 25 }],
    pipelines: [{ api_name: "P1", label: "P1", module: "Deal", stages: ["S1"] }],
    workflows: [],
  },
};

// Delta appends stages to EXISTING pipeline P1 → should use 'pipelines[].stages' path, allowed.
const appendToExisting = {
  spec_version: 0,
  fields: [], stages: [
    { api_name: "S2", label: "S2", forecast_category: "Pipeline", forecast_type: "Open", probability: 50 },
  ],
  pipelines: [{ api_name: "P1", label: "P1", module: "Deal", stages: ["S2"] }],
  workflows: [],
};
const r2 = applyOverlay(pipeTemplate, appendToExisting);
assert("appending stages to existing pipeline succeeds (uses pipelines[].stages point)", r2.ok);
if (r2.ok) {
  const p1 = r2.spec.pipelines.find((p) => p.api_name === "P1");
  assert("existing pipeline P1's stages now include both S1 and S2", p1 && p1.stages.includes("S1") && p1.stages.includes("S2"),
    `got stages=${JSON.stringify(p1?.stages)}`);
}

// Delta tries to ADD a NEW pipeline P2 → should use 'pipelines' path, which is NOT declared → REJECTED.
const addNewPipeline = {
  spec_version: 0,
  fields: [], stages: [],
  pipelines: [{ api_name: "P2", label: "P2", module: "Deal", stages: ["S1"] }],
  workflows: [],
};
const r3 = applyOverlay(pipeTemplate, addNewPipeline);
assert("adding a NEW pipeline (path: 'pipelines') is rejected when only pipelines[].stages is declared", !r3.ok);
if (!r3.ok) {
  assert("error path is 'pipelines' (not 'pipelines[].stages')",
    r3.errors.some((e) => e.path === "pipelines"),
    `got paths: ${r3.errors.map((e) => e.path).join(", ")}`);
}

console.log("\n== P11: stableHash determinism ==");

const h1 = stableHash({ a: 1, b: 2, c: { x: 10, y: 20 } });
const h2 = stableHash({ c: { y: 20, x: 10 }, b: 2, a: 1 });
assert("stableHash invariant under key-order permutation", h1 === h2, `h1=${h1} vs h2=${h2}`);

const h3 = stableHash({ arr: [1, 2, 3] });
const h4 = stableHash({ arr: [1, 2, 3] });
assert("stableHash deterministic on arrays", h3 === h4);

const h5 = stableHash({ a: null, b: undefined });
const h6 = stableHash({ a: null, b: undefined });
assert("stableHash deterministic on null/undefined values", h5 === h6);

// Different content MUST produce different hashes (no accidental collision on common inputs).
const h7 = stableHash({ a: 1 });
const h8 = stableHash({ a: 2 });
assert("stableHash distinguishes different content", h7 !== h8, `both produced ${h7}`);

console.log(`\n  ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
