-- crm-provisioner — Postgres schema v0 (P0 walking skeleton, on Railway).
-- The three tables that survive every phase: connections, runs, run_steps.

create table if not exists connections (
  id              text primary key,
  crm             text not null,                                       -- 'salesforce' | 'zoho' | 'memory'
  dc              text,                                                -- zoho: 'com' | 'eu' | ...
  api_domain      text,                                                -- per-DC base; salesforce: my-domain instance URL
  org_label       text,
  -- secrets encrypted-at-rest is a P2 concern; P0 uses opaque text columns
  refresh_token   text,
  access_token    text,
  access_expires  integer,                                             -- unix seconds
  created_at      integer not null default (extract(epoch from now())::integer),
  updated_at      integer not null default (extract(epoch from now())::integer)
);

create table if not exists runs (
  id               text primary key,
  connection_id    text not null references connections(id),
  spec_hash        text not null,
  template_id      text,
  template_version text,
  status           text not null default 'pending',                    -- pending|running|succeeded|failed|partial
  plan_json        jsonb,                                              -- the confirmed plan, snapshotted
  trace_id         text not null,
  started_at       integer not null default (extract(epoch from now())::integer),
  finished_at      integer
);
create index if not exists ix_runs_connection on runs(connection_id);
create index if not exists ix_runs_status     on runs(status);

create table if not exists run_steps (
  id              bigserial primary key,
  run_id          text not null references runs(id),
  seq             integer not null,
  operation       text not null,
  target          text,
  payload_json    jsonb,
  status          text not null default 'pending',                     -- pending|running|succeeded|failed|skipped_unsupported
  result_json     jsonb,
  error_code      text,
  error_message   text,
  started_at      integer,
  finished_at     integer
);
create index if not exists ix_run_steps_run on run_steps(run_id, seq);
