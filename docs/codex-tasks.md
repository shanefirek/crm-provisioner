# Codex Task Brief — Env Fallback for `connect_crm` (Zoho)

> Self-contained brief for a coding agent. Repo: `crm-provisioner`. Goal: make the Friday demo work without the chat agent having to ask the user for a Zoho refresh_token. One small, low-risk change. Do NOT scope creep into OAuth landing pages, bearer tokens, or multi-tenant work — those are explicitly deferred to post-Friday.

## Context (read this first)

This MCP server provisions CRM orgs (Zoho, Salesforce) from natural language. A managed agent in `configMy` (separate repo, not yours) connects to this server's `/mcp` endpoint and calls 8 tools — `connect_crm`, `inspect_instance`, `validate_spec`, `plan`, `apply`, `get_run`, `teardown_run`, `list_templates`.

The Friday demo blocker: when the user types "set up a real-estate Zoho org," the agent calls `connect_crm` and the tool requires the agent to pass `refresh_token`, `dc`, and `api_domain`. The agent doesn't have these, so it asks the user — ~90 seconds of mid-chat credential-paste dead air. Bad demo.

The fix: those three values are **already on Railway prod** as `ZOHO_REFRESH_TOKEN`, `ZOHO_DC`, `ZOHO_API_BASE`. The server has them; the tool just doesn't read from env. Make it fall back to env when the agent calls it without those args. Single-tenant — that's exactly Friday's reality.

## Task

### File: `src/host/mcp.ts`

Locate the `connect_crm` tool registration (around line 110). The handler is the `async ({ crm, org_label, is_demo, writable_org_ids, api_domain, access_token, refresh_token, dc, sf_alias }) => { ... }` callback around line 131.

**Before** the existing `if (crm === "zoho" && !api_domain)` guard (line 136), add a fallback block:

```ts
// Demo single-tenant fallback: if the agent calls connect_crm for zoho without
// credentials, use the host's env-provided defaults. Lets the agent connect
// without dragging the user through a refresh_token paste mid-chat.
// Multi-tenant OAuth (workspace-scoped tokens) is the real fix — tracked separately.
if (crm === "zoho") {
  if (!refresh_token && process.env.ZOHO_REFRESH_TOKEN) {
    refresh_token = process.env.ZOHO_REFRESH_TOKEN;
  }
  if (!dc && process.env.ZOHO_DC) {
    dc = process.env.ZOHO_DC;
  }
  if (!api_domain && process.env.ZOHO_API_BASE) {
    api_domain = process.env.ZOHO_API_BASE;
  }
}
```

Note: the destructured parameters are `const`-bound from the function signature. You may need to `let` them or reassign via a local variable. Use whichever pattern matches the file's existing style — check what's already in the file before deciding.

### Acceptance criteria

1. **No env set, no args passed** → existing CONFIG_ERROR behavior preserved (agent still gets the instructive error pointing at api_domain). This is the multi-tenant path; don't break it.
2. **Env set, no args passed** → tool returns a valid `connection_id`, env values are used, row appears in `connections` table with encrypted `refresh_token_encrypted`.
3. **Args explicitly passed** → tool uses the passed values (env fallback only kicks in for missing args). Passed args win.
4. **Memory + salesforce code paths** → unchanged. Only the `zoho` branch gets the fallback.

### Smoke

Default smoke must stay green:

```bash
PORT=8788 bash scripts/smoke-p0.sh
```

If a Zoho-live smoke is gated by `ZOHO_LIVE=1`, run that too:

```bash
PORT=8788 ZOHO_LIVE=1 bash scripts/smoke-p0.sh
```

Required local state: Postgres running (`npm run db:up`), migrations applied (`npm run migrate`), dev server live on `$PORT`. `.dev.vars` is gitignored and contains the needed env values — `set -a; . ./.dev.vars; set +a` before starting the server.

### Extra assertion to add to smoke (optional but recommended)

In `scripts/smoke-p0.sh`, find the existing Zoho `connect_crm` block. Add a new assertion: call `connect_crm` with `{ crm: "zoho", is_demo: true }` and NO refresh_token / dc / api_domain in the body. Expect a `connection_id` back (proves the env fallback wired). Increment the assertion count in the script header comment.

### What NOT to do

- Do NOT add new routes (no `/connect/zoho`, no callbacks).
- Do NOT add bearer-token middleware on `/mcp`.
- Do NOT touch the system prompt or `configMy` repo (different repo, not yours).
- Do NOT add new env vars. Use the three that already exist.
- Do NOT add per-workspace, per-tenant, or per-user logic. This is single-tenant by design.
- Do NOT touch the salesforce branch.
- Do NOT add a UI.

### Deploy

After local smoke passes and you've committed, deploy to Railway:

```bash
railway up
```

Then hit the prod server to verify the fallback works there too. The env vars `ZOHO_REFRESH_TOKEN`, `ZOHO_DC`, `ZOHO_API_BASE` are already set on the Railway service (don't touch them).

Quick prod sanity:

```bash
curl -X POST https://crm-provisioner-production.up.railway.app/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"connect_crm","arguments":{"crm":"zoho","is_demo":true}}}'
```

Expect a JSON response containing a `connection_id`. If you get a CONFIG_ERROR back, the env vars aren't being read — debug.

### PR shape

One commit, single concern. PR title: `feat(p21): env fallback for zoho connect_crm — fixes mid-chat credential dead air`. Body should briefly note the single-tenant scope and reference this brief.

### Stop conditions

Stop and surface the issue (don't try to work around it) if:
- The env vars aren't actually present on Railway (`railway variables --service crm-provisioner` to check)
- The fallback breaks the existing CONFIG_ERROR path for multi-tenant
- Smoke regresses on any non-Zoho path
- The `connections` table insert path has changed materially since this brief was written

## Why this matters strategically

Friday is a demo to a BD/seller (Ashim) who proposed this venture. Pre-validation, before paying customers. The win conditions are: clean Zoho demo end-to-end, no credential dead air, UD demo date locked. This patch removes the only known UX gap in the demo flow. Everything else (OAuth landing page, bearer tokens, workspaces, multi-tenant) is post-Friday foundation work tracked separately and explicitly deferred.

Real fix for productization is removing `connect_crm` from the agent's tool list entirely and having `configMy` session-context-inject the workspace's connection — that's the 2-week chat-layer-OAuth piece. NOT this brief's scope.
