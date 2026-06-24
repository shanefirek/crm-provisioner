# crm-provisioner

CRM-agnostic provisioning engine: natural language → typed `ProvisionSpec` (template + delta) → deterministic driver → CRM adapter. **Claude is the interface** (MCP server); there is no UI in v1. First adapters: Salesforce, Zoho.

**This is venture IP.** Strategic / business / team context tracked in local-only docs (see `docs/venture-context.local.md` if present, gitignored). Clean-room rule: pattern knowledge from Shane's own prior provisioner work is fine; **no code copied from any client or employer repo.**

## Start here

**First read on any cold session: [`docs/session-pickup.md`](./docs/session-pickup.md)** — one page, gets you back to full speed in ~5 minutes (what's working, what's deferred, how to run, recent commits). Then descend below as the task demands.

| File | When to read |
|---|---|
| `docs/venture-context.local.md` (if present — gitignored, local-only) | **FIRST for STRATEGIC/business state** — who's who, the why, where the deal stands. Not the code. Never distributed; absent in any clone you hand off. |
| [`docs/session-pickup.md`](./docs/session-pickup.md) | **FIRST for TECHNICAL state.** Cold-session handoff doc — capabilities, gaps, run-commands, read-order table |
| [`docs/iteration-plan.md`](./docs/iteration-plan.md) | Current phase, gate, defer column, full per-phase retro chronology |
| [`docs/architecture.md`](./docs/architecture.md) | Before touching structure; contains the principle audit table |
| [`docs/decision-log.md`](./docs/decision-log.md) | Why things are the way they are (dated, founding decisions + post-MVP pivots) |
| [`docs/demo-runbook.md`](./docs/demo-runbook.md) | Before any demo. Two scripts (pre-sales / investor) + failure-mode rehearsal |
| [`docs/surfaces/zoho-surface.md`](./docs/surfaces/zoho-surface.md) + [`docs/surfaces/zoho-deluge-patterns.md`](./docs/surfaces/zoho-deluge-patterns.md) | Before debugging any Zoho plan / apply / workflow issue |
| [`docs/surfaces/salesforce-surface.md`](./docs/surfaces/salesforce-surface.md) | Before debugging any SFDC plan / apply / teardown issue |
| [`docs/prior-art-public-app-provisioner.md`](./docs/prior-art-public-app-provisioner.md) | When adding a new adapter OR considering adopt-or-create / drift-detect / reconcile / HubSpot — pre-paid tribal knowledge |
| `~/projects/gtm-agent/context/principles/INDEX.md` | The governing principles (this repo follows them; they live there) |

## The one-paragraph architecture

The LLM's only creative output is a **delta** on a curated, versioned **template** (`extends: real-estate@v1` + overrides at declared extension points). Effective spec = template + delta, schema-validated, then walked through a Terraform-shaped lifecycle exposed as ~7 MCP tools: `list_templates · inspect_instance · validate_spec · plan · apply · get_run · connect_crm`. `apply` is the only write tool, gated on a confirmed plan. The driver owns sequencing/idempotency/partial-failure; adapters compile the spec per CRM (SFDC → metadata deploy via scratch-org-tested packages; Zoho → REST sequence + a small vetted Deluge pattern library). Host: **Express + Postgres on Railway** (Node 22, `StreamableHTTPServerTransport` from the MCP SDK). The core (`src/core`, `src/adapters`) imports zero host-specific modules — host swappable if it ever needs to be.

## Operational rules

- **api-ingest before adapter code.** No client/adapter work against a surface that lacks a capability map in `docs/surfaces/`.
- **Fixtures must be scrubbed** — no real tokens, no real org data committed. `.gitignore` guards the obvious paths; check before `git add`.
- **Targeted `git add <paths>` only** (global hook blocks `-A`).
- **Local dev:** `npm run db:up` → `npm run migrate` → `npm run dev`. Postgres runs in Docker (`crm-provisioner-pg` on host port 5433 to avoid colliding with any other local pg).
- **Pre-commit hook runs smoke.** Smoke requires the dev server live on `$PORT` (default 8788) AND Postgres running. If smoke fails on commit, start them first — don't `--no-verify`.
- **One real thing per phase; gates are observations** — see iteration plan. Extend `scripts/smoke-p0.sh`, never add `smoke-pN.sh`.
- **Demo instances:** SFDC = scratch orgs (scriptable). Zoho = trial orgs (manual signup, then configure) — never point at anyone's production org without explicit per-session confirmation.
- Venture conversations/transcripts live in `~/projects/job-search-2026/` (consulting-leads + transcripts), not here. This repo is the build.
