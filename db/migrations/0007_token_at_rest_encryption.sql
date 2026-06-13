-- P14: token at-rest encryption via pgcrypto.
-- Audit: connections.refresh_token + access_token are stored plaintext. Acceptable for
-- a one-builder demo against personal dev orgs; unacceptable for any real customer.
-- Configuration-philosophy tier-2 secrets must be encrypted at rest; the encryption
-- key itself is tier-1 environment config (per-deployment) — see TOKEN_AT_REST_KEY in
-- .dev.vars. KMS-wrapping the key is the documented P-future step.
--
-- Migration semantics:
-- - pgcrypto enabled (idempotent).
-- - New bytea columns refresh_token_encrypted + access_token_encrypted, NULL by default.
-- - Legacy plaintext columns are LEFT IN PLACE for one release as a safety net so an
--   accidental rollback doesn't lose connections. A follow-up migration drops them
--   once all connections are observed re-issued through encrypted insert paths.
-- - Existing dev/demo connections WILL stop working (their refresh_tokens live in the
--   plaintext columns and the new connect_crm code path reads from encrypted only).
--   Re-create them via connect_crm — at this stage the repo has only test connections.

create extension if not exists pgcrypto;

alter table connections add column if not exists refresh_token_encrypted bytea;
alter table connections add column if not exists access_token_encrypted bytea;
