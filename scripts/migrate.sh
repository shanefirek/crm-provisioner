#!/usr/bin/env bash
# Apply every SQL file in db/migrations/, in lexicographic order, inside ONE psql
# session that holds a pg_advisory_lock for the duration. Idempotent re-runs are
# safe (every migration uses `if not exists`), and the lock serializes concurrent
# instances — Railway's rolling deploy + scale>1 would otherwise race CREATE
# EXTENSION / ADD COLUMN IF NOT EXISTS on the PG catalog → 'tuple concurrently
# updated' errors. P17 fix #2 from the high-effort review.
#
# Usage:
#   DATABASE_URL=postgres://crm:crm@127.0.0.1:5433/crm_provisioner bash scripts/migrate.sh
#
# Local single-instance dev is unaffected by the lock (it's a no-op). The lock
# auto-releases when the psql session exits — no manual unlock needed.

set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL is required}"

# Lock key: signed-int hash of a fixed string. Anyone else hitting migrate.sh
# against the same DB blocks here until we exit.
LOCK_KEY="crm-provisioner-migrations"

# Build the SQL: acquire lock + \i each migration file + exit (lock auto-releases).
# psql `\i` includes are parsed in this session, so `if not exists` runs in catalog
# order under the held lock.
INCLUDE_BLOCK=""
for f in db/migrations/*.sql; do
  INCLUDE_BLOCK="${INCLUDE_BLOCK}\\echo Applying ${f}
\\i ${f}
"
done

echo "→ acquiring advisory lock ($LOCK_KEY) + applying $(ls db/migrations/*.sql | wc -l | tr -d ' ') migrations in one session"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >/dev/null
\\set ON_ERROR_STOP on
select pg_advisory_lock(hashtext('${LOCK_KEY}'));
${INCLUDE_BLOCK}
select pg_advisory_unlock(hashtext('${LOCK_KEY}'));
SQL

echo "✓ all migrations applied"
