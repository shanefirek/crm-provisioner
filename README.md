# crm-provisioner

Natural language → typed ProvisionSpec (template + delta) → deterministic driver → CRM adapter (Salesforce, Zoho). MCP server interface — Claude is the UI.

See CLAUDE.md and docs/ for architecture, iteration plan, and decisions.

CI runs the default smoke (79 assertions) on every push + PR via `.github/workflows/smoke.yml`. Add the badge `![smoke](https://github.com/<owner>/<repo>/actions/workflows/smoke.yml/badge.svg)` once the remote is configured.
