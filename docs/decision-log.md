# Decision Log

## 2026-06-12 — Founding decisions (from the 6/12 group call + same-day design session)

1. **CRM-agnostic core, adapters per CRM.** Spec/driver shared; adapters are the marginal cost. Serves the "Salesforce-step-2" story regardless of which adapter demos first.
2. **Template + delta, not free generation.** The LLM authors a small delta over a curated versioned template ("set up once, customize with tooling" vs "AI from scratch over and over"). Templates are the moat (domain + partner judgment, encoded); deltas are the only LLM-generated content. Escape hatch: no-template full-spec path, dry-run-mandatory, lower trust — also the template intake funnel.
3. **MCP server is the only v1 interface.** Product framed as "a Claude interface, a chat"; the investor track wants MVP not decks. Hosted chat for non-developer users (pre-sales reps, consultants) is v2 — a skin over the same backend, not a rewrite. One unavoidable web surface: the OAuth callback route.
4. **Tool surface = spec lifecycle (Terraform shape), never raw CRM ops.** 7 tools; `apply` is the only write, gated on a confirmed plan. Raw-API MCP ("worked okay... don't know if enough" was the early POC finding) is the named anti-pattern.
5. **~~Cloudflare Workers host, portable core.~~** Superseded same night — see entry 10.
6. **Deluge = compile target with a vetted pattern library (≤8), not a language to learn.** Domain SMEs are the Deluge oracle; patterns enter the library only deploy-tested. Same fail-closed shape as the spec's extension points.
7. **Adapter order deliberately unresolved.** Plan builds SFDC first (scratch orgs = scriptable demos; investor-track fundraising lean) but Zoho-first remains arguable (distribution lead = customer #1 pipeline). To be settled in a 1:1 — distribution/fundraising decision, not technical. The agnostic core makes the cost of being wrong one phase's reordering.
8. **Calendar reality:** the build window is ~2 weeks against parallel external commitments. Realistic plan: S0+P0+P1+P2 (SFDC demo) inside 2 weeks; P3-P4 the week after. Beating it is upside, not the plan.
9. **IP hygiene:** clean-room rule in CLAUDE.md observed throughout; venture structure and external-party context tracked in local-only docs (see CLAUDE.md routing).

## 2026-06-12 (late) — entry 10: Host pivot, Cloudflare → Railway

**Decision:** Express + Postgres on Railway, not Workers + D1.

**What flipped the call:**
- The strongest argument I'd undersold was that **a prior public-app-provisioner pattern is a working answer key for this exact problem shape** (OAuth callback → token storage → step-orchestrated provisioning pipeline → run/run_steps ledger). On Railway that pattern is forkable; on Workers it's only inspirational. That's a structural advantage the original analysis cherry-picked away.
- The "substrate fluency" argument cuts BOTH ways. Cloudflare fluency is real (3 projects in 5 weeks); Railway fluency is *at least* as deep, and deeper for this specific shape (prior provisioner work, onboarding script, the whole infrastructure-boundary doctrine in gtm-agent/CLAUDE.md is Railway-shaped).
- **What the venture co-builder would do, unambiguously: Node on a server.** Studio stack is Node-on-cloud; docker referenced but never Workers. If a reviewer opens the repo cold and sees `wrangler.jsonc` + `McpAgent`, the first PR comment is "why isn't this just an Express app?" — and they'd be right. For a venture where PR review is a co-builder responsibility, substrate familiarity to the reviewer matters more than substrate elegance.
- The MCP-as-CF-primitive saving I'd sold as decisive is real but smaller than advertised: the MCP SDK ships `StreamableHTTPServerTransport` for Node. On Workers: ~10 lines (`McpAgent.serve`). On Express: ~50 lines, one-time, owned forever. Not "1 day vs 1 hour" small, but not "1 week vs 1 hour" either.
- Cleaner secondary wins on Railway: Postgres > D1 for audit trail (full JSONB + transactions across run+steps), no `PLAN_CACHE` DO-scoping workaround needed (in-process state in a long-lived server just works), no Workers subrequest/CPU-limit thinking when SFDC metadata deploys get long.

**What I'd overweighted (adjacent considerations):** tactical short-term interview adjacency shouldn't drive a substrate decision for a multi-quarter venture. Caught and removed during the review.

**What survived the swap, untouched:**
- `src/core/spec.ts`, `src/core/overlay.ts`, `src/core/templates.ts` — pure TypeScript + zod, zero host imports
- `src/adapters/types.ts`, `src/adapters/memory.ts` — pure interface + stub
- `db/migrations/0001_initial.sql` — SQL rewritten from SQLite-flavor to Postgres (epoch defaults, bigserial, jsonb), schema unchanged
- The 7-tool MCP surface — same names, same descriptions, same behavior
- `scripts/smoke-p0.sh` — one wording fix (D1 → Postgres), 30 assertions identical

**What changed:**
- `src/host/worker.ts` (DO entry) → `src/host/server.ts` (Express)
- `src/host/mcp.ts` (McpAgent class) → `src/host/mcp.ts` (plain `McpServer` factory) — same 7-tool body, different scaffold
- New: `src/host/db.ts` (pg pool singleton)
- New: `docker-compose.yml` (Postgres for local dev), `railway.toml` (deploy config)
- Gone: `wrangler.jsonc`, `worker-configuration.d.ts`, `.wrangler/`

**Gate after pivot:** 30/30 smoke green on first run against Express + Postgres. Same test surface as the Workers run; same observed behavior.

**Lesson, for the next architecture call:** when I list 3 reasons and 1 of them is "the interview thread happens to value this," delete that reason and recheck whether the remaining ones still carry the weight. If not, I should hold the recommendation more loosely or flip it.

**Recovery cost paid:** ~30 minutes of pivot work + a flushed-out workerd zombie squatting on :8788 from the earlier wrangler dev session (kill -9 was the fix — log it for the substrate doc).
