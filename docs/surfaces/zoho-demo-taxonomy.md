# Zoho Demo Taxonomy — what we can do, what's gated, what to say

> Self-contained brief. Audience: (1) Shane, before walking into the demo; (2) a coding agent reviewing for accuracy. Companion doc to [`zoho-surface.md`](./zoho-surface.md) (the raw capability matrix) and [`zoho-deluge-patterns.md`](./zoho-deluge-patterns.md). This doc is the **speak-to-it layer** — capability + reason + demo line.
>
> Last verified against the live Zoho trial: 2026-06-19. Adapter source of truth: `src/adapters/zoho.ts`. Capability map source: `src/adapters/zoho.ts:38-54`.

## Operating frame

The engine does NOT freeform against Zoho. It walks: `connect_crm → inspect_instance → validate_spec → plan → apply → (get_run / teardown_run)`. Every Zoho operation in a `plan` resolves to one of three verdicts:

1. **`supported`** — engine can do it via REST in one or more idempotent calls
2. **`manual`** — engine names it honestly, plan tags it with a documented one-time human or admin step
3. **`unsupported`** — Zoho doesn't expose a REST surface for this; engine refuses to fake it

The Zoho taxonomy below tells you which operations land in which verdict and **why**. The "why" matters because Ashim is ex-Zoho BD with 17 years in the ecosystem — he'll respect platform-honest answers and detect made-up ones.

## What we CAN do (✅ supported)

These all run end-to-end via the v8 REST API. The engine plans and applies them deterministically.

| Operation | Endpoint | Demo-relevant notes |
|---|---|---|
| **Custom field on Lead/Deal/Contact/Account** | `POST /settings/fields?module=…` | Visible by default — no per-user FLS step (unlike Salesforce). Real-estate template ships 5 custom Lead fields. |
| **Custom field delete** | `DELETE /settings/fields/{id}?module=…` | Real delete (verified 200). Teardown path. |
| **Stage create / append (picklist value)** | `PATCH /settings/fields/{stageFieldId}?module=Deals` | Whole-array-replace semantics. Stages are picklist values on the global Deal `Stage` field — not separate entities. |
| **Pipeline (group of stages)** | `POST /settings/pipeline?layout_id=…` | Pipelines reference existing stage picklist ids. Layout id required (read once via `/settings/layouts?module=Deals`). |
| **Workflow rule (create + edit + delete + scheduler + email_received)** | `POST /settings/automation/workflow_rules` | All 5 trigger types supported. |
| **Workflow action: task** | `POST /settings/automation/tasks` | Built-in `Due_Date` handling. Used by `idle_deal_alert`. |
| **Workflow action: field update** | `POST /settings/automation/field_updates` | Used by `field_derivation`. |
| **Workflow action: email notification** | `POST /settings/automation/email_notifications` | Requires a pre-existing email template (UI-only prereq). MVP uses task actions instead. |
| **Workflow action: webhook** | `POST /settings/automation/webhooks` | Available; not currently used by templates. |
| **Standalone Deluge function create** | `POST /crm/v8/settings/functions` | **REST-creatable (admin-gated).** Body shape proven 2026-06-14 against live trial. Adapter wiring pending — currently `round_robin_assignment` still emits `manual`. |
| **Records CRUD (Lead/Contact/Deal/etc.)** | `/crm/v8/{Module}` | Standard. Not used by provisioning, but available. |
| **Module + layout reads** | `GET /settings/modules`, `GET /settings/layouts` | Used by `inspect_instance`. |

**Workflow shapes we support today** (`src/adapters/zoho.ts:42-44`):

- ✅ `idle_deal_alert` — workflow_rule + scheduled_actions[tasks]. *"Alert me if a deal sits in a stage longer than N days."*
- ✅ `field_derivation` — workflow_rule + instant_actions[field_updates]. *"When stage changes to X, set forecast_category to Y."*
- ⏳ `round_robin_assignment` — needs Deluge. Capability proven; adapter wiring pending. Today the plan output emits a documented manual Deluge script.

## What's GATED (and why)

These are the moments where the engine declines to act, or where the platform forces a partner-side decision. Each gate has a reason rooted in Zoho's platform design, not our engine.

### Gate 1: Native Zoho field collisions on `Lead_Source` (and similar standard picklists)

- **The case**: real-estate template tries to create custom `lead_source` field. Zoho already has a native `Lead_Source` (picklist) on Lead module.
- **What happens**: plan marks the step as `adopt`; apply skips the create call and binds to Zoho's native `Lead_Source` field.
- **Why this is correct, not broken**: native standard-namespace fields are now a first-class adoption target on the Zoho path. The engine treats `lead_source` as the semantic slot and `Lead_Source` as Zoho's canonical realization of that slot.
- **What to say in demo**: *"Zoho already had a native Lead Source field, so the engine adopted it instead of creating a duplicate."*
- **Roadmap**: same pattern should extend to the SFDC native-standard-field lane next.

### Gate 2: Stage picklist value DELETION via REST

- **The case**: stages exist as picklist values on the global Deal `Stage` field. They can be created via PATCH; they cannot be deleted via any public v8 endpoint.
- **What happens**: PATCH with `_delete:true` returns `"field updated"` but silently no-ops. DELETE on `/settings/fields` returns `INVALID_REQUEST_METHOD`. DELETE on `/settings/stages` same.
- **Why this is correct, not broken**: Zoho's design choice around historical referential integrity. Deleting a stage that's referenced by historical Deal records would orphan reports and forecast snapshots. The web admin UI does allow it (with cascade warnings); the public REST API doesn't surface that operation.
- **Effect on demo**: orphaned stages from prior runs remain in the picklist. On re-apply, plan shows them as `noop` (engine adopted them).
- **What to say in demo**: *"Stages persist in Zoho's picklist by design — Zoho doesn't expose REST deletion for them, to protect historical Deal references. Engine recognizes prior stages and adopts them rather than re-creating."*
- **Workaround**: 60-second manual delete in admin UI (Setup → Modules and Fields → Deals → Stage → manage picklist values).
- **Roadmap**: route deletion through Deluge layer where it's actually possible.

### Gate 3: Pipeline DELETE via REST

- **The case**: same family as Gate 2 — pipelines can't be deleted via standard `DELETE /settings/pipeline/{id}`.
- **Workaround discovered**: `PUT /settings/pipeline/{id}?layout_id=…` with body `{"pipeline":[{"_delete":true}]}` does delete. Tested 2026-06-18, returns `"Pipeline updated"` and the pipeline is gone.
- **Verdict**: ✅ supported (with the documented quirk).
- **Why surface this**: Ashim might ask "how do you remove a pipeline?" — confident answer: *"PUT with delete marker — same pattern Zoho's own admin UI calls internally. Not documented but stable."*

### Gate 4: Lead AssignmentRules (the v8 concept, separate from workflow rules)

- **The case**: Zoho has a separate `AssignmentRules` concept for Lead routing — distinct from workflow rules. No documented v8 REST create surface.
- **Indirect path**: achievable via a workflow_rule with a `field_update` action setting `Lead.Owner`. The engine can do this; the template just doesn't currently use it.
- **Verdict**: ❌ direct unsupported; ✅ indirect via workflow.
- **What to say**: *"Lead routing — we don't use Zoho's AssignmentRules concept directly because there's no v8 REST surface. We route via workflow_rule + field_update on Lead.Owner. Same outcome, different mechanism."*

### Gate 5: Email template creation

- **The case**: `GET /settings/email_templates` is read-only. There's no `POST` surface for email template creation.
- **Why**: Zoho's email template editor is UI-only by design (rich text, merge fields, branding). Equivalent to many SaaS products.
- **Effect on engine**: email-notification workflow actions require a pre-existing template, so the engine uses task actions instead for MVP. Plan output names the gap explicitly.
- **What to say if asked**: *"Email templates are a one-time admin UI step in Zoho — same in Salesforce and HubSpot. Once the template exists, we automate every workflow that uses it."*

### Gate 6: Multi-tenant OAuth

- **The case**: today the MCP uses a single-tenant env-fallback. The `connect_crm` tool defaults to the host's Zoho refresh_token when none is passed. Works for demos and Shane's own org.
- **Why this is the right Friday answer**: avoids the demo-killer "paste your refresh_token in chat" moment. Single-tenant matches the demo reality (one Zoho trial).
- **Productization gap**: real customer orgs need their own OAuth flow. The configMy chat layer needs a "Connect Zoho" button → consent screen → token stored against workspace. That's the 2-week piece named in venture-context.
- **What to say if asked**: *"Today the demo connects via host-provided credentials. For productization we wire OAuth at the chat layer — customer clicks Connect Zoho, consents, token is workspace-scoped. ~2 weeks of work, same pattern as my prior HubSpot provisioner."*

### Gate 7: Org / trial signup

- **The case**: no API to create a fresh Zoho trial. Manual web step.
- **Verdict**: ❌ manual.
- **Effect**: every customer onboard requires the customer (or partner) to create their own Zoho trial first.

## The 5 templates (what gets demo'd)

Source: `src/core/templates.ts`. All plan cleanly against live Zoho.

| Template | Lead fields | Deal stages | Pipeline | Workflows |
|---|---|---|---|---|
| **real-estate@v1** (the Friday demo) | property_address, bedrooms, bathrooms, lead_source, buyer_or_seller | Inquiry Received → Showing Scheduled → Offer Made → Under Contract → Closed Won | Residential | none in base |
| professional-services@v1 | service_line, engagement_model, estimated_hours, budget_signal | Discovery → Proposal Sent → SOW Negotiation → Booked | Consulting | none in base |
| hvac-services@v1 | service_type, equipment_brand, property_address, urgency, estimated_value | Inquiry Received → Estimate Sent → Job Scheduled → Completed → Invoiced & Paid | Service Jobs | none in base |
| manufacturing@v1 | product_category, expected_volume, required_by_date, spec_attached | RFQ Received → Spec Review → Sample Sent → Sample Approved → Contract Sent → PO Received | Wholesale | none in base |
| toy-sales@v0 | (none — smoke test only) | (one pipeline, three stages) | (smoke) | none |

**Demo line for "is 5 fields enough?":** *"This is the v1 base template — partner firms layer deltas on top per client. Watch — I can add three more fields live."* (Then run a delta-add prompt.)

## Demo cheat-sheet — Ashim's likely questions, with the true answer

| Question | True answer |
|---|---|
| "Is this possible — natural language to Zoho config?" | Yes, end-to-end. Watch. (Then run the demo.) |
| "How long would a partner spend doing this manually?" | ~45 min for the 11 steps in real-estate@v1; the engine does it in ~30 seconds. |
| "Why did Lead Source fail?" | Zoho already has a native Lead_Source field. Engine refused to clobber it. That's the schema-awareness guardrail. |
| "Why did the stages noop?" | Zoho doesn't expose REST stage deletion (historical-record integrity). Engine recognized stages from a prior session and adopted them — deterministic, no re-creates. |
| "Can it remove things?" | Yes — custom fields, pipelines (via the PUT delete-marker workaround), workflow rules. Stages only via UI due to platform gate. |
| "Can it route leads (round-robin)?" | Yes — capability proven via Deluge functions (REST-creatable, admin-gated). Adapter wiring is the next phase. Today the plan emits the documented manual Deluge script. |
| "Can a customer connect their own Zoho?" | Today the demo uses a host-managed connection. For customer use, ~2 weeks of OAuth-at-chat-layer work (button in configMy, customer consent flow, workspace-scoped token). |
| "What about Salesforce?" | SFDC adapter is built — same engine, same template surface, fields/stages/Flows/permission sets/teardown all working. Multi-tenant OAuth same gap (2 weeks). |
| "What about HubSpot?" | Pattern from Shane's prior HubSpot provisioner; not started here yet — obvious third CRM. |
| "How do you handle different customer orgs being weird?" | The org-variance taxonomy in `docs/surfaces/salesforce-org-variance-taxonomy.md` — 13 documented buckets for SFDC. Zoho equivalent in this doc. Each bucket has a deterministic detector + allowed response + verification check. |
| "What's the moat?" | Structured org inspection + variance taxonomy + remediation playbooks + verification discipline + bounded automation honesty. Anyone can call Metadata API — we have a system that survives real customer orgs. |

## Honest-disclosure list (the things to NOT pretend about)

- ✅ Engine is dogfooded against live SFDC and live Zoho — 126/126 smoke with both adapters live.
- ✅ Real-estate template lands clean on Zoho — native `Lead_Source` is adopted instead of colliding.
- ✅ Idempotency is real (plan shows noops on re-apply for things that landed).
- ✅ Deluge function REST creation is proven (body shape validated). Adapter wiring is next.
- ⏳ No customers paying yet. Pre-customer infrastructure.
- ⏳ Multi-tenant OAuth not built. Single-tenant env fallback in place for demo and partner-internal use.
- ⏳ Drift detection / reconcile not built. Plan = create-if-missing today.
- ⏳ HubSpot adapter not started.
- ⏳ Stage picklist deletion via Deluge (the v2 path) not yet implemented.

## Where to find the source of truth

- **Capability map (machine)**: `src/adapters/zoho.ts:38-54`
- **Surface (capability matrix + envelope quirks)**: `docs/surfaces/zoho-surface.md`
- **Deluge patterns + workflow shapes + the 4-path Deluge investigation**: `docs/surfaces/zoho-deluge-patterns.md`
- **Templates (data)**: `src/core/templates.ts`
- **SFDC org-variance taxonomy (the structural sibling doc)**: `docs/surfaces/salesforce-org-variance-taxonomy.md`
- **Prior-art for HubSpot adapter design**: `docs/prior-art-public-app-provisioner.md`

## Notes for the reviewing agent

- Verify Operations table against `src/adapters/zoho.ts:38-54` (the capability map constant). If they drift, the code is truth.
- Verify Templates table against `src/core/templates.ts` definitions. Same rule.
- Verify Gates against the actual REST behavior — easy to live-probe via the prod MCP (`POST connect_crm` with env fallback, then `inspect_instance`).
- This doc is **demo-language**. Where it claims "engine refused to clobber X" — verify that's the actual adapter behavior, not aspirational. If it's aspirational, mark the line as `(roadmap)`.
- Confidence-level audit: any line in the cheat-sheet table that overpromises should be flagged. Goal is honest demo-readiness, not marketing.
