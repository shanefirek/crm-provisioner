-- P1 hardening: connection-level demo gate + destructive-step accounting.
--
-- WHY: P2/P3 adapters write to real CRM orgs. Three rules must hold structurally
-- before any adapter call can mutate a real instance:
--   1. connection.is_demo must be true (analog of gtm-agent's Railway off-limits rule)
--   2. connection.api_domain must be in writable_org_ids allowlist for the connection
--   3. destructive steps require explicit confirm_destructive=true on apply
--
-- Each rule is enforced in src/host/mcp.ts; this migration is the data side.

alter table connections add column if not exists is_demo          boolean not null default false;
alter table connections add column if not exists writable_org_ids text[]  not null default '{}';

-- Per-step destructive flag, used by plan() and asserted at apply() time.
alter table run_steps   add column if not exists destructive       boolean not null default false;

-- Teardown linkage: a teardown run records WHICH run it reversed.
alter table runs        add column if not exists teardown_of_run  text references runs(id);
create index if not exists ix_runs_teardown_of on runs(teardown_of_run);
