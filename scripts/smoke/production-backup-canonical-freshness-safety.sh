#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY="$TMP/backups"
mkdir "$PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY"
source "$ROOT/scripts/lib/production-backup-common.sh"
backup_bind_canonical_pair
PRODUCTION_BACKUP_FILE=/historical/legacy.sql.gz
PRODUCTION_BACKUP_SHA256_FILE=/historical/legacy.sql.gz.sha256
backup_resolve_canonical_pair
[[ "$PRODUCTION_BACKUP_FILE" == "$PRODUCTION_BACKUP_CANONICAL_FILE" ]]
[[ "$PRODUCTION_BACKUP_SHA256_FILE" == "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" ]]
printf 'safe test dump\n' >"$PRODUCTION_BACKUP_CANONICAL_FILE"
(cd "$PRODUCTION_BACKUP_CANONICAL_DIRECTORY" && sha256sum production.sql.gz >production.sql.gz.sha256)

# A one-minute-old promoted pair is interpreted as epoch seconds in UTC on both
# call sites and emits only sanitized age/limit metadata.
touch -d '60 seconds ago' "$PRODUCTION_BACKUP_CANONICAL_FILE"
out=$(backup_validate_canonical_pair_and_freshness "$PRODUCTION_BACKUP_CANONICAL_FILE" "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" 300)
for marker in PRODUCTION_BACKUP_CANONICAL_PAIR=VALIDATED PRODUCTION_BACKUP_TIMESTAMP_SOURCE=VALIDATED PRODUCTION_BACKUP_FRESHNESS=PASS; do grep -qx "$marker" <<<"$out"; done
grep -Eq '^PRODUCTION_BACKUP_AGE_SECONDS=[0-9]+$' <<<"$out"
grep -qx 'PRODUCTION_BACKUP_MAX_AGE_SECONDS=300' <<<"$out"
! grep -Fq "$TMP" <<<"$out"

# Different paths, future/millisecond timestamps, stale files, malformed or
# mismatched manifests, and changed content are all fail-closed.
! backup_validate_canonical_pair_and_freshness "$TMP/other" "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" 300 >/dev/null
touch -d '60 seconds' "$PRODUCTION_BACKUP_CANONICAL_FILE"
! backup_validate_canonical_pair_and_freshness "$PRODUCTION_BACKUP_CANONICAL_FILE" "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" 300 >/dev/null
touch -d @1700000000000 "$PRODUCTION_BACKUP_CANONICAL_FILE"
! backup_validate_canonical_pair_and_freshness "$PRODUCTION_BACKUP_CANONICAL_FILE" "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" 300 >/dev/null
touch -d '301 seconds ago' "$PRODUCTION_BACKUP_CANONICAL_FILE"
! backup_validate_canonical_pair_and_freshness "$PRODUCTION_BACKUP_CANONICAL_FILE" "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" 300 >/dev/null
printf 'invalid\n' >"$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE"
! backup_validate_canonical_pair_and_freshness "$PRODUCTION_BACKUP_CANONICAL_FILE" "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" 300 >/dev/null
(cd "$PRODUCTION_BACKUP_CANONICAL_DIRECTORY" && sha256sum production.sql.gz >production.sql.gz.sha256)
printf 'changed\n' >>"$PRODUCTION_BACKUP_CANONICAL_FILE"
! backup_validate_canonical_pair_and_freshness "$PRODUCTION_BACKUP_CANONICAL_FILE" "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" 300 >/dev/null
rm "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE"
! backup_validate_canonical_pair_and_freshness "$PRODUCTION_BACKUP_CANONICAL_FILE" "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" 300 >/dev/null

grep -Fq 'before=$(stat' "$ROOT/scripts/lib/production-backup-common.sh"
grep -Fq '[[ "$before" == "$after" ]]' "$ROOT/scripts/lib/production-backup-common.sh"
grep -Fq 'PRODUCTION_PREFLIGHT_MODE=cutover bash scripts/production-preflight.sh >/dev/null' "$ROOT/scripts/erp-production-recovery.sh"
grep -Fq 'ERP_RECOVERY_TEST_STOP_AFTER_COMPOSE' "$ROOT/scripts/erp-production-recovery.sh"
echo 'production backup canonical freshness safety: PASS'
