# crm-provisioner

CRM-agnostic provisioning engine: natural language → typed `ProvisionSpec` (template + delta) → deterministic driver → CRM adapter. **Claude is the interface** (MCP server); there is no UI in v1. First adapters: Salesforce, Zoho.

**This is venture IP** (Shane sole builder; Stefan advisor/review, Ashim distribution, Varun Deluge/product — equity structure under negotiation as of 2026-06-12, nothing signed). Clean-room rule: pattern knowledge from Shane's own prior provisioner work is fine; **no code copied from any client or employer repo.**

## Start here

| File | When to read |
|---|---|
| [`docs/iteration-plan.md`](./docs/iteration-plan.md) | Always — current phase, gate, defer column |
| [`docs/architecture.md`](./docs/architecture.md) | Before touching structure; contains the principle audit table |
| [`docs/decision-log.md`](./docs/decision-log.md) | Why things are the way they are (dated) |
| `~/projects/gtm-agent/context/principles/INDEX.md` | The governing principles (this repo follows them; they live there) |
| `~/projects/gtm-agent/context/reference/infra/cloudflare-workers-substrate.md` | Workers gotchas, pre-paid |

## The one-paragraph architecture

The LLM's only creative output is a **delta** on a curated, versioned **template** (`extends: real-estate@v1` + overrides at declared extension points). Effective spec = template + delta, schema-validated, then walked through a Terraform-shaped lifecycle exposed as ~7 MCP tools: `list_templates · inspect_instance · validate_spec · plan · apply · get_run · connect_crm`. `apply` is the only write tool, gated on a confirmed plan. The driver owns sequencing/idempotency/partial-failure; adapters compile the spec per CRM (SFDC → metadata deploy via scratch-org-tested packages; Zoho → REST sequence + a small vetted Deluge pattern library). The core (`spec/`, driver) imports nothing Cloudflare-specific — Workers is the host, not the architecture.

## Operational rules

- **api-ingest before adapter code.** No client/adapter work against a surface that lacks a capability map in `docs/surfaces/`.
- **Fixtures must be scrubbed** — no real tokens, no real org data committed. `.gitignore` guards the obvious paths; check before `git add`.
- **Targeted `git add <paths>` only** (global hook blocks `-A`).
- **One real thing per phase; gates are observations** — see iteration plan. Extend `scripts/smoke-p0.sh`, never add `smoke-pN.sh`.
- **Demo instances:** SFDC = scratch orgs (scriptable). Zoho = trial orgs (manual signup, then configure) — never point at anyone's production org without explicit per-session confirmation.
- Venture conversations/transcripts live in `~/projects/job-search-2026/` (consulting-leads + transcripts), not here. This repo is the build.
