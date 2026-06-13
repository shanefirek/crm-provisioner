# Iteration Plan

Status: **pre-S0** (scaffold landed 2026-06-12). Phases bounded to ~4 focused hours each; SFDC demo target ≈ day 8, both adapters ≈ day 12-14 (see decision-log for the calendar-reality note).

## S0 — Dual API spike (exempt from phase rules: experiment, answer-is-the-artifact)

- **Deliverables:** run `api-ingest` on both surfaces. `docs/surfaces/zoho-surface.md` + `docs/surfaces/salesforce-surface.md` (capability maps with verdicts), scrubbed fixtures in `fixtures/{zoho,salesforce}/`, OAuth executed end-to-end once each (Zoho trial org incl. per-DC base URL; SFDC scratch org via `sf` CLI).
- **Gate:** every operation the sales-function spec needs (modules/fields, pipeline+stages, assignment rule, one workflow shape, alert) has a verdict — `✅ API / ⚠️ pattern library / ❌ manual` — zero `❓` on that list. Risks 1-3 in architecture.md confirmed or killed in writing.
- **Defer:** all code. Layouts, blueprints, scoring rules, anything outside the sales-function core.
- **External dependency (start now, parallel):** ask UD for his 2 most-demoed configs (→ templates v1); ask Varun for idiomatic Deluge for whatever S0 marks `⚠️`.

## P0 — Walking skeleton

- **Deliverables:** Workers host + D1 (connections, runs, run_steps); 7 MCP tools registered, all returning stubs; `ProvisionSpec` schema v0 (zod) with `extends` + extension-point semantics **in from day 0**; adapter interface + `memory-crm` stub adapter; OAuth callback route (stub exchange); trace ids threaded; one run row per apply.
- **Gate:** MCP client lists 7 tools; `validate → plan → apply → get_run` round-trip against the stub adapter returns schema-valid responses AND D1 shows 1 run + N step rows with trace ids. `scripts/smoke-p0.sh` asserts all of it.
- **Defer:** real CRM calls, real OAuth exchange, template content, any UI.

## P1 — One real thing: the spec engine

- **Deliverables:** real template resolution (template+delta overlay, default-deny extension points), real validation with instructive errors, real `plan` diff (create/update/conflict/UNSUPPORTED from the adapter's capability map) — still against stub adapter + one toy template.
- **Gate:** (a) toy template + legal delta → plan shows correct diff; (b) delta touching undeclared extension point → rejected with an error naming the point; (c) op the capability map marks unsupported → appears under UNSUPPORTED in plan, apply skips it with a ledger note.
- **Defer:** both real adapters, real templates, MCP polish.

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
