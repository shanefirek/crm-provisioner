-- P5 — record retry attempts on each step.
-- error_code already exists as TEXT; P5 just upgrades its values from ad-hoc
-- strings ("STUB_ERROR", "STAGE_BATCH_FAIL") to typed-class names
-- ("BoundaryError:transient", "DataError:DUPLICATE_DATA"). Schema change is
-- additive: a new `attempts` column for retry observability.
--
-- Backfill: existing rows get attempts=1 (the prior behavior was no retry).

alter table run_steps add column if not exists attempts integer not null default 1;
