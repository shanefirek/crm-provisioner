-- P12: per-connection Salesforce CLI alias.
-- Audit finding #5: `inferAlias()` used `process.env.SF_ALIAS || "shane-dev"` — every
-- concurrent apply on any SFDC connection routed to the same CLI alias regardless of
-- which org the connection points at. Multi-tenancy-isolation violation: alias is a
-- per-tenant fact, not a process-global. NULL = legacy fallback to env var (kept for
-- the one-builder demo path; new connections set sf_alias explicitly).

alter table connections add column if not exists sf_alias text;
