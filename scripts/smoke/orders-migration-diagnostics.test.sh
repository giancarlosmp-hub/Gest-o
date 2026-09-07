#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
source "$root/scripts/smoke/orders-migration-diagnostics.sh"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"
cat >"$tmp/raw" <<'LOG'
Error: P3018 Migration failed at postgresql://postgres:super-secret@private-db:5432/orders
ERROR: relation "SyntheticInvalid" does not exist SQLSTATE 42P01 token=forbidden
LOG
chmod 600 "$tmp/raw"
set +e
report_orders_migration_failure 1 "$tmp/raw" fresh_sequence fresh_sequence synthetic_invalid psql "$tmp/sanitized" 2>"$tmp/report"
rc=$?
set -e
test "$rc" -eq 1
for marker in ORDERS_MIGRATION_STEP=fresh_sequence ORDERS_MIGRATION_PHASE=fresh_sequence ORDERS_MIGRATION_NAME=synthetic_invalid ORDERS_MIGRATION_COMMAND_KIND=psql ORDERS_MIGRATION_ERROR_CODE=P3018 ORDERS_MIGRATION_ERROR_MESSAGE= ORDERS_MIGRATION_RESULT=FAIL; do grep -Fq "$marker" "$tmp/report"; done
grep -Fq 'relation "SyntheticInvalid" does not exist' "$tmp/report"
! grep -Fq 'super-secret' "$tmp/report"
! grep -Fq 'private-db' "$tmp/report"
! grep -Fq 'forbidden' "$tmp/report"
echo 'orders migration sanitized diagnostics: PASS'
