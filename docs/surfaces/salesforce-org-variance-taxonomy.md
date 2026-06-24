# Salesforce Org-Variance Taxonomy

Use **org variance** as the standard term for Salesforce-specific conditions that make a generic provisioning action non-trivial. Avoid "weirdness" in product, architecture, and operator docs. Read this as the Salesforce sibling to [`zoho-org-variance-taxonomy.md`](./zoho-org-variance-taxonomy.md).

## Purpose

This doc is for the future Salesforce specialist layer sitting above the deterministic provisioning core. The core owns `validate -> plan -> apply -> teardown`; the specialist layer classifies **org variance** and decides whether the core can proceed safely, needs a preparatory step, or must stop and ask for human judgment.

## Scope

This taxonomy is for the bounded v1/v-next Salesforce surface:

- fields
- field visibility / FLS
- stages / stage semantics
- record-triggered automation
- assignment configuration
- record-type / layout exposure

It is not a claim to cover Salesforce administration broadly.

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
| `FIELD_COLLISION_COMPATIBLE` | Target field already exists with a compatible shape | Same API name, compatible type/length | Adopt, do not recreate |
| `FIELD_COLLISION_INCOMPATIBLE` | Target field exists but conflicts with the requested shape | Same API name, incompatible type/length | Stop; require rename or spec change |
| `FLS_GAP` | Field exists but intended user visibility is missing | FieldPermissions missing or incomplete | Grant via managed PermissionSet, then verify |
| `LAYOUT_EXPOSURE_GAP` | Field exists but is not visible in the intended admin/user surface | Layout inspection shows field absent | Add to supported layout target, then verify |
| `RECORD_TYPE_PICKLIST_RESTRICTION` | Value exists globally but is unavailable for the target record type | Record-type-specific picklist readback fails | Apply record-type exposure step, then verify |
| `VALIDATION_RULE_BLOCK` | Existing org rules reject the intended write path | Vendor error points to validation failure | Stop unless an approved remediation exists |
| `AUTOMATION_NAME_COLLISION` | Flow/rule/api name already exists | Metadata lookup finds same developer name | Adopt if semantically equivalent; otherwise stop |
| `AUTOMATION_SEMANTIC_CONFLICT` | Existing automation conflicts with the intended behavior | Readback shows same trigger/object but different business logic | Stop; human judgment required |
| `WHOLE_FILE_METADATA_MERGE_REQUIRED` | Salesforce surface replaces a full metadata file, not an individual asset | AssignmentRules, StandardValueSet, layout-style deploy surfaces | Read-merge-write only; never blind replace |
| `ASSIGNMENT_REPLACE_RISK` | Lead assignment changes could unintentionally replace customer-owned routing | Existing assignment config present on object | Stop unless merge semantics are explicitly implemented |
| `DEPENDENCY_ORDERING_CONSTRAINT` | Requested change depends on another metadata asset landing first | Record type/layout/field dependency graph | Split into ordered steps, then verify each boundary |
| `ENVIRONMENT_AUTH_CONSTRAINT` | Host-side auth/runtime constraint prevents safe execution | Missing `sf_alias`, missing CLI auth, deploy path unavailable | Stop with instructive config error |
| `OUT_OF_SURFACE_CUSTOMIZATION` | Request exceeds the supported provisioning surface | Request requires unsupported objects/features | Reject honestly and name the unsupported area |

## Bucket Notes

### `FIELD_COLLISION_COMPATIBLE`

This is the canonical adopt-or-create path. The specialist layer should prefer adoption over recreation when the field already satisfies the spec's structural intent.

### `FIELD_COLLISION_INCOMPATIBLE`

This is not a retry case. It is a business/API-name collision requiring a rename, a template change, or a human decision to bind to the existing field semantics.

### `FLS_GAP`

Salesforce field-create is incomplete until intended visibility is verified. A successful Tooling POST is a provisional write, not the end state.

### `LAYOUT_EXPOSURE_GAP`

This is separate from FLS. A field may be queryable and still absent from the UI the buyer expects to see.

### `WHOLE_FILE_METADATA_MERGE_REQUIRED`

This is one of the highest-value buckets because it turns Salesforce from "API call" thinking into "metadata graph" thinking. The planner must know which surfaces are file-replacement surfaces and route through merge discipline automatically.

### `ASSIGNMENT_REPLACE_RISK`

Treat assignment changes as high-blast-radius until proven otherwise. They affect live routing behavior, not just admin metadata.

## Readback Expectations

Every bucket that proceeds through an automated path needs a matching verification check.

Examples:

- `FIELD_COLLISION_COMPATIBLE`: adopted field still matches intended type family
- `FLS_GAP`: `FieldPermissions` row exists with intended read/edit state
- `LAYOUT_EXPOSURE_GAP`: layout readback shows field placement
- `RECORD_TYPE_PICKLIST_RESTRICTION`: value is available on the target record type
- `AUTOMATION_NAME_COLLISION`: deployed/adopted automation matches intended object + trigger shape

## Product Framing

Externally, this should be described as:

- "Salesforce org-variance handling"
- "org-specific constraint classification"
- "Salesforce specialist planning"

Avoid:

- "Salesforce weirdness"
- "random org stuff"
- any wording that makes the system sound improvised

## Current Status

Today the repo has partial coverage for these buckets:

- `FIELD_COLLISION_COMPATIBLE`
- `FIELD_COLLISION_INCOMPATIBLE`
- `FLS_GAP`
- `WHOLE_FILE_METADATA_MERGE_REQUIRED`
- `ENVIRONMENT_AUTH_CONSTRAINT`

The next serious Salesforce expansion should deepen inspection and verification around:

1. layout exposure
2. record-type restrictions
3. assignment configuration
4. automation semantic conflicts
