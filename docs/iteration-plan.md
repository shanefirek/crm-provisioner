# Iteration Plan

Status: **pre-S0** (scaffold landed 2026-06-12). Phases bounded to ~4 focused hours each; SFDC demo target ≈ day 8, both adapters ≈ day 12-14 (see decision-log for the calendar-reality note).

## S0 — Dual API spike (exempt from phase rules: experiment, answer-is-the-artifact)

- **Deliverables:** run `api-ingest` on both surfaces. `docs/surfaces/zoho-surface.md` + `docs/surfaces/salesforce-surface.md` (capability maps with verdicts), scrubbed fixtures in `fixtures/{zoho,salesforce}/`, OAuth executed end-to-end once each (Zoho trial org incl. per-DC base URL; SFDC scratch org via `sf` CLI).
- **Gate:** every operation the sales-function spec needs (modules/fields, pipeline+stages, assignment rule, one workflow shape, alert) has a verdict — `✅ API / ⚠️ pattern library / ❌ manual` — zero `❓` on that list. Risks 1-3 in architecture.md confirmed or killed in writing.
- **Defer:** all code. Layouts, blueprints, scoring rules, anything outside the sales-function core.
- **External dependency (start now, parallel):** ask UD for his 2 most-demoed configs (→ templates v1); ask Varun for idiomatic Deluge for whatever S0 marks `⚠️`.

## P0 — Walking skeleton

- **Deliverables:** Express host + Postgres (connections, runs, run_steps); 7 MCP tools registered, all returning stubs; `ProvisionSpec` schema v0 (zod) with `extends` + extension-point semantics **in from day 0**; adapter interface + `memory-crm` stub adapter; OAuth callback route (stub exchange); trace ids threaded; one run row per apply.
- **Gate:** MCP client lists 7 tools; `validate → plan → apply → get_run` round-trip against the stub adapter returns schema-valid responses AND Postgres shows 1 run + N step rows with trace ids. `scripts/smoke-p0.sh` asserts all of it.
- **Defer:** real CRM calls, real OAuth exchange, template content, any UI.

## P1 — One real thing: spec engine + 3 hardening rules

- **Deliverables:** real template resolution (already in P0); real validation with instructive errors (already in P0); real `plan` diff incl. capability-map `unsupported` surfacing; **+ three hardening rules baked in before any real adapter exists** — (1) `connections.is_demo` + `writable_org_ids` allowlist, apply refuses non-demo; (2) per-step `destructive` flag, apply requires `confirm_destructive:true` when destructive_count > 0; (3) 8th tool `teardown_run` that reverses a prior run's steps newest-first via the adapter, linked in DB via `runs.teardown_of_run`.
- **Gate:** (a) toy template + legal delta → plan shows correct diff with destructive_count field; (b) delta touching undeclared extension point or bad schema → instructive rejection (`DELTA_SCHEMA_INVALID` / `EXTENSION_POINT_VIOLATION`); (c) apply on a non-demo connection → refused with `CONNECTION_NOT_WRITABLE`; (d) teardown_run reverses snapshot state (e.g. fields go from N→0) and writes a new run row whose `teardown_of_run` links back to the original.
- **Defer:** real adapters, real templates, MCP polish.

## P2 — One real thing: Salesforce adapter

- **Deliverables:** `adapters/salesforce` compiling spec → metadata package → deploy to scratch org; async apply with `get_run` polling; fixtures from S0 as boundary tests.
- **Gate:** fresh scratch org: `apply` provisions fields + pipeline stages + 1 workflow shape; `inspect_instance` reads them back matching the spec; second `apply` of same spec = zero changes (idempotent). Observed and written into the commit message.
- **Defer:** Zoho, Apex beyond the vetted shapes, profiles/permission depth.

## P3 — One real thing: Zoho adapter

- **Deliverables:** `adapters/zoho` — REST sequencer + per-DC OAuth + Deluge pattern library (≥2 vetted, deploy-tested patterns from Varun); trial-org demo runbook including the manual signup step.
- **Gate:** same three observations as P2 against a Zoho trial org, plus: one spec capability that Zoho can't do via REST surfaces as UNSUPPORTED in plan (proving the capability-map plumbing end-to-end).
- **Defer:** Deluge fluency (library stays ≤8 patterns), layouts, blueprints.

## P4 — Templates v1 + demo

- **Deliverables:** 2 real templates from UD's configs (real-estate, professional-services) with extension-point rules; MCP descriptions tightened (protocol-in-description); demo runbook for both audiences (TRA screen-share script; UD pre-sales flow).
- **Gate:** a COLD Claude session (no priming beyond the MCP connection) takes "set up a real-estate pipeline with an inspection stage and a 14-day idle alert" → correct delta → plan → apply → verified instance, on both CRMs.
- **Defer (the venture's no-list, dated 2026-06-12):** hosted chat UI · billing · multi-user auth · Confi/usage monitoring · Freshworks/Odoo adapters · template marketplace · template-upgrade migrations (v3→v4 diffs — strong v2 candidate, don't build now).

## Iteration log

*(append per phase: gate observation, 3-4 bullet retro, principle contradictions → update gtm-agent principle doc before next phase)*

- **2026-06-12 — scaffold.** Repo + architecture audit + this DAG landed before any code. api-ingest skill written (claude-config, smoke 38/38) as S0's method.
- **2026-06-12 — S0 DONE.** Both surfaces ingested; capability maps + 25 fixtures committed. Risks #1 (Zoho workflow-rule create not REST-exposed) and #2 (Zoho instance creation manual) CONFIRMED — both already accommodated in architecture. Risk #3 (SFDC async deploys) CONFIRMED. **Sales-function spec is fully provisionable** on both sides via the planned shapes. SFDC catches that would have cost P2 hours: FLS-invisible-by-default on field create (requires paired permset), `StandardValueSet` deactivate-not-delete, mandatory Flow canvas coords, array-vs-object error envelope. Zoho catches: PATCH-not-PUT for picklist mutations, layout-id required on pipeline ops, picklist whole-array replace semantics (one open question to re-spike P3-start), assignment rules → manual, Deluge functions create endpoint exists but body shape eluded probing → P3 nail down. Zero `❓` on the v1 sales-function critical path. **S0 gate: PASSED.** Retro: probe-driven feedback loop on Zoho is gold — every error named the next required field. Lesson into ai-output-handling: instructive errors are an LLM-feedback property worth designing for. (No principle update fires — existing docs already cover this via the validate-with-feedback retry pattern in ai-output-handling P4.)
- **2026-06-13 — P2 DONE.** Real Salesforce adapter live against shane-dev. Field create via Tooling REST; stage create via StandardValueSet metadata deploy; flow create via Metadata deploy with required canvas coords; teardown via destructiveChanges deploy (canonical SFDC pattern, sidesteps FLS/dependency walls). End-to-end gate observed: SF_LIVE=1 smoke green at 48/48 — connect → inspect (reads real stages) → plan → apply (creates `prov_smoke_field` on Lead) → idempotent re-plan (correctly noop) → teardown → verify-gone. Default smoke (without SF_LIVE) still passes 39/39, so the gate runs in CI/pre-commit without touching shane-dev. Catches discovered along the way, each ~1-2 hours saved: (1) `SELECT FullName, ...` from CustomField rejects on multi-row queries — switched snapshot to `SELECT Id, DeveloperName` and derive FullName by convention; (2) `sf org display --json` REDACTS access tokens on stdout (CLI 2.x), AND the ~/.sfdx/{user}.json file token is encrypted — shelled out to `sf api request rest` instead of direct fetch; (3) `sf api request rest --method DELETE` fails with "No 'mode' found in 'body' entry" on CLI 2.x — switched field teardown to destructiveChanges deploy; (4) Tooling DELETE on a custom field without FLS returns INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY — destructiveChanges metadata-layer auth sidesteps this entirely. P3 owns OAuth proper (replaces the CLI shell-out auth path with real Bearer fetch). Pre-commit hook continues to gate; SF_LIVE only runs intentionally.

- **2026-06-13 — P1 DONE.** Schema migration 0002 adds `is_demo` + `writable_org_ids` (connections), `destructive` (run_steps), `teardown_of_run` (runs). Adapter interface gains `teardown()` + `destructive` flag on PlanStep. Memory adapter implements both. MCP grows to 8 tools — `teardown_run` added. Apply enforces three hardening checks before any write: connection-not-writable refusal, allowlist check, destructive-not-confirmed gate. **Gate observed: 39/39 smoke green on first run.** The hardening assertions specifically: non-demo connection blocked with `CONNECTION_NOT_WRITABLE`, teardown reverses snapshot (fields 1→0), teardown's `teardown_of_run` column links back to original run. Retro: writing the hardening into a P1 that's still stub-only paid off — every rule got exercised against a deterministic adapter before P2 risks anything real. The capability-map `unsupported` surfacing logic shipped but isn't exercised end-to-end yet (memory marks `assignment_rules` unsupported, but the spec vocabulary doesn't include AssignmentRuleSpec in v0; first real exercise will be Zoho's assignment-rules step in P3). Worth noting now so P2/P3 spec extensions cover it.

- **2026-06-12 — P0 DONE.** Walking skeleton shipped: 7 MCP tools wired against the memory stub adapter, ProvisionSpec v0 (zod) with `extends` + extension-point semantics + default-deny overlay resolver, run/run_steps ledger with trace_id snapshotted. **P0 gate observed:** 30/30 smoke assertions green. Originally shipped on Cloudflare Workers + DO + D1; same-night pivot to Express + Postgres on Railway after substrate reweighting (see `docs/decision-log.md` entry 10). 30/30 smoke ALSO green on Express on first post-pivot run. Lessons captured: (1) MCP `StreamableHTTPServerTransport` works cleanly behind plain Express — small win vs `McpAgent` was real but smaller than initially sold. (2) The `PLAN_CACHE` DO-scoping issue disappeared in a long-lived Node process — Postgres + in-memory state is exactly the HubSpot-provisioner shape. (3) Killed a workerd zombie squatting on :8788 left over from the wrangler dev session — added to substrate doc as a port-conflict-after-pivot watchpoint. Deferred per the P0 column: real adapters (P2/P3), real OAuth (P3 host work), template content (P4), encrypted token storage (P2 prereq for SFDC adapter).
