-- crm-provisioner — D1 schema v0 (P0 walking skeleton)
-- The three tables that survive every phase: connections, runs, run_steps.

create table if not exists connections (
  id              text primary key,
  crm             text not null,             -- 'salesforce' | 'zoho' | 'memory'
  dc              text,                      -- zoho: 'com' | 'eu' | ...
  api_domain      text,                      -- per-DC base; salesforce: my-domain instance URL
  org_label       text,                      -- human label for the connection
  -- secrets stored encrypted-at-rest is a P2 concern; P0 uses opaque blobs
  refresh_token   text,
  access_token    text,
  access_expires  integer,                   -- unix seconds
  created_at      integer not null default (unixepoch()),
  updated_at      integer not null default (unixepoch())
);

create table if not exists runs (
  id              text primary key,          -- run_id (uuid)
  connection_id   text not null,
  spec_hash       text not null,             -- hash of resolved (template+delta)
  template_id     text,                      -- e.g. 'real-estate'
  template_version text,                     -- e.g. 'v1'
  status          text not null default 'pending',  -- pending | running | succeeded | failed | partial
  plan_json       text,                      -- the confirmed plan, snapshotted
  trace_id        text not null,
  started_at      integer not null default (unixepoch()),
  finished_at     integer,
  foreign key (connection_id) references connections(id)
);

create index if not exists ix_runs_connection on runs(connection_id);
create index if not exists ix_runs_status on runs(status);

create table if not exists run_steps (
  id              integer primary key autoincrement,
  run_id          text not null,
  seq             integer not null,
  operation       text not null,             -- 'create_field' | 'add_stage' | ...
  target          text,                      -- module/object name
  payload_json    text,
  status          text not null default 'pending',  -- pending | running | succeeded | failed | skipped_unsupported
  result_json     text,
  error_code      text,
  error_message   text,
  started_at      integer,
  finished_at     integer,
  foreign key (run_id) references runs(id)
);

create index if not exists ix_run_steps_run on run_steps(run_id, seq);
