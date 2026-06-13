# crm-provisioner

![smoke](https://github.com/shanefirek/crm-provisioner/actions/workflows/smoke.yml/badge.svg)

Natural language → typed ProvisionSpec (template + delta) → deterministic driver → CRM adapter (Salesforce, Zoho). MCP server interface — Claude is the UI.

See CLAUDE.md and docs/ for architecture, iteration plan, and decisions.

**Production:** https://crm-provisioner-production.up.railway.app (Railway; CLI-deploys via `railway up`).

CI runs the default smoke (84 assertions) on every push + PR via `.github/workflows/smoke.yml`.
