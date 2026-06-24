# Demo Runbook — crm-provisioner MVP

Two scripts: one for a partner pre-sales / consultant audience, one for an investor audience. Both use the same backend; the words and the shape change. Audience-specific framing tracked in local-only docs (see CLAUDE.md routing).

## Pre-flight (do once)

```bash
cd ~/projects/crm-provisioner
npm run db:up                 # docker compose up -d  (Postgres on :5433)
npm run migrate               # apply db/migrations/*.sql
set -a; . ./.dev.vars; set +a # Zoho client + refresh token in env
SF_ALIAS=shane-dev PORT=8788 npm run start
```

Verify the service is healthy:

```bash
curl -sS http://127.0.0.1:8788/health
# {"ok":true,"service":"crm-provisioner","phase":"P0","host":"express"}
```

Optional but recommended before any live demo: run the full live smoke once to confirm both adapters work end-to-end.

```bash
PORT=8788 ZOHO_LIVE=1 SF_LIVE=1 bash scripts/smoke-p0.sh
# 59/59 green = both demo orgs are reachable + writable + cleanable
```

## Demo A — Pre-sales / consultant audience

**Audience:** A Zoho or Salesforce implementation consultant. They configure CRMs for a living. The pitch is "the boring 80% of the config you do by hand becomes one Claude conversation."

**Setup (one time, before they walk in):** add the MCP server to Claude Desktop / Cursor / Claude Code as a remote MCP at `http://127.0.0.1:8788/mcp`.

**Live demo (5–7 min):**

1. *"Let's set up a Zoho instance for a hypothetical real-estate brokerage."*
2. In Claude: *"Connect me to my Zoho demo and show me what templates we have."*
   - Tool calls: `connect_crm` (Zoho refresh token from .dev.vars; api_domain + DC pre-filled) → `list_templates`.
3. *"Use the real-estate template. Before you apply, inspect the org so we can see what's there."*
   - `inspect_instance` returns the live snapshot. Show how it grounds the model.
4. *"Add an 'Inspection Scheduled' stage between Showing and Offer Made, with 40% probability."*
   - Claude authors a delta with one new stage + an updated pipeline reference. Calls `validate_spec` → `plan`.
   - Show the plan output: every step has `create | update | noop | unsupported`, and Zoho's workflow shapes are flagged UNSUPPORTED (honest about limits).
5. *"Looks good — apply."*
   - `apply` runs. Show the run_id come back. `get_run` reads back the per-step ledger.
6. Open Zoho in a browser tab: the new stage exists, the pipeline carries it.
7. *"For demos, we leave a clean org behind."* → `teardown_run` reverses the field deletion. Show the field is gone.

**The two beats that land:**
- *"The LLM didn't write any Zoho API calls. It wrote a delta. The driver wrote the API calls — deterministically, with idempotency and a plan-then-apply gate."*
- *"Everything we just did is recorded — what spec produced what state, which steps ran, which ones were unsupported. You can audit it later, or hand it to a client as proof."*

## Demo B — Investor audience

**Audience:** An investor who's seen 40 "AI configures CRM" demos that are wrappers over GPT. The pitch is *what makes ours not that*.

**Setup (one time):** Same MCP wiring. Live demo runs against the Salesforce dev org for investors leaning into the SFDC ecosystem.

**Live demo (4–5 min):**

1. *"We pick Salesforce because that's where the spend is. Same MVP runs against Zoho — same backend, different adapter."*
2. *"Watch what the LLM has to author. Not Apex. Not metadata XML. A delta on a vetted template."*
3. Claude: `list_templates` → `connect_crm` (salesforce, dev alias) → `inspect_instance` → user asks for one extension.
4. `plan` shows the diff. Point at the `unsupported` and `destructive` flags: *"This is what we mean by structural — the LLM physically cannot author into points the template doesn't declare extensible. And destructive ops require an explicit confirm."*
5. `apply` runs. Show the Salesforce UI updating.
6. *"Now the moat."* Open `src/core/spec.ts` for 10 seconds. *"This is the typed contract every CRM compiles to. New CRM = new adapter file. New vertical = new template. The hard part isn't here — it's the encoded domain judgment in the templates, which is where partners contribute."*
7. *"Teardown."* `teardown_run`. The Salesforce field is gone via `destructiveChanges`. *"Clean exit. Every demo is a no-op long-term."*

**The two beats that land for an investor:**
- *"AI does the thing it's good at — authoring a small typed delta — and the deterministic driver does the unsafe thing. Same shape as Terraform, with a vetted-template moat."*
- *"Salesforce works. Zoho works on the same engine. Adapter cost is days, not months. Distribution to partner-firm networks IS the plan; we ship both."*

## Failure-mode rehearsal (what to do if a demo breaks live)

| Symptom | Cause | Fix in the demo |
|---|---|---|
| `apply` returns `CONNECTION_NOT_WRITABLE` | The connection was created with `is_demo:false` or the URL isn't in `writable_org_ids` | Re-create the connection with the correct flags. Sells the safety story. |
| `apply` returns `DESTRUCTIVE_NOT_CONFIRMED` | The plan touched something the adapter marked destructive | Re-call `apply` with `confirm_destructive:true`. Sells the safety story. |
| Zoho `apply` returns status `partial` | Cross-validation rejected a stage; `get_run` shows which | Show the row + the instructive error. "Zoho talks back — our system surfaces it verbatim, model can self-correct." Then teardown. |
| SFDC deploy times out | Metadata API can be slow under load | `get_run` shows status `running`. Keep narrating; SFDC will catch up. |
| MCP session lost | Server restart between init and call | Re-init the session; plan_id is process-scoped so re-plan first. Don't try to recover the same plan_id. |

## What's deliberately NOT in the MVP (and the honest answer if asked)

- **Hosted chat UI for non-Claude users.** Coming as a thin skin over the same MCP — *not* a rewrite.
- **Workflow creation in Zoho.** Workflow rules + task/field-update actions are supported. `round_robin_assignment` still emits a manual note pending the `createDelugeFunction` builder — but Deluge function creation is REST-capable (admin-gated; body shape proven 2026-06-14, see zoho-deluge-patterns.md), not a research unknown.
- **Pipeline DELETE in Zoho.** The documented DELETE shape returned 400 in S0, but the adapter now uses Zoho's update-style delete marker on the pipeline id scoped to its layout. Stage picklist values still persist separately.
- **OAuth web flow for SFDC.** Currently uses the local `sf` CLI auth chain. P3 host work (post-MVP) replaces with a proper redirect.
- **Multi-tenant deployment.** Local Postgres for dev; Railway one-tenant deploy for first customer. Multi-tenancy is a P5 question, not blocking the MVP.

## Re-running the live smoke after the demo

```bash
PORT=8788 ZOHO_LIVE=1 SF_LIVE=1 bash scripts/smoke-p0.sh
```

Should still be 59/59 if no one touched the orgs between demo and re-run. If it's not, the failure tells you what got left behind — investigate that BEFORE the next demo.
