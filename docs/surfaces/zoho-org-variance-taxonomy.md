# Zoho Org-Variance Taxonomy

Read this as the Zoho sibling to [`salesforce-org-variance-taxonomy.md`](./salesforce-org-variance-taxonomy.md). Use **org variance** as the standard term for Zoho-specific conditions that make a generic provisioning action non-trivial. Avoid "weirdness" in product, architecture, and operator docs.

## Purpose

This doc is for the future Zoho specialist layer sitting above the deterministic provisioning core. The core owns `validate -> plan -> apply -> teardown`; the specialist layer classifies **org variance** and decides whether the core can proceed safely, needs a preparatory step, or must stop and ask for human judgment.

## Scope

This taxonomy is for the bounded v1/v-next Zoho surface:

- fields
- stages / stage-picklist semantics
- pipelines / layout dependencies
- workflow rules + task / field-update / email-notification / webhook actions
- standalone Deluge functions
- assignment via workflow_rule + field_update on `Owner`

It is not a claim to cover Zoho administration broadly.

## Operating Rule

Never improvise around org variance. Always do four things in order:

1. Inspect and classify the condition.
2. Map it to a known bucket.
3. Apply the bucket's allowed remediation path.
4. Read back the intended state before declaring success.

If a condition does not map cleanly to a known bucket, stop and surface it as unsupported or human-review-required.

## Taxonomy

| Bucket | Meaning | Typical detection | Allowed response |
|---|---|---|---|
| `CUSTOM_FIELD_COLLISION_COMPATIBLE` | Target custom field already exists with compatible shape | `inspect_instance.fields_{lead,deals}` exact `api_name` match + compatible `data_type`/`length` | Adopt, do not recreate |
| `CUSTOM_FIELD_COLLISION_INCOMPATIBLE` | Target custom field exists but conflicts with requested shape | Exact `api_name` match + incompatible type/length | Stop; require rename or spec change |
| `NATIVE_STANDARD_FIELD_COLLISION` | Template field name collides with Zoho's native standard namespace | `DUPLICATE_DATA` on create, often after inspect showed a semantically equivalent standard field such as `Lead_Source` | Stop for now; narrate native-field collision honestly; roadmap = native-field adoption |
| `WHOLE_ARRAY_STAGE_MERGE_REQUIRED` | Deal stages are picklist values on one shared `Stage` field, not standalone stage records | Stage create/update path goes through `PATCH /settings/fields/{stageFieldId}` with full `pick_list_values[]` envelope | Read-merge-write only; never blind PATCH |
| `FORECAST_CATEGORY_DEPENDENCY` | Stage write depends on an existing forecast-category id compatible with the requested deal category | `DEPENDENT_MISMATCH` / `INVALID_DATA` on stage PATCH, or inspect shows only `Pipeline`/`Closed`/`Omitted` categories | Map requested stage semantics onto existing category ids, then verify |
| `STAGE_PICKLIST_PERSISTENCE` | Stage values persist because Zoho does not expose a clean public REST delete for deal-stage picklist values | Teardown/readback shows stage value remains; public DELETE shapes do not remove the picklist value | Treat as platform residue; adopt on future runs; manual admin cleanup or Deluge path later |
| `PIPELINE_LAYOUT_DEPENDENCY` | Pipeline operations require a Deals layout id before create/update/delete can occur | `inspect_instance.default_deals_layout_id` missing or pipeline call errors on missing `layout_id` | Read layout first; stop if no active Deals layout exists |
| `PIPELINE_DELETE_MARKER_PATH` | Pipeline removal appears to require an undocumented update-style delete marker rather than the obvious DELETE path | Documented DELETE returns 400; observed workaround uses `PUT ...?layout_id=...` with `_delete:true` | Treat as platform-supported-but-adapter-partial; use only after explicit verification and keep residue semantics honest until wired |
| `WORKFLOW_TRIGGER_SEMANTIC_COLLISION` | Existing workflow on the same module/trigger may already express similar business logic | Would require readback of workflow rules + trigger semantics; not currently surfaced by `inspect_instance` | Aspirational bucket today; stop rather than claiming adoption |
| `WORKFLOW_REPEAT_SCHEDULER_CONSTRAINT` | Zoho disallows scheduled actions when `repeat:true` on `edit` / `create_or_edit` workflow triggers | `INVALID_DATA` / docs constraint when combining scheduled actions with repeating edit triggers | Split shape correctly: for idle-stage patterns use `repeat:false`, or redesign the trigger |
| `EMAIL_TEMPLATE_PREREQUISITE` | Email-notification actions depend on a pre-existing email template that cannot be created over REST | Need to create `email_notifications` action but no template id exists; API surface is read-only for templates | Stop or fall back to task/webhook action; human creates template once in UI |
| `DELUGE_FUNCTION_ADMIN_GATE` | Standalone Deluge function creation is REST-capable but admin-authorized and Developer space gated | Function create validation passes but returns admin restriction / missing setup | Stop with instructive manual step; once admin-enabled, proceed through the REST builder |
| `ASSIGNMENTRULES_SURFACE_GAP` | Zoho's direct AssignmentRules concept has no v8 REST create surface | Capability map marks `assignment_rules: unsupported`; no documented endpoint | Route assignment through workflow_rule + field_update on `Owner`, or mark unsupported honestly |
| `UNDERSCORE_NORMALIZATION` | Zoho normalizes underscores to spaces in stage/pipeline display values | `inspect_instance.stages[].api_name` reads `Lead In` for spec `Lead_In` | Normalize both sides before lookup and readback |
| `AUTH_REFRESH_SCOPE_CONSTRAINT` | Zoho refresh-token auth is org/admin scoped; hosted demo fallback is single-tenant by deployment, not by chat session | Missing `api_domain` / `refresh_token` → `CONFIG_ERROR`, or hosted demo uses env-backed connect fallback | For Friday, use host-backed demo connect; for productization, move to workspace-scoped OAuth at chat layer |

## Bucket Notes

### `NATIVE_STANDARD_FIELD_COLLISION`

This is the highest-value Friday bucket because it is exactly what the live dry-run surfaced on `lead_source` vs Zoho's native `Lead_Source`. The platform reason is straightforward: Zoho already owns that schema slot. The current engine can adopt exact custom-field matches; it does not yet adopt native standard-namespace equivalents.

Exact sentence to say:

*"Zoho already had a native Lead Source field, so the engine refused to create a duplicate and completed the rest of the setup."*

### `WHOLE_ARRAY_STAGE_MERGE_REQUIRED`

This is Zoho's equivalent of a file-replacement surface. Deal stages are not independent records; they are picklist values on the system `Stage` field. That is why stage create/update is a read-merge-write operation and why blind PATCH is dangerous.

### `STAGE_PICKLIST_PERSISTENCE`

The platform appears to protect historical Deal references by not exposing a clean public REST delete for stage picklist values. That means teardown can be honest without pretending full reversibility. Prior stages persisting in the org is a platform decision, not an engine bug.

Exact sentence to say:

*"Zoho keeps stages on the global Deal Stage picklist; the public API lets us add and update them, but not cleanly delete them, because historical deals may reference them."*

### `PIPELINE_DELETE_MARKER_PATH`

Zoho's working pipeline-removal path is an update-style delete marker on the pipeline id scoped to its layout. The adapter now uses this path in teardown; the important platform lesson is still the same: the obvious documented DELETE shape is not the real operational path.

### `DELUGE_FUNCTION_ADMIN_GATE`

This is not "Zoho can't do Deluge over API." It can. The gate is authorization and org setup: an admin-authorized connection and the Functions space enabled once. That is a much better external answer than "manual forever."

Exact sentence to say:

*"Deluge functions are API-creatable in Zoho; the gate is admin authorization, not capability."*

### `AUTH_REFRESH_SCOPE_CONSTRAINT`

The Friday demo uses the host's single trial org on purpose. Zoho's refresh token is issued to a connected org/admin, not to an individual chat session. Productization therefore belongs at the chat-layer OAuth boundary, not in the adapter.

## Readback Expectations

Every bucket that proceeds through an automated path needs a matching verification check.

Examples:

- `CUSTOM_FIELD_COLLISION_COMPATIBLE`: adopted field still matches intended `data_type`/`length`
- `WHOLE_ARRAY_STAGE_MERGE_REQUIRED`: post-PATCH stage list includes the intended new values with correct probability
- `FORECAST_CATEGORY_DEPENDENCY`: stage readback shows a real forecast-category id/name pairing, not just a friendly string
- `PIPELINE_LAYOUT_DEPENDENCY`: pipeline readback is scoped to the intended active Deals layout
- `PIPELINE_DELETE_MARKER_PATH`: independent pipeline readback confirms the id is actually gone before claiming support
- `DELUGE_FUNCTION_ADMIN_GATE`: function create returns a real function id, not just schema-valid acceptance

## Product Framing

Externally, this should be described as:

- "Zoho org-variance handling"
- "org-specific constraint classification"
- "Zoho specialist planning"

Avoid:

- "Zoho weirdness"
- "random Zoho stuff"
- any wording that makes the system sound improvised

## Current Status

Today the repo has meaningful coverage for these buckets:

- `CUSTOM_FIELD_COLLISION_COMPATIBLE`
- `CUSTOM_FIELD_COLLISION_INCOMPATIBLE`
- `NATIVE_STANDARD_FIELD_COLLISION`
- `WHOLE_ARRAY_STAGE_MERGE_REQUIRED`
- `FORECAST_CATEGORY_DEPENDENCY`
- `PIPELINE_LAYOUT_DEPENDENCY`
- `PIPELINE_DELETE_MARKER_PATH`
- `WORKFLOW_REPEAT_SCHEDULER_CONSTRAINT`
- `DELUGE_FUNCTION_ADMIN_GATE` (documented/platform-proven; adapter wiring still partial)
- `ASSIGNMENTRULES_SURFACE_GAP`
- `UNDERSCORE_NORMALIZATION`
- `AUTH_REFRESH_SCOPE_CONSTRAINT`

Partial or roadmap buckets today:

- `STAGE_PICKLIST_PERSISTENCE` — residue handled honestly, not reversed
- `WORKFLOW_TRIGGER_SEMANTIC_COLLISION` — aspirational until workflow-rule readback enters `inspect_instance`
- `EMAIL_TEMPLATE_PREREQUISITE` — documented and correctly avoided, but not actively guided by template semantics

## Next-Expansion Order

1. native standard-field adoption (`Lead_Source` class collisions)
2. workflow-rule readback + trigger-semantic collision detection
3. verified pipeline delete-marker support wired into adapter teardown
4. Deluge function builder for `round_robin_assignment`
5. deeper auth model: workspace-scoped OAuth instead of host-backed demo fallback
