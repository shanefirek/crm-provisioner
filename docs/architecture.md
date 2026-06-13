# Architecture

## Purpose

Turn a plain-English CRM setup request into a configured Zoho or Salesforce instance, deterministically and auditable. The LLM authors a small **delta** over a curated **template**; a deterministic driver compiles and applies the effective spec through a per-CRM adapter. Interface is an MCP server (Claude = UI). Buyers per the 2026-06-12 venture call: implementation consultants/partners (cost optimization), with Zoho UK pre-sales and TRA's Salesforce partner co as beta targets.

## Data flow

```
Claude (MCP client)
  │ connect_crm ──────────────► OAuth callback (Worker route) ──► connections (D1, per-DC for Zoho)
  │ list_templates ───────────► template library (versioned specs + extension-point rules)
  │ inspect_instance ─────────► adapter.read(connection) ──► current-state snapshot
  │ [authors delta]
  │ validate_spec ────────────► schema + extension-rule lint (instructive errors)
  │ plan ─────────────────────► resolve(template+delta) vs instance ──► diff {create|update|conflict|UNSUPPORTED}
  │ [human confirms plan]
  │ apply ────────────────────► driver: ordered steps, idempotency keys, run ledger (D1)
  │                                 ├── adapters/salesforce: spec → metadata package → sf deploy
  │                                 └── adapters/zoho: spec → REST sequence + Deluge pattern stamps
  └ get_run ──────────────────► step-by-step results, resumable
```

## Component → package map

| Component | Package | Imports |
|---|---|---|
| ProvisionSpec schema, template resolution (extends/overlay), validation | `spec/` | zod only — **no CF, no adapter imports** |
| Driver (step sequencing, idempotency, run ledger interface) | `spec/driver` | `spec/`, adapter interface |
| Adapter interface + capability map type | `adapters/types` | `spec/` types |
| Salesforce adapter | `adapters/salesforce` | `adapters/types` |
| Zoho adapter (+ Deluge pattern library) | `adapters/zoho` | `adapters/types` |
| MCP server (7 tools), OAuth routes, D1 persistence | `mcp/` (the Workers host) | everything above |
| Template library | `templates/` | spec schema (data, not code) |

Dependency direction is strictly downward in this table. The core stays portable (Railway/Node port = host-layer swap only).

## Principle audit table

| Principle | Where it lands here | Enforcement |
|---|---|---|
| ai-output-handling (trust tiers) | LLM emits delta only (tier 1→2 via zod at `validate_spec`); `apply` requires confirmed plan (tier 4 = human-approved before CRM write) | `apply` rejects without a plan id; schema validation at the MCP boundary |
| ai-output-handling (non-delegable) | Judgment = delta authoring + plan confirmation, stays with orchestrator/human; driver is deterministic | No LLM calls inside driver or adapters — lint: no SDK imports there |
| configuration-philosophy (tier 3) | Templates are versioned artifacts (`real-estate@v1`, never edited in place); runs snapshot `template@version + delta + spec_hash` | Run ledger columns NOT NULL; template files immutable by convention + review prompt |
| configuration-philosophy (fail-closed) | Extension-point rules: a delta touching an undeclared point is rejected, not merged | Overlay resolver default-deny |
| error-handling (categories + retry) | Boundary (CRM 5xx → retry/backoff) vs data (bad delta → instructive reject) vs config (bad template → fail at load); dead/permanent failures recorded on the run | Typed errors in `spec/driver`; retry only on BoundaryError |
| error-handling (quality watchdog) | `apply` halts on first non-retryable step failure with resumable ledger — no half-configured org without a receipt | Run ledger per-step status; `get_run` exposes it |
| multi-tenancy-isolation | Connections are tenant-scoped rows (org id + DC + token); no cross-connection reads; per-DC OAuth endpoints for Zoho | Connection id required on every tool call; D1 queries always filtered by connection |
| testing-philosophy (fixture/boundary) | Adapter tests born from api-ingest fixtures; smoke = MCP round-trip on stub adapter; SFDC gate runs against scratch org | `scripts/smoke-p0.sh` extended per phase; fixtures committed scrubbed |
| cost-unit-economics | LLM spend is the caller's (Claude session); CRM API calls are free-tier; only watch SFDC scratch-org limits + Zoho trial expiry | Noted in capability maps; no paid rungs exist yet — re-audit if one appears |
| modular-monorepo-shape | Table above; core/adapters/host split | Import-direction review prompt; core has zero CF imports (greppable) |
| build-iteration-discipline | `docs/iteration-plan.md` DAG with gates + defers | This doc + plan exist before code (today) |

## Known structural risks (from S0 to confirm/kill)

1. **Zoho workflow-rule creation may not be REST-exposed** → adapter verdict becomes `pattern library` (Deluge) or `manual`; plan must surface it as UNSUPPORTED, not fail.
2. **Zoho instance creation is not API-able** (trial signup manual) → demo runbook includes the manual step explicitly.
3. **SFDC metadata deploy latency** (seconds-minutes) → `apply` must be async with `get_run` polling from day 0 — shapes the driver interface before any adapter exists.
