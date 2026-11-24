# crm-provisioner

![smoke](https://github.com/shanefirek/crm-provisioner/actions/workflows/smoke.yml/badge.svg)

> Natural language → typed `ProvisionSpec` (template + delta) → deterministic driver → CRM adapter.
> The interface is an **MCP server**: Claude is the UI; there is no web app in v1.

A CRM-agnostic provisioning engine. You describe the CRM setup you want in plain English to
Claude. Claude doesn't free-form against the CRM API: instead it picks a curated, versioned
**template** (real-estate, professional-services, hvac-services, manufacturing) and authors a small
**delta** over it. That effective spec is schema-validated, planned against the live org, and (only
after a human confirms the plan) applied through a per-CRM **adapter** (Salesforce or Zoho).

The point: the LLM's only creative output is a constrained delta over a vetted template. Everything
downstream (sequencing, idempotency, partial-failure handling, the actual CRM writes) is
deterministic and auditable.

---

## Why this exists

Standing up a CRM for a new vertical (custom fields, pipeline stages, automation) is repetitive
expert work that implementation consultants and CRM partners do by hand, per client, over and over.
This collapses that into a conversation: a partner tells Claude "set up a real-estate Zoho org with a
showing-scheduled stage and idle-deal alerts," and the engine produces a confirmable, reversible plan
and executes it. Target buyers are implementation consultants / CRM partners (Zoho UK pre-sales and a
Salesforce partner co were the first beta targets).

This is a venture project: see `CLAUDE.md` for ownership/IP rules (clean-room: no code copied from
any client or employer repo).

---

## The one-paragraph architecture

Claude (the MCP client) drives **8 MCP tools**. The core (`src/core`) owns the `ProvisionSpec` schema
(zod), template resolution (`extends: real-estate@v1` + an overlay resolver), and default-deny
extension-point validation. The adapter seam (`src/adapters/types.ts`) is the only thing the
deterministic driver knows about each CRM; adapters know nothing about templates, the spec engine, or
the host. The Salesforce adapter compiles a spec into a metadata package and deploys it via the `sf`
CLI; the Zoho adapter compiles to a REST call sequence plus a small vetted Deluge pattern library. The
host (`src/host`) is **Express + Postgres on Railway** (Node 22, `StreamableHTTPServerTransport` from
the MCP SDK) and holds connections + run history. Dependency direction is strictly downward:
core/adapters import zero host-specific modules, so the host is swappable.

```mermaid
flowchart TD
    subgraph PROPOSE["🤖 The LLM proposes (read-only)"]
        CONNECT["connect_crm<br/>OAuth / connection row"] --> TPL["list_templates<br/>versioned template library"]
        TPL --> INSPECT["inspect_instance<br/>current-state snapshot"]
        INSPECT --> DELTA["Claude authors a delta<br/>over a chosen template"]
        DELTA --> VALIDATE["validate_spec<br/>zod schema + extension-rule lint"]
        VALIDATE --> PLAN["plan<br/>resolve(template + delta) vs snapshot"]
    end

    PLAN --> STEPS["ordered steps:<br/>create · update · adopt · noop · unsupported<br/>+ destructive flags"]

    subgraph APPROVE["🧑 A human approves"]
        STEPS --> CONFIRM{"plan confirmed?"}
    end

    subgraph EXECUTE["⚙️ The deterministic driver executes"]
        CONFIRM -->|"apply(plan_id)"| DRIVER["driver: ordered steps,<br/>idempotency keys, run ledger"]
        DRIVER --> SF["salesforce adapter:<br/>spec → metadata package → sf deploy"]
        DRIVER --> ZOHO["zoho adapter:<br/>spec → REST sequence + Deluge patterns"]
        DRIVER --> LEDGER[("run ledger<br/>get_run: resumable<br/>teardown_run: reversible, newest-first")]
    end

    CONFIRM -->|"no confirmed plan id"| REFUSE["apply refuses to run"]
```

`apply` is the **only write tool**, and it refuses to run without a confirmed plan id. That's the
trust boundary: the LLM proposes, a human approves, the deterministic driver executes.

---

## Connecting Claude to it

The server speaks the MCP **Streamable HTTP** transport at **`POST /mcp`** (with `GET`/`DELETE /mcp`
for SSE notifications + session teardown). There's also `GET /health` and `GET /health/db` for
liveness, and `GET /oauth/callback` for the OAuth stub.

To use it, add the server as a **custom connector** in Claude (Settings → Connectors → "Customize" /
Add custom connector) and point it at the `/mcp` URL:

- **Local:** `http://localhost:8788/mcp`
- **Production:** your deployment's `/mcp` URL (Railway, Fly, anywhere Node 22 + Postgres runs)

Once connected, Claude sees the 8 tools with descriptions rich enough to plan a delta correctly
without reading this repo's source: that's deliberate.

### Per-CRM prerequisites for a connection

`connect_crm` returns a `connection_id` that every other tool needs. What it takes depends on the CRM:

- **`memory`**: nothing. The zero-setup path: an in-process stub adapter where all ops are supported.
  Best way to walk the whole flow before touching a real CRM.
- **`salesforce`**: the `sf` CLI installed and authed against an org, and a **`sf_alias`** (e.g.
  `shane-dev`). The alias is now *required* per connection (no silent fallback to a global env).
- **`zoho`**: a trial org plus `refresh_token`, `dc` (`com` | `eu` | `in` | `com.au`), and
  **`api_domain`** (also required: without it EU/IN/AU connections silently route to `.com` and 404).

### Safety: you can't write to prod by accident

Two gates are enforced at the `apply` boundary, not by convention:

- A connection is writable **only** if `is_demo: true`. Non-demo connections are read-only: usable
  through `inspect_instance`, never through `apply`.
- `apply` checks the target `api_domain` against the connection's `writable_org_ids` allowlist.

So the worst a misfire can do against a real org is read it.

---

## A worked example (the happy path)

A typical session, as tool calls Claude makes on your behalf:

1. **`connect_crm`** `{ crm: "memory", is_demo: true }` → returns a `connection_id`. (Use `memory` to
   try it with no CRM setup; swap for `salesforce`/`zoho` when ready.)
2. **`list_templates`** → see `real-estate@v1`, `professional-services@v1`, etc. and their declared
   extension points (where a delta is allowed to attach).
3. **`inspect_instance`** `{ connection_id }` → snapshot of the org's current fields/stages/pipelines.
4. Claude authors a **delta**: e.g. "add a `referral_source` text field on Lead": over
   `real-estate@v1`. The effective spec is `template + delta`.
5. **`validate_spec`** → zod schema + extension-rule lint. A delta touching an undeclared point is
   rejected here with an instructive error, not silently merged.
6. **`plan`** → ordered steps tagged `create` / `update` / `adopt` / `noop` / `unsupported`, with
   `destructive` flags and an `unsupported_count`. **You read this and confirm it.**
7. **`apply`** `{ plan_id }` → the driver executes steps in order with idempotency keys, writing a run
   ledger. Refuses to run without the confirmed plan id.
8. **`get_run`** → per-step results; resumable if a step failed.
9. **`teardown_run`** (if needed) → reverses that run's successful steps, newest-first. Note: it never
   deletes a field that was *adopted* (pre-existing) rather than created.

---

## Repository map

| Path | What's there |
|---|---|
| `src/core/spec.ts` | The `ProvisionSpec` zod schema: fields, stages, pipelines, workflow shapes, templates, deltas, extension points. The source of truth for the artifact. |
| `src/core/templates.ts` | The template library (data, not logic). 5 templates: `toy-sales@v0` (smoke), `real-estate@v1`, `professional-services@v1`, `hvac-services@v1`, `manufacturing@v1`. |
| `src/core/overlay.ts` | The overlay resolver: applies a delta onto a template at declared extension points, default-deny. |
| `src/adapters/types.ts` | The adapter interface + `CapabilityMap` (the supported/unsupported/manual verdict per operation per CRM). **Read this first to understand the seam.** |
| `src/adapters/salesforce.ts` | SFDC adapter: fields, stages, flows; teardown via `destructiveChanges`. Live against a scratch/dev org via the `sf` CLI. |
| `src/adapters/zoho.ts` | Zoho adapter: fields, stages, pipelines, workflow_rules (task / field_update actions). REST against a trial org, per-DC. |
| `src/adapters/memory.ts` | In-memory stub adapter (all ops supported): used by the default smoke without a live CRM. |
| `src/adapters/lifecycle.ts` | Shared step-lifecycle / driver helpers used by adapters. |
| `src/host/mcp.ts` | The 8 MCP tool registrations and their rich, knowledge-carrying descriptions. |
| `src/host/server.ts` | Express host, MCP transport, OAuth callback routes. |
| `src/host/db.ts`, `db/migrations/` | Postgres persistence: connections + run ledger. 7 migrations (initial → hardening → typed errors → permanent failures → watchdog → sf_alias → token-at-rest encryption). |
| `src/host/{errors,permanent_failures,watchdog,logger}.ts` | Typed error categories, dead-letter recording, the apply watchdog, structured logging (pino). |
| `scripts/smoke-p0.sh` | The one growing smoke script: MCP round-trips + live-CRM gates. Extended every phase; **never** add `smoke-pN.sh`. |
| `scripts/test-*.mjs` | Unit tests (classifiers, overlay resolver, retry-after parsing). Run via `npm test`. |
| `docs/` | The real documentation. Start with `docs/session-pickup.md`. |

---

## Documentation: where the real knowledge lives

This README is the front door; `docs/` is the house. In reading order:

| Doc | When |
|---|---|
| `docs/session-pickup.md` | **First on any cold session.** What's working, what's deferred, exact run commands, recent commits. |
| `docs/architecture.md` | Before touching structure. Includes the principle-audit table mapping each design rule to where it's enforced. |
| `docs/iteration-plan.md` | Current phase, gate, deferred work, full per-phase retro chronology. |
| `docs/decision-log.md` | Why things are the way they are (e.g. the P0 pivot off Cloudflare Workers onto Express + Postgres). |
| `docs/surfaces/salesforce-surface.md` | Before debugging any SFDC plan/apply/teardown: the capability map + API envelope quirks. |
| `docs/surfaces/zoho-surface.md` + `docs/surfaces/zoho-deluge-patterns.md` | Before debugging any Zoho plan/apply/workflow issue, and for programmatic Deluge. |
| `docs/prior-art-public-app-provisioner.md` | Before adding a new adapter or considering adopt-or-create / drift-detect / reconcile / HubSpot. |
| `docs/demo-runbook.md` | Before any demo: pre-sales and investor scripts + failure-mode rehearsal. |
| `CLAUDE.md` | Operational rules, IP/clean-room constraints, read-order table. |

---

## Running it locally

Requires Node 22+ and Docker (for Postgres). Postgres runs on host port **5433** to avoid colliding
with any other local pg.

```bash
npm install
npm run db:up                 # Docker Postgres → crm-provisioner-pg on :5433
npm run migrate               # apply db/migrations/
set -a; . ./.dev.vars; set +a # Zoho creds + TOKEN_AT_REST_KEY into env (gitignored file)

PORT=8788 DATABASE_URL=postgres://crm:crm@127.0.0.1:5433/crm_provisioner \
  SF_ALIAS=shane-dev \
  node --experimental-strip-types --no-warnings src/host/server.ts
```

Or just `npm run dev` (tsx watch) once the env is exported.

> **`TOKEN_AT_REST_KEY` is required**: a 32-byte base64 random value in `.dev.vars`. The server
> refuses to start without it. The production key is different from the dev key (per-environment, by
> design).

### Smoke (the discipline)

The smoke script is the gate: anything that breaks it doesn't ship, and a pre-commit hook enforces
it (so the dev server + Postgres must be live when you commit; don't `--no-verify`).

```bash
PORT=8788 bash scripts/smoke-p0.sh                       # default: no live CRM needed (memory adapter)
PORT=8788 SF_LIVE=1 bash scripts/smoke-p0.sh             # adds Salesforce live gates
PORT=8788 ZOHO_LIVE=1 bash scripts/smoke-p0.sh           # adds Zoho live gates
PORT=8788 SF_LIVE=1 ZOHO_LIVE=1 bash scripts/smoke-p0.sh # everything

npm test                                                 # unit tests (overlay, classifiers, retry-after)
```

CI (`.github/workflows/smoke.yml`) runs the default smoke (Postgres 16 service, Node 22) on every push
and PR to `main`.

> **Port gotcha:** if a stale `workerd`/`wrangler dev` is squatting on :8788 it binds IPv4 loopback and
> Express's IPv6 bind silently loses requests. `lsof -nP -iTCP:8788 -sTCP:LISTEN` to find it, then
> `kill -9`.

---

## Deployment

Production runs on **Railway**. Deploys are `railway up` from local. Migrations run on every container start via the
`startCommand` chain in `railway.toml`. Env vars (`TOKEN_AT_REST_KEY`, `ZOHO_*`, `DATABASE_URL` via
reference variable) are set on the Railway service.

---

## What works today

- Spec engine + overlay resolver + default-deny extension points: ✅ tested
- Memory stub adapter (all ops): ✅ tested
- **Salesforce adapter** (fields, stages, flows, `destructiveChanges` teardown): ✅ live against a dev org
- **Zoho adapter** (fields, stages, pipelines, workflow_rules w/ task + field_update actions): ✅ live against a trial org
- 5 templates, all plan cleanly against live Zoho: ✅
- 8-tool MCP server with adapter-knowledge-carrying tool descriptions: ✅
- Hardening at the apply boundary: `is_demo` gate, `writable_org_ids` allowlist, destructive-confirm: ✅
- `teardown_run` reversal of a prior run's steps (both adapters, with honest residue notes): ✅
- Token-at-rest encryption (pgcrypto) for stored CRM credentials: ✅
- Adopt-or-create on fields: bind to a pre-existing field instead of erroring; teardown never deletes an adopted field: ✅ (P20)

## Known gaps / deferred

- **Zoho `round_robin_assignment`** is emitted as `manual`: the adapter doesn't yet wire
  `createDelugeFunction`, though Deluge functions are REST-creatable (admin-gated; body shape proven).
  Plan output carries the canonical Deluge script meanwhile.
- **Zoho assignment rules** (the `Lead.AssignmentRules` concept): no v8 REST create surface; achievable
  indirectly via a workflow_rule field_update on `Lead.Owner`.
- **Zoho email templates**: read-only via API; email-shaped workflows use task actions instead.
- **SFDC OAuth web flow**: the adapter currently shells out to the local `sf` CLI; proper OAuth host
  work is pending.
- **Reconcile / drift detection**: plan is create-if-missing; no PATCH-on-drift yet.
- **HubSpot adapter**: not started; the obvious third CRM (tribal knowledge captured in the prior-art doc).

See `docs/session-pickup.md` and `docs/iteration-plan.md` for the live status of all of these.

---

## Operating rules (must obey)

- **Demo/sandbox orgs only.** `is_demo:true` + a `writable_org_ids` allowlist are enforced at the apply
  boundary. Never point at a customer's production org without explicit per-session confirmation.
- **Targeted `git add <paths>` only**: a global hook blocks `git add -A`.
- **Fixtures must be scrubbed**: no real tokens or org data committed.
- **Smoke is the gate**: extend `scripts/smoke-p0.sh`, don't add new per-phase smoke scripts.
- **api-ingest before adapter code**: no adapter work against a CRM surface that lacks a capability map
  in `docs/surfaces/`.
