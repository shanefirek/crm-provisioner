# Zoho CRM — API Surface

**Probed:** 2026-06-12 (S0) → corrected and expanded 2026-06-13 (post-harvest after live P3 + workflow re-ingestion). DC=`com`, API base `https://www.zohoapis.com/crm/v8`, OAuth `https://accounts.zoho.com`. Auth: Self Client + refresh-token flow (refresh token does not expire / does not rotate). All fixtures in `fixtures/zoho/`. Companion doc: [`zoho-deluge-patterns.md`](./zoho-deluge-patterns.md) for the workflow + Deluge specifics.

> **History note.** S0 originally probed `/crm/v8/settings/workflow_rules` (wrong path) and `/crm/v8/settings/assignment_rules` (no v8 surface for AssignmentRules), got `INVALID_REQUEST` with empty details on both, and marked workflows `⚠️ pattern library` + assignment_rules `❌ manual`. **The correct path is `/crm/v8/settings/automation/workflow_rules` and friends — all workflow / action endpoints live under an `/automation/` segment S0 never tried.** Caught in the 2026-06-13 harvest. The api-ingest skill now requires a docs/web cross-check before downgrading a verdict from `❓`; this entry is the canonical reason that rule exists.

## Capability map (sales-function spec vocabulary)

| Operation | Mechanism | C/R/U/D | Quirks observed | Verdict |
|---|---|---|---|---|
| Custom field (create on Leads/Deals) | `POST /settings/fields?module=…` | C R U D | **Field visible by default** — no per-user FLS step (vs SFDC permset) | ✅ API |
| Custom field (delete) | `DELETE /settings/fields/{id}?module=…` | D | Real delete (verified 200), unlike SFDC's `IsActive:false` semantics | ✅ API |
| Pipeline (group of stages on a layout) | `POST /settings/pipeline?layout_id={layoutId}` | C R U D | Layout id REQUIRED. Body shape: `pipeline[].maps[].id` references EXISTING stage picklist ids — pipeline does NOT define new stages, it groups them. `layout_id` discovered via `/settings/layouts?module=Deals` first | ✅ API |
| Stage list (read existing) | `GET /settings/fields?module=Deals` → `Stage` field → `pick_list_values[]` | R | Stages live as picklist values on the system `Stage` field (id per-org). Each carries `id`, `forecast_type`, `forecast_category{id,name}`, `deal_category`, `probability`, `sequence_number` | ✅ API |
| Stage create / append (new picklist value) | `PATCH /settings/fields/{stageFieldId}?module=Deals` | C R U | **PATCH (not PUT/POST).** Whole-array-replace semantics — read existing values, append new ones, write the full set back. Required nested fields (learned by error message): `sequence_number`, `deal_category` (plain string ∈ `Open`/`Closed Won`/`Closed Lost`), `forecast_category` (object with `{id}` referencing an EXISTING category, NOT `{actual_value}`). Trial default categories: `Pipeline`, `Closed`, `Omitted` (no separate Won/Lost — different from SFDC). Cross-validates: a `Closed Won` deal_category requires the `Closed` forecast_category id. | ✅ API (with the gotchas) |
| Modules list | `GET /settings/modules` | R | 49 modules on a trial org incl. Leads/Deals/Contacts | ✅ API |
| Custom module create | `POST /settings/modules` | C | Unprobed — not in v1 spec vocabulary; standard Leads/Deals suffice | ❓ (deferred, not on critical path) |
| Layouts | `GET /settings/layouts?module=…` | R | Returns the layout id needed for pipeline ops | ✅ API |
| **Workflow rule (create)** | `POST /settings/automation/workflow_rules` | C R U D | **S0 corrected.** `execute_when.type` ∈ `create | edit | create_or_edit | delete | scheduler | email_received`. `repeat:true` on `edit`/`create_or_edit` DISALLOWS scheduled_actions — use `repeat:false` for idle-deal patterns. `sequence_number` starts at 1. Rule names max 100 chars, no special characters | ✅ API |
| **Automation task action (create)** | `POST /settings/automation/tasks` | C R U D | Endpoint is `/tasks` (NOT `/automation_tasks`). Wrapper key is `tasks`. Inside workflow_rule.actions[], `type` is also `"tasks"`. Body uses `field_mappings`; `Due_Date` REQUIRES `type:"execution_time"` with `period`/`unit`/`sign`/`trigger_field` (date fields cannot use `static`) | ✅ API |
| **Field update action (create)** | `POST /settings/automation/field_updates` | C R U D | `value.type:"field"` for source-field references; `static` for literals. Referenced by workflow rule.actions[] with `type:"field_updates"` | ✅ API |
| **Email notification action (create)** | `POST /settings/automation/email_notifications` | C R U D | REQUIRES a pre-existing email template (template creation is UI-only — `GET /settings/email_templates` is read-only). For MVP we use task actions instead to avoid the prerequisite | ✅ API (with manual prereq) |
| Webhook action (create) | `POST /settings/automation/webhooks` | C R U D | Unprobed by us — standard shape, available for future workflow shapes | ✅ API |
| Lead AssignmentRule (create) | none documented | — | Separate concept from workflow rules — no v8 REST create surface located. Achievable indirectly via a workflow_rule with a field_update action setting Lead.Owner | ❌ direct manual / ✅ indirect via workflow |
| Standalone Function (Deluge) create | none | — | UI-only (Setup > Developer Hub > Functions). Functions can be REFERENCED by id in workflow_rule.actions once created — but creation itself is not REST-exposed in v8 | ❌ manual (round-robin needs this — see deluge-patterns doc for the canonical script) |
| Record CRUD | `/crm/v8/{Module}` | C R U D | Standard | ✅ API |
| Email template create | none | R only | `GET /settings/email_templates` is read-only — template creation is UI-only. Plan for email-notification flows accordingly | ❌ manual |
| Org/instance creation | trial signup | — | Manual web step, no API | ❌ manual |

## Envelope quirks (adapter error-handling input)

1. **Success ≠ shape uniformity.** Reads (`200 OK`) return `{modules:[...]}` or `{fields:[...]}`. Writes (`201 Created`) return `{fields:[{code:"SUCCESS",details:{id},...}]}` — wrapped in an array even for single-row writes.
2. **Errors are typed and instructive — and our spec validation should propagate them.** `DUPLICATE_DATA` names the offending `api_name` and `json_path`. `MANDATORY_NOT_FOUND` names the missing key. `INVALID_DATA` names the expected type + `allowed_values`. `DEPENDENT_MISMATCH` names the dependee field. `REQUIRED_DATA_NOT_FOUND` with `value:"<FieldName>"` tells you which field needs a mapping. All of these are excellent LLM retry feedback.
3. **`INVALID_REQUEST` with empty `details` is the dangerous one.** Means "you asked wrong" — wrong URL, wrong method, wrong API segment, wrong wrapper. **Loop back to docs cross-check, don't conclude the operation is unsupported.** This was the trap that cost us S0's wrong workflow verdict.
4. **`API_NOT_SUPPORTED` with `supported_version`** — Zoho is migrating some endpoints to v9. So far the v8 paths we use all work; if a v9-only endpoint shows up, bump per-endpoint, not adapter-wide.
5. **`204 No Content` is success-with-empty** (e.g., functions list on fresh org). Don't treat as error.
6. **Underscore→space normalization.** Zoho normalizes `_` to ` ` in picklist `actual_value` (`Lead_In` → `Lead In`). Lookups by name must normalize both sides.
7. **Reserved zsh gotcha (build-time, not API):** in `for p in …; do …; done`, do not name the loop variable `path` — zsh aliases it to `$PATH` and breaks the environment.

## Auth

- Self Client OAuth: grant code (10-min TTL, single-use) → exchange at `accounts.zoho.{dc}/oauth/v2/token` → `access_token` (3600s) + `refresh_token` (no expiry, no rotation). Access token refreshed via `grant_type=refresh_token` at the same endpoint.
- **`api_domain` is returned in the exchange response** and is per-DC; adapter must store and use it rather than assuming `zohoapis.com`.
- Scopes used by MVP: `ZohoCRM.settings.ALL,ZohoCRM.modules.ALL`. Workflow rule create specifically wants `ZohoCRM.settings.workflow_rules.CREATE` — covered by `settings.ALL`. Automation action create wants `ZohoCRM.settings.automation_actions.CREATE` — also covered.

## Verdict summary for the spec engine

**Everything in the v1 sales-function vocabulary IS provisionable** via REST after the 2026-06-13 correction. The only true manual-step gaps are: standalone Deluge function creation (UI-only), email template creation (UI-only), AssignmentRules (no REST create surface), org/trial signup (manual web). All other operations — fields, stages, pipelines, workflow rules with task / field-update / email-notification / webhook actions — work cleanly with the body shapes documented above and in [`zoho-deluge-patterns.md`](./zoho-deluge-patterns.md).

For workflow shapes, the adapter currently implements `idle_deal_alert` (workflow rule + scheduled task action) and `field_derivation` (workflow rule + instant field-update action) as `supported`. `round_robin_assignment` is `manual` — the canonical Deluge script for the one-time UI paste is in the patterns doc.

## Probe artifacts (S0 + post-harvest, on the trial org)

- ✅ `Lead.S0_Probe_Field` — deleted in S0
- ✅ `Lead.prov_zoho_smoke` — created by P3 smoke, removed by teardown each run
- ⚠️ `S0_Probe_Pipeline` (deal layout) — created S0, DELETE shape returned 400; harmless on trial
- ✅ `Lead In` / `Qualified` / `Won` stages — added by P3+harvest smokes; idempotent
- ✅ `prov_prov_idle_alert` workflow rule + `prov_prov_idle_alert_task` task action — created by harvest smoke, NOT torn down (no teardown path implemented for workflow rules yet — next-spike candidate)
