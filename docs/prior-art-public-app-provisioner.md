# Prior Art — Public-App CRM Provisioner

**Source:** an earlier same-shape provisioner repo (private; reviewed 2026-06-13 for pattern-level intel, no code copied — per the clean-room rule in `CLAUDE.md`). It solved the *same problem shape* we're solving — a vendor-API provisioning engine with stable-key indirection, adopt-or-create semantics, and a small admin surface — for HubSpot. Reading the design choices saves us from re-discovering the same gotchas the hard way.

## How sharp is it?

Sharp. The repo carries one ~520-line design doc that pre-specifies a database-driven, per-customer-configurable provisioner with a superadmin UI — **status "design, not built."** Independent of us they reached the same architectural shape (template + per-customer delta, reference-by-stable-key, resolved at provision time, reconcile-vs-create-if-missing) and wrote it down before building. Plus a post-provision-checks doc listing things automation can't catch — practitioner war stories worth their weight in gold.

Sharpness signals:
- A "single precedent" was identified inside their own codebase, then explicitly generalized — the discipline of *naming the existing pattern before extending it* is present.
- The HubSpot-specific external constraint that drives the whole design (**property internal `name` is immutable after creation**) is called out as a "hard external constraint" at the top, not a footnote.
- Identity capture distinguishes what's **reliably API-derivable** (account domain, installer email) from what isn't (company display name → operator-set fallback). Honest about the API's limits.
- The doc has a "Non-goals" section before the architecture — explicit deferral of multi-user RBAC, SSO, SPA build pipelines. The minimal-stack discipline is stated.
- A post-provision-checks file exists. **That file is the artifact of having actually run the thing against real portals and felt the things that automation missed.**

The shipped code is also notable for one thing we should copy: a **STEPS array** with documented ordering rationale ("Properties + Lead Status BEFORE Lists because list filters reference both"). This is the same shape as our `plan.steps[]` but for the BUILD order rather than the RUN order.

## Patterns worth importing (without copying code)

### 1. Stable-key indirection (we have this, sort of — could be sharpened)

Their model: definitions never contain concrete names/values. They contain a **stable key** (e.g. `dnc_status`, `MEETING_BOOKED`) that a per-portal **resolver** turns into the concrete string that portal uses. Resolution happens once per provision/reconcile; everything downstream is already correct.

```
property key "dnc_status"        ──►  effective name "do_not_contact"  ──►  filter on "do_not_contact"
lead-status key "MEETING_BOOKED" ─►  value "Demo Scheduled"            ──►  set hs_lead_status = "Demo Scheduled"
```

**Where we are:** Our `extends` + `delta` model has the same shape — templates declare base + extension points, deltas attach at declared points. **What's missing:** we don't currently support *renaming* a stable-key reference per-customer (the "for this customer, `lead_source` is actually `referral_source`" case). The pattern handles this via a per-portal override that keeps the key the same and only changes the target name. If a customer says "we already have a field called X, use that instead of creating `prov_X`," we currently can't honor it. **Worth adding when a real customer asks.**

### 2. Adopt-or-create — the move that sidesteps immutability (BIG ONE we don't have)

Their rule:

> Changing a property's internal name in settings means exactly one thing: "For this purpose, don't use the default internal name — use the internal name I'm giving you." It does NOT mean rename, migrate, copy, delete, or archive any existing property.

Provisioning behavior with an overridden target name:
1. Target name **does not exist** → create with that name (using template's type/options/label).
2. Target name **already exists** → **use it as-is.** Do not recreate, do not modify, do not touch its data.

**This is structurally important** because HubSpot/SFDC/Zoho all have varying degrees of "you can't really delete or rename this." Adopt-or-create makes the question "what's the target name?" instead of "should I create or modify?" — and the answer is always "create if absent, else just point at it."

**Where we are:** our adapters currently treat "exists" as either `noop` (good for fields with matching shape) or — implicitly — as a collision (would 4xx on create-attempt). **We don't formally adopt.** A spec that says "`property_address` is a text field on Lead" with no override silently creates `prov_property_address` (if we prefixed) or `property_address` (if not), and if a customer's portal already has `property_address` we'd collide. Adopt-or-create with stable-key indirection is the upgrade. **Worth pulling into the spec engine, post-MVP, as a single principled feature: `adopt_if_exists: true` on each spec entity, defaulting on for fields, off for stages.**

### 3. Reverse-index for orphan / link visibility (UI feature we don't have)

Each template list / workflow stores a precomputed reverse index of which property/lead-status/list keys the blob references. UI shows "Used by N assets" badge on each property; orphans (referenced by nothing) are marked safe-to-remove.

**Why this matters even pre-UI:** the same data structure powers a "blast radius" report in CLI/MCP form. Before a customer overrides a property name, the system can tell them which lists/workflows will follow the redirect. **Cheap to compute, high value at demo time.** ("If you change this field name, here's what gets affected — none of it breaks.")

**Where we are:** our overlay resolver knows which extension points were touched but doesn't build a links index across the whole effective spec. A small addition to the plan output: `affected_assets: { fields: [...], stages: [...], pipelines: [...] }` per workflow shape, etc.

### 4. Backfill discipline — the 100% mirror rule

When the prior-art repo moves from code-as-source-of-truth to DB-as-source-of-truth, the migration that creates the new tables **also seeds them** so day-one state equals today's behavior exactly. Every existing portal gets a `portal_config` row with **empty overrides** — empty overrides resolve to template, template equals the values they provision today, so the resolved config is a **100% mirror**. The 90% who use defaults stay there forever; no surprise diffs on migration day.

**Applies to us when:** we ever migrate template definitions from code (`src/core/templates.ts`) to DB-driven config. Today our templates are code-resident which is fine for MVP; if we go DB-driven (likely once we have multiple customers and per-customer customization arrives), the migration follows this exact pattern: seed-from-code, empty overrides, mirror behavior.

### 5. The drift scan

A read-only job that hits each portal's live state, records what actually exists, and flags portals provisioned under older template versions. **Turns "I assume our state mirrors the template" into "I verified it."**

**Where we are:** our `inspect_instance` MCP tool is a *per-call* drift scan but we don't persist its results or compare against expected state. A `reconcile_drift` job per connection (cron or on-demand) would surface "this customer's CRM has drifted from what we provisioned" before the next demo. **Strong post-MVP candidate.**

### 6. Reconcile engine (create-if-missing → diff-and-apply)

The shipped provisioner today is create-if-missing — it skips existing assets ("already exists, skipping" logs). Their planned reconcile mode adds the missing leg: diff desired-vs-actual, PATCH the drift, never delete unless told. Per-asset apply rules:
- Property: adopt-or-create; label/options drift on a managed property → PATCH; type mismatch → warn don't mutate
- Lead-status options: ensure required values exist
- List: create if missing, PATCH filter drift, archive if disabled
- Workflow: create if missing, re-PUT on drift, list-refs resolved fresh each run

**Where we are:** our `plan` is "create if missing, noop if exists" — same shape as their starting point. We don't PATCH on drift (e.g. if a field's `length` changed in the spec). Reconcile is the principled upgrade. Same `plan` MCP tool, richer diff semantics.

### 7. Step ordering as a first-class document

`server/src/provisioning/index.js`:

```js
const STEPS = [
  { name: 'Properties', fn: createProperties },
  { name: 'Lead Status Options', fn: ensureLeadStatusOptions },
  { name: 'Call Outcomes', fn: ensureCallOutcomes },
  { name: 'Lists', fn: createLists },
  { name: 'Workflows', fn: createWorkflows },
  { name: 'Dashboards', fn: createDashboards },
];
```

With a comment block stating WHY: "Properties and Lead Status Options must run BEFORE Lists: the standard lists filter on the custom `dnc_status` property and on `hs_lead_status` options, which must exist before HubSpot will accept the list filter definitions."

**Where we are:** our adapters internally order their operations but it's not exposed as a documented contract. Worth lifting into `spec/driver` as a `STEP_ORDER` constant per adapter, with the rationale captured next to it. **Today's adapters happen to do this correctly; nothing prevents a future adapter from reordering and silently breaking dependencies.**

### 8. Resolver as the single chokepoint for substitution

Their `translateLeadStatusInPayload` function walks the entire definition tree and substitutes `hs_lead_status` values to the portal's actual internal value (matched by label). The design doc generalizes this: ONE resolver pass handles all key→value substitutions; downstream code never deals with raw keys.

**Where we are:** our `applyOverlay` is the equivalent for spec resolution. Same principle: substitution lives in one place; everything downstream sees concrete values. **Already implemented correctly.** Validates the pattern from a second independent system.

## Post-provision checks they discovered (and we will too)

From the prior-art repo's checks doc — things their automation couldn't catch:

1. **Casing / whitespace drift in option labels.** Portal has `Meeting_Booked` with label `Meeting Booked`; provisioner adds `Meeting Booked` with label `Meeting Booked`. Normalized-label match misses the casing difference; you end up with two near-identical options and workflows fire on only one. **Manual check: open the option in UI, look for dupes.**

2. **Pre-existing properties with similar names.** A `meeting_date` already exists; provisioner creates `meeting_booked_time` alongside it. The new one has no history; workflows feed the new one only; the human eye sees both and assumes they should be merged. **Manual check: search for "similar-purpose" properties before/after provisioning.**

**Lesson for us:** add a section to `docs/demo-runbook.md` for "post-provision sanity checks per CRM" — items the smoke can't assert but a human must eyeball. We have one today (probe artifacts cleanup); should grow it with adopt-collision risks as we hit them.

## HubSpot-specific platform tribal knowledge (for a future adapter)

If we ever build a HubSpot adapter (the call positioned Salesforce + Zoho first, but HubSpot is the obvious third), these are the platform constraints worth pre-paying:

- **`hs project dev`** is the local dev server with live UI extension sync. "Developing locally" tag shown in HubSpot UI.
- **`local.json` proxy** for `hubspot.fetch()` requests during local dev. Maps HTTPS URLs to localhost. **Proxy URLs MUST be valid HTTPS** (the key, not the value). **Path-based routing is NOT supported.**
- **`CLIENT_SECRET` env var** for request signing during local dev: `CLIENT_SECRET="abc" hs project dev`.
- **`@hubspot/ui-extensions`**: only component-declared properties are valid. **`style` properties are NOT valid** on components.
- **`hubspot.fetch`** requires **fully qualified HTTPS URLs** — no relative paths. All URLs must be added to `permittedUrls.fetch` in the app's `*-hsmeta.json`.
- **`hs_lead_status`** internal value casing differs between portals — older portals use `SCREAMING_SNAKE` (NEW, IN_PROGRESS), newer ones use `PascalCase` or label-form. Looking up by label gives portal-specific internal value.
- **Workflow action targets validate strictly** — if a target value isn't a valid option on the property, flow creation HTTP 400s. (Same shape as the Zoho DEPENDENT_MISMATCH we hit.)
- **HubSpot has no API to create Call Outcomes.** The prior-art's `ensureCallOutcomes` is verify-only.

## What we should pull into the crm-provisioner roadmap

Ranked by how much they pay back per build hour:

1. **Adopt-or-create on field operations** (~2 hours, high value). Spec gains `adopt_if_exists: bool` per field; adapter checks pre-create, uses existing if name matches. Closes a real demo-blocker for customers with existing CRMs.
2. **Affected-assets / blast-radius reporting in `plan` output** (~1 hour, high demo value). Compute the reverse-index across the resolved spec; expose under `plan_id`. "If you change X, here's what follows."
3. **Step ordering as a documented STEP_ORDER constant per adapter** (~30 min, low risk now / high payoff later). Prevents a future adapter writer from silently reordering.
4. **Post-provision checks per CRM in the demo runbook** (~30 min, paid for the first time a probe-artifact bites us in a demo). Already have a stub; expand with adopt-collision risks as we hit them.
5. **Drift detection / reconcile mode** (~half day, MVP+2). Once we have a real customer, this becomes "does the customer's CRM still match what we provisioned" — answer worth knowing before every demo.
6. **Admin surface (read-only)** (~half day, MVP+3). Even just `/admin/portals` showing template version, last reconcile, drift state — operator can use it without touching Postgres.

## What we explicitly should NOT pull

- Their **superadmin UI** as a v1 — they themselves marked it "design, not built" because the team is small enough to operate from code + DB. Same for us. Defer until the operator count or customer count justifies it.
- Their **JSONB blob storage** for list/workflow definitions — we have typed `ProvisionSpec` instead, which is stricter and catches schema drift at validation. Their approach was constrained by HubSpot's blob-shaped APIs; ours doesn't have that constraint.
- **Scrypt-based admin auth** — overengineered for the current state; the day we need an admin user, OAuth via Anthropic/Google is cheaper to add than a password system to maintain.
