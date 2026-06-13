#!/usr/bin/env bash
# Apply every SQL file in db/migrations/, in lexicographic order.
# All migrations use `if not exists` / `add column if not exists` semantics — re-running
# is a no-op. Required reading: package.json's `migrate` script just shells here.
#
# Usage:
#   DATABASE_URL=postgres://crm:crm@127.0.0.1:5433/crm_provisioner bash scripts/migrate.sh

set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL is required}"

for f in db/migrations/*.sql; do
  echo "→ applying $f"
  psql "$DATABASE_URL" -f "$f" -v ON_ERROR_STOP=1 >/dev/null
done

echo "✓ all migrations applied"
