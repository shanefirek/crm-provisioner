# Session Pickup — crm-provisioner

You've walked into this repo cold (or it's been a few days). This is the single doc that gets you back to full speed in ~5 minutes. Read in order; descend to specific docs only when their topic applies to your task.

## 🟡 Open thread to settle before P8 (paused 2026-06-13, end of session)

**The Zoho Deluge question.** Earlier we marked `round_robin_assignment` as `manual` because the standard implementation is a Deluge function and S0 probed `POST /crm/v8/settings/functions` once, got `REQUIRED_PARAM_MISSING: metadata`, and gave up. The harvest formalized that as `manual` with a documented one-time-paste script.

**Shane's correction:** "Deluge is not UI-only — people use Deluge." This is correct. The Zoho partner ecosystem (Ashim's network) lives in Deluge; calling it manual undersells our app. We considered the webhook workaround (Zoho fires `/webhooks/zoho/{conn_id}/round-robin` at our server, server picks owner via REST) but Shane correctly pushed back: that's dodging Deluge, not handling it. If our pitch is "we configure Zoho via Claude," we have to ship Deluge programmatically the way partners do.

**The 4 real paths to investigate, none of which we've actually probed yet:**
1. `POST /crm/v8/settings/functions` with the *correct* body wrapper. The endpoint exists; S0's body was wrong. Worth real adversarial probing — same failure mode as the wrong workflow_rules path in S0 → P4.5 harvest correction.
2. **Zoho Extension Toolkit (`zet`)** — the official CLI partners use to package Deluge as an extension. Open question: does it support **private single-customer deployment**, or only public Marketplace?
3. **Zoho FX / Catalyst** — host Deluge functions on Zoho's serverless platform, called from customer CRM via workflow_rule webhook to our FX function. Mixed-vendor.
4. **Inline Deluge in workflow_rule actions** — some action types might accept code inline rather than referencing an existing function ID. Haven't checked exhaustively.

**Concrete next step proposed (NOT executed yet):** ~30 minutes of focused probing.
- (a) Hit `POST /crm/v8/settings/functions` with multiple body shape variants (wrapper keys: `functions[]` vs `function`, `metadata.language: "deluge"`, `script` vs `code`, etc.) against the trial. If any returns 201, document it and we have a single-call solution.
- (b) Read `zet` CLI docs for private deployment. If single-customer deploy is possible, plan the adapter shape.
- Report: "here's the canonical programmatic-Deluge path, here's the working body shape, here's the v1 plan." Don't pick architecture until the probe answers it.

**Don't scaffold P8 before this answer.** The architecture of P8 depends on which of the four paths is real.

Reference: this conversation parked at "let's pause" after the spike was proposed. The api-ingest skill update from this session (claude-config commit `37a1a02`) explicitly addresses this failure mode: ⚠️/❌ verdicts are provisional until an adversarial cross-check confirms. The current `manual` verdict on round_robin_assignment violates that rule and is the reason we're stopping to revisit.

## What this repo is, in one paragraph

A CRM-agnostic provisioning engine. A user (via Claude / MCP) picks a template (real-estate, professional-services, hvac-services, manufacturing — or toy-sales for smoke), authors a small **delta** over it, runs validate → plan → apply, and the deterministic driver pushes the resulting config into Salesforce or Zoho via a per-CRM adapter. Postgres on Railway holds connections + run history. The whole product surface is **8 MCP tools**; there is no UI in v1. Equity venture with Stefan (sourcing/review), Ashim (distribution), Varun (Deluge/product) — Shane sole builder.

## What's working, today

| | Status |
|---|---|
| Spec engine + overlay resolver + extension-point default-deny | ✅ tested |
| Memory stub adapter (all ops supported) | ✅ tested |
| **Salesforce adapter** (fields, stages, flows, destructiveChanges teardown) | ✅ live against `shane-dev` org |
| **Zoho adapter** (fields, stages, pipelines, workflow_rules with task/field_update actions) | ✅ live against trial org |
| 5 templates (toy-sales, real-estate@v1, professional-services@v1, hvac-services@v1, manufacturing@v1) | ✅ all plan cleanly against live Zoho |
| 8-tool MCP server with enriched per-tool descriptions carrying adapter knowledge | ✅ |
| Hardening: is_demo gate, writable_org_ids allowlist, destructive-confirm | ✅ enforced at apply boundary |
| Teardown_run reversal of a prior run's steps | ✅ tested both adapters (with honest residue notes) |
| Pre-commit smoke gate (requires live dev server) | ✅ blocks bad commits |

**Smoke at HEAD:**
- Default (no live CRM env): **46/46**
- `SF_LIVE=1`: **55/55** (adds 9 SFDC end-to-end)
- `ZOHO_LIVE=1`: **64/64** (adds Zoho end-to-end + 4 template viability checks)
- `SF_LIVE=1 ZOHO_LIVE=1`: full 64+9

## What's NOT working / explicitly deferred

- **Zoho round_robin_assignment** is `manual` — Zoho Deluge functions are UI-only, no REST create surface. Adapter records the gap with the canonical Deluge script in the plan output. See [`docs/surfaces/zoho-deluge-patterns.md`](./surfaces/zoho-deluge-patterns.md).
- **Zoho assignment rules** (the Lead.AssignmentRules concept, separate from workflow_rules) — no v8 REST create surface. Achievable indirectly via a workflow_rule with a field_update action setting Lead.Owner.
- **Zoho email templates** — read-only via API. For email-based workflow shapes we use task actions (no template needed).
- **SFDC OAuth web flow** — adapter currently shells out to local `sf api request rest`. P3 host work replaces with proper OAuth. The CLI's `~/.sfdx/{user}.json` token is encrypted with a machine-local key; direct Bearer fetch fails.
- **Adopt-or-create on fields** — currently we noop-or-error on existing fields; we don't "adopt" them as the spec's stable-key target. Pattern-imported gap from the prior-art review (see [`docs/prior-art-public-app-provisioner.md`](./prior-art-public-app-provisioner.md) #2).
- **Reconcile / drift detection** — plan is "create-if-missing"; we don't PATCH on drift yet. Same prior-art doc, #6.
- **HubSpot adapter** — no work yet. Stefan suggested HubSpot as the obvious third CRM. Platform tribal knowledge already captured in prior-art doc.

## Read order for common tasks

| If you're doing… | Read these, in order |
|---|---|
| Anything build-related, first time back | [`CLAUDE.md`](../CLAUDE.md) → this file → [`docs/architecture.md`](./architecture.md) → [`docs/iteration-plan.md`](./iteration-plan.md) (current phase + retro) |
| Adding a new CRM adapter | [`docs/surfaces/`](./surfaces/) for the new vendor (run `api-ingest` skill if not present) → [`docs/prior-art-hubspot-provisioner.md`](./prior-art-hubspot-provisioner.md) for shape lessons → [`src/adapters/types.ts`](../src/adapters/types.ts) for the interface |
| Adding a new template | [`src/core/templates.ts`](../src/core/templates.ts) (data only, follow the existing 4 verticals) → smoke must include a plan-viability assertion for the new template against live |
| Debugging a Zoho plan/apply failure | [`docs/surfaces/zoho-surface.md`](./surfaces/zoho-surface.md) capability map + envelope quirks → [`docs/surfaces/zoho-deluge-patterns.md`](./surfaces/zoho-deluge-patterns.md) for workflow shapes |
| Debugging a Salesforce plan/apply failure | [`docs/surfaces/salesforce-surface.md`](./surfaces/salesforce-surface.md) capability map + envelope quirks |
| Demo prep | [`docs/demo-runbook.md`](./demo-runbook.md) — two scripts (pre-sales audience vs investor audience) + failure-mode rehearsal table |
| Architecture decision (esp. "should we change X") | [`docs/decision-log.md`](./decision-log.md) — every founding decision dated with rationale |

## How to actually run it

```bash
cd ~/projects/crm-provisioner
npm run db:up                                          # Docker Postgres on :5433
npm run migrate                                        # apply db/migrations/
set -a; . ./.dev.vars; set +a                          # Zoho creds into env
PORT=8788 DATABASE_URL=postgres://crm:crm@127.0.0.1:5433/crm_provisioner \
  SF_ALIAS=shane-dev \
  node --experimental-strip-types --no-warnings src/host/server.ts
```

Then in another terminal:
```bash
PORT=8788 SF_LIVE=1 ZOHO_LIVE=1 bash scripts/smoke-p0.sh  # 64+ assertions
```

**Gotcha:** if you previously had `wrangler dev` running on :8788, kill the zombie workerd first — it binds IPv4 loopback and Express's IPv6 bind quietly loses requests:
```bash
lsof -nP -iTCP:8788 -sTCP:LISTEN          # find squatters
kill -9 <pid>                              # if workerd shows up, force-kill
```

## How the MCP works (for the agent-side perspective)

A calling Claude session sees 8 tools with **rich descriptions** that carry the adapter-specific knowledge it needs to plan deltas intelligently. Specifically the descriptions tell the agent:
- Which CRMs each tool dispatches to and how
- Which capability map entries are `supported` / `unsupported` / `manual` per CRM
- The destructive-step + confirm gate semantics
- Which fields the snapshot returns per CRM
- The instructive-error pattern so the agent knows to re-author deltas based on `INVALID_DATA` / `DEPENDENT_MISMATCH` / `REQUIRED_DATA_NOT_FOUND` responses

A new Claude session opening this MCP cold can plan a delta correctly without re-reading the source code — that's by design.

## Open threads worth picking up

In priority order (each has a section in [`docs/prior-art-public-app-provisioner.md`](./prior-art-public-app-provisioner.md)):

1. **Adopt-or-create on fields** (~2 hours, high value) — when a customer's CRM already has a property by the target name, use it instead of erroring/recreating.
2. **Affected-assets / blast-radius in `plan` output** (~1 hour, high demo value) — "if you change X, here's what follows."
3. **Step ordering as a documented STEP_ORDER constant per adapter** (~30 min) — codify the implicit ordering before a future adapter writer reorders silently.
4. **Reconcile / drift detection** (~half day, post-customer-#1) — once we have a real customer, "does the org still match what we provisioned?"
5. **HubSpot adapter** (~2 days, post-MVP) — the obvious third CRM; platform tribal knowledge already in prior-art doc.

## Operational rules (must obey)

From [`CLAUDE.md`](../CLAUDE.md):
- **Targeted `git add <paths>` only** — global hook blocks `-A`.
- **Smoke gate is the discipline** — anything that breaks the smoke doesn't ship. Pre-commit hook enforces.
- **Demo orgs only** — `is_demo:true` + `writable_org_ids` allowlist enforced at the apply boundary. NEVER point at a customer's production org without explicit per-session confirmation.
- **Clean-room IP** — pattern knowledge from prior work is fine; no code copied from client/employer repos. Prior-art doc is annotated for this rule.
- **Venture conversations / transcripts live in `~/projects/job-search-2026/`**, not here. This repo is the build.

## Recent commit log (most → least recent on this branch)

```
session-pickup pt.1 (surface docs + 4-template viability)
harvest: Zoho workflows REST is live + 2 templates  (corrected S0's wrong verdict)
p4: real templates + cold-session demo + .strict() schema (MVP shipped)
p3: Zoho adapter live against trial org
p2: Salesforce adapter live against shane-dev
p1: spec engine + 3 hardening rules + teardown
p0: host pivot — Cloudflare → Express + Postgres on Railway
p0: walking skeleton — McpAgent + 7 stub tools + spec v0
s0: gate + Zoho surface + Salesforce surface
scaffold: architecture audit + iteration DAG + founding decisions
```

Each commit message contains the **gate observation** (smoke count + what was verified) — the history doubles as a chronological proof that the system has worked end-to-end at every checkpoint.
