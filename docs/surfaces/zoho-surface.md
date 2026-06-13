# Zoho CRM — API Surface (api-ingest S0)

**Probed:** 2026-06-12 against a US trial org (DC=`com`, base `https://www.zohoapis.com/crm/v8`, OAuth `https://accounts.zoho.com`). Auth: Self Client + refresh-token flow (refresh token does not expire / does not rotate). All fixtures in `fixtures/zoho/`.

## Capability map (sales-function spec vocabulary)

| Operation | Mechanism | C/R/U/D | Quirks observed | Verdict |
|---|---|---|---|---|
| Custom field (create on Leads/Deals) | `POST /settings/fields?module=…` | C R U D | **Field visible by default** — no per-user FLS step (vs SFDC permset). Field id and api_name returned; `field created` message | ✅ API |
| Custom field (delete) | `DELETE /settings/fields/{id}?module=…` | D | Real delete (verified 200), unlike SFDC's `IsActive:false` semantics | ✅ API |
| Pipeline (group of stages on a layout) | `POST /settings/pipeline?layout_id={layoutId}` | C R U D | Layout id is REQUIRED (omitting it returns `INVALID_REQUEST`). Body shape: `pipeline[].maps[].id` references EXISTING stage picklist ids — pipeline does NOT define new stages, it groups them. `layout_id` discovered via `/settings/layouts?module=Deals` first | ✅ API |
| Stage list (read existing) | `GET /settings/fields?module=Deals` → `Stage` field → `pick_list_values[]` | R | Stages live as picklist values on the system `Stage` field (id `7473109000000002565` on this org — per-org). Each value carries `id`, `forecast_type`, `forecast_category{id,name}`, `deal_category`, `probability`, `sequence_number` | ✅ API |
| Stage create (new picklist value) | `PATCH /settings/fields/{stageFieldId}?module=Deals` | C R U | **PATCH (not PUT/POST)**. Required nested fields, learned by probe — instructive errors named each: `sequence_number`, `deal_category` (plain string, NOT `{actual_value}` object), `forecast_category` (object with `{id}` referencing existing category, NOT `{actual_value}`). Returned 200 SUCCESS on full payload but the new value did **not** appear in subsequent reads — Zoho appears to require *whole-array replace* semantics for picklist mutations (P3 spike to confirm; adapter strategy: read-merge-write) | ⚠️ API, whole-array replace |
| Modules list | `GET /settings/modules` | R | 49 modules on a trial org incl. Leads/Deals/Contacts | ✅ API |
| Custom module create | `POST /settings/modules` | C | Unprobed (not v1 critical — standard Leads/Deals suffice) | ❓ |
| Layouts | `GET /settings/layouts?module=…` | R | Returns layout id needed for pipeline ops | ✅ API |
| Workflow rule (create) | — | R only | `GET /settings/workflow_rules` returns `INVALID_REQUEST_METHOD` (read shape unknown without rule context); no documented public create endpoint in v8 REST. Confirms **architecture.md risk #1** | ⚠️ pattern library or manual |
| Assignment rule (create) | — | R only | `POST /settings/assignment_rules` rejected `INVALID_REQUEST` with empty schema; no v8 REST create surface located. Adapter cannot create from spec — manual or attach to existing | ❌ manual |
| Standalone Function (Deluge) create | `POST /settings/functions` | likely C | Endpoint exists (rejects `REQUIRED_PARAM_MISSING: metadata`) but exact body shape eluded probing — body wrapper differs from other settings endpoints. **The Deluge pattern library belongs here** in P3; intake = Varun's vetted snippets, deployed via this endpoint when shape is nailed down | ⚠️ pattern library (P3 nail down) |
| Record CRUD | `/crm/v8/{Module}` | C R U D | Standard | ✅ API |
| Org/instance creation | trial signup | — | Manual web step, no API. Same as Zoho's overall onboarding | ❌ manual |

## Envelope quirks (adapter error-handling input)

1. **Success ≠ shape uniformity.** Reads (`200 OK`) return `{modules:[...]}` or `{fields:[...]}`. Writes (`201 Created`) return `{fields:[{code:"SUCCESS",details:{id},...}]}` — wrapped in an array even for single-row writes.
2. **Errors are typed and instructive.** `DUPLICATE_DATA` names the offending `api_name` and `json_path`. `MANDATORY_NOT_FOUND` names the missing key. `INVALID_DATA` names the expected type. This is the best property for spec validation feedback — adapter can pass these through as `validate_spec` lint messages.
3. **`INVALID_REQUEST` with empty `details` is a dead-end** (no per-field info). Observed on `workflow_rules` GET and `assignment_rules` POST — both effectively "you can't do this here." Adapter must map this code to "operation unsupported," not retry.
4. **`204 No Content` is success-with-empty** (e.g., functions list on fresh org). Don't treat as error.
5. **Reserved zsh gotcha (build-time, not API):** in `for p in …; do curl …; done`, do not name the loop variable `path` — zsh aliases it to `$PATH` and nukes your environment.

## Auth

- Self Client OAuth: grant code (10-min TTL, single-use) → exchange at `accounts.zoho.{dc}/oauth/v2/token` → `access_token` (3600s) + `refresh_token` (no expiry, no rotation). Access token refreshed via `grant_type=refresh_token` at the same endpoint.
- **`api_domain` is returned in the exchange response** and is per-DC; adapter must store and use it rather than assuming `zohoapis.com`. Confirms architecture.md per-DC OAuth/API design.
- Scope used for v1: `ZohoCRM.settings.ALL,ZohoCRM.modules.ALL`. `ZohoCRM.org.READ` not in scope → `OAUTH_SCOPE_MISMATCH` on `/org` (acceptable; not used).

## Probe artifacts (cleanup status)

- ✅ `Lead.S0_Probe_Field` — deleted
- ⚠️ `S0_Probe_Pipeline` (deal layout) — delete returned 400; harmless on a trial org, will be torn down with the trial. Investigate the delete shape in P3.
- (no stage was actually added — see PATCH quirk above)

## Verdict summary for the spec engine

**Most of v1 is provisionable via REST:** fields (incl. cleaner delete than SFDC, no FLS step), pipelines as stage-groupings, and reads across the surface. **Two gaps that shape the architecture:** (a) workflow/automation creation is **not** REST-exposed → goes to the Deluge pattern library, attached via the Functions endpoint once its body shape is nailed in P3; (b) assignment rules have no public v8 create surface → adapter marks UNSUPPORTED, plan flags it, demo runbook documents the manual step. Architecture risk #1 (workflow-rule creation may not be REST-exposed) **CONFIRMED**. Risk #2 (instance creation is manual) **CONFIRMED**. Both already accommodated in the architecture (`UNSUPPORTED` verdict in capability map → diff surfaces it; demo runbook owns the manual step).

The stage-create whole-array-replace behavior is the one unresolved item — re-spike at start of P3 with read-merge-write semantics. Does not block adapter design.
