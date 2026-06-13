-- P7 — quality watchdog over the run.
--
-- The watchdog trips when failure-rate or silent-success-rate over the trailing
-- N steps exceeds a threshold. On trip, apply stops dispatching new steps;
-- remaining steps are recorded as skipped_by_watchdog; the run row gets
-- status='aborted' and aborted_by names the trip cause.

alter table runs add column if not exists aborted_by text;
alter table runs add column if not exists watchdog_window_failures integer not null default 0;
