# Salesforce — API Surface (api-ingest S0)

**Probed:** 2026-06-12 against `shane-dev` (Developer Edition, `orgfarm-e843df8348-dev-ed.develop.my.salesforce.com`, API v62.0). Method: raw REST via `sf api request rest` (signed passthrough, unmodified vendor envelopes) + Metadata API via `sf project deploy/retrieve`. All fixtures in `fixtures/salesforce/`.

## Capability map (sales-function spec vocabulary)

| Operation | Mechanism | C/R/U/D | Quirks observed | Verdict |
|---|---|---|---|---|
| Custom field (create) | Tooling REST `POST /tooling/sobjects/CustomField` | C R U D | **Two-step op:** created field has NO field-level security — invisible to ALL profiles via API until a PermissionSet grants it (probed: SOQL returns `No such column`). Adapter must pair every field-create with a permset fieldPermissions entry + assignment | ✅ API (+ mandatory FLS step) |
| Field visibility (FLS) | Metadata deploy `PermissionSet` + `sf org assign permset` | C R U | Assignment is per-user/profile; adapter should ship ONE permset per provisioned spec and assign to the connecting user | ✅ API |
| Pipeline stages (Opportunity) | Metadata deploy `StandardValueSet:OpportunityStage` | C R U ~D | NOT REST-addressable (`INVALID_TYPE_FOR_OPERATION` on tooling GET-by-id). **Deploy omitting a value DEACTIVATES it, never deletes** (probed: stage survives restore with `IsActive:false`). Plan/diff must model deactivate-not-delete; teardown leaves residue | ✅ Metadata API |
| Stage read | REST `query FROM OpportunityStage` | R | Clean; `ApiName`, `IsActive`, `DefaultProbability` | ✅ API |
| Assignment rule (Lead) | Metadata deploy `AssignmentRules` | C R U D | Deployed first try; whole-file semantics (the file is ALL rules for the object — partial deploys replace the set; adapter must read-merge-write) | ✅ Metadata API |
| Workflow/alert shape | Metadata deploy `Flow` (record-triggered, AutoLaunched) | C R U D | `locationX/locationY` REQUIRED on `start` AND every node (canvas coords as mandatory metadata — docs don't lead with this). Active on deploy with `<status>Active</status>`. **Flows run in system context: write fields the API user can't read** | ✅ Metadata API |
| Record CRUD (Lead etc.) | REST `sobjects/` | C R U D | Standard | ✅ API |
| Org/instance creation | scratch orgs via Dev Hub | C D | Dev Hub NOT yet enabled on shane-dev — **P2 prerequisite** (Setup → Dev Hub, manual UI step, one-time) | ⚠️ pending Dev Hub |
| Modules/custom objects | Metadata `CustomObject` | C R U D | Unprobed — same deploy path as fields, low risk | ❓ (not spec-critical for v1 sales-function: standard Lead/Opportunity suffice) |

## Envelope quirks (adapter error-handling input)

1. **Success = JSON object; error = JSON ARRAY** of `{message, errorCode, fields[]}`. A naive `response.errorCode` check misses every error. (Fixtures: `create-customfield-response.json` vs `create-customfield-duplicate-error.json`.)
2. Error codes are typed and instructive: `DUPLICATE_DEVELOPER_NAME` names the colliding field — good re-prompt material for validate-layer messages.
3. Metadata deploys are **async** (seconds): `sf project deploy start` polls internally; a raw-API adapter must poll `deployRequest` — confirms the architecture.md risk-3 decision that `apply` is async with `get_run` from day 0.
4. `sf org display` redacts access tokens; `sf api request rest` is the sanctioned raw-probe path (keeps token out of scripts entirely).

## Auth

OAuth web flow standard; S0 used CLI-managed auth. For the Worker: standard authorization-code flow, instance URL returned per-org (my-domain), token refresh standard. No DC-routing complexity (unlike Zoho).

## Probe artifacts left in shane-dev (cleanup list)

`Lead.S0_Probe_Field__c`, permset `S0_Probe_Perms` (assigned), flow `S0_Probe_Flow` (ACTIVE — writes the probe field on every Lead create), assignment rule `S0 Probe Rule` (inactive), stage `S0 Probe Stage` (inactive), one Lead `S0Probe` + earlier flow-fired Lead. Harmless in a dev org; delete before using shane-dev for anything demo-facing.

## Fixtures inventory

`limits.json` · `opportunity-stages.json` · `create-customfield-response.json` (success) · `create-customfield-duplicate-error.json` (negative) · `standardvalueset-query.json` · `standardvalueset-opportunitystage.json` (REST-by-id rejection) · `fls-invisible-field-error.json` (negative) · `flow-fired-verify.json` (pre-FLS undefined) · `flow-fired-verify-after-fls.json` (end-to-end proof) · `probe-stage-verify.json` · `probe-stage-after-restore.json` (deactivate-not-delete proof)

## Verdict summary for the spec engine

Everything in the v1 sales-function vocabulary is provisionable: fields + FLS (Tooling/Metadata), stages (Metadata, deactivate-semantics), assignment rules (Metadata, whole-file), flows/alerts (Metadata, coords required). The adapter is a **metadata-package compiler + a Tooling client + a permset generator**, all async-aware. Architecture risk #3 (deploy latency → async apply) CONFIRMED. No `❌ manual` on the critical path except one-time Dev Hub enablement for scratch orgs (P2).
