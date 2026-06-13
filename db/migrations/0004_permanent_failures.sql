-- P6 — negative cache for permanent failures.
--
-- When a step throws a non-retryable error (DataError, BoundaryError:permanent,
-- BoundaryError:rejected), we record the (connection, operation, payload_hash)
-- triple here so a subsequent plan() recognizes it and refuses to re-attempt
-- without explicit force_retry_blocked:true.
--
-- TTL defaults (the apply() writer picks one):
--   30 days for DataError — the data might become valid (e.g. teardown of a
--     duplicate, or the user fixes the spec).
--   90 days for BoundaryError:permanent — auth scopes / deleted resources
--     rarely come back.
--
-- payload_hash is computed via stableHash() on the step.payload object so the
-- "same step with the same fields" matches across plans.

create table if not exists permanent_failures (
  id              bigserial   primary key,
  connection_id   text        not null references connections(id) on delete cascade,
  operation       text        not null,                          -- e.g. 'create_field', 'create_workflow:idle_deal_alert'
  payload_hash    text        not null,                          -- stableHash(step.payload)
  error_code      text        not null,                          -- 'DataError:DUPLICATE_DATA', 'BoundaryError:permanent', etc.
  error_message   text,
  first_seen_at   integer     not null default (extract(epoch from now())::integer),
  last_seen_at    integer     not null default (extract(epoch from now())::integer),
  expires_at      integer     not null,
  -- Last run that recorded the failure — handy for forensics + the get_run path.
  last_run_id     text
);

create unique index if not exists ux_perm_fail_dedup on permanent_failures (connection_id, operation, payload_hash);
create index if not exists ix_perm_fail_expires on permanent_failures (expires_at);
