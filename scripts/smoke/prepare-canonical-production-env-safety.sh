#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; SCRIPT="$ROOT/scripts/prepare-canonical-production-env.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
OWNER="$(id -un):$(id -gn)"; secret='canonical-preparation-secret-must-not-leak'
write_env(){
  local database_url=${2:-postgresql://user:$secret@db/prod}
  local ultrafv3_url=${3:-https://erp.invalid}
  cat >"$1" <<EOF
DATABASE_URL=$database_url
JWT_SECRET=$secret
JWT_ACCESS_SECRET=$secret
JWT_REFRESH_SECRET=$secret
ULTRAFV3_BASE_URL=$ultrafv3_url
ERP_CREDENTIAL_ENCRYPTION_KEY=$secret
ERP_SYNC_SCHEDULER_ENABLED=true
TENANCY_MODE=disabled
TENANT_READ_PILOT_ENABLED=false
DATABASE_SCHEMA_MODE=external
SEED_ON_BOOTSTRAP=false
ENABLE_PREVIEW_SEED=false
ENABLE_SMOKE_BOOTSTRAP=false
EOF
  chmod 600 "$1"
}
run(){ CONFIRM=PREPARE_CANONICAL_PRODUCTION_ENV PRODUCTION_ENV_DIR="$1" PRODUCTION_ENV_BACKUP_DIR="$1/backups" ERP_ENV_EXPECTED_OWNER="$OWNER" bash "$SCRIPT"; }

valid_variant(){
  local case=$1 database_url=$2 ultrafv3_url=$3 backup before dir
  dir="$TMP/$case"
  mkdir "$dir"; write_env "$dir/production.env" "$database_url" "$ultrafv3_url"
  before=$(sha256sum "$dir/production.env")
  run "$dir" >"$dir.out" 2>"$dir.err"
  cmp -s "$dir/production.env" "$dir/.env"
  [[ "$before" == "$(sha256sum "$dir/production.env")" ]]
  backup=$(find "$dir/backups" -type f -name 'environment-before-canonical-*.backup')
  cmp -s "$dir/production.env" "$backup"
}

# Valid legacy is promoted byte-for-byte, publishes all readiness markers, and
# remains eligible for build while becoming eligible for cutover.
mkdir "$TMP/valid"; write_env "$TMP/valid/production.env"; before=$(sha256sum "$TMP/valid/production.env")
run "$TMP/valid" >"$TMP/valid.out" 2>"$TMP/valid.err"
cmp -s "$TMP/valid/production.env" "$TMP/valid/.env"; [[ "$before" == "$(sha256sum "$TMP/valid/production.env")" ]]
backup=$(find "$TMP/valid/backups" -type f -name 'environment-before-canonical-*.backup'); cmp -s "$TMP/valid/production.env" "$backup"; [[ "$(stat -c %a "$backup")" == 600 ]]
grep -Fxq 'READY_FOR_CUTOVER=YES' "$TMP/valid.out"
MODE=cutover PRODUCTION_CANONICAL_ENV_FILE="$TMP/valid/.env" PRODUCTION_LEGACY_ENV_FILE="$TMP/valid/production.env" ERP_ENV_EXPECTED_OWNER="$OWNER" bash "$ROOT/scripts/resolve-production-env.sh" >/dev/null 2>"$TMP/cutover.err"
rm "$TMP/valid/.env"
MODE=build PRODUCTION_CANONICAL_ENV_FILE="$TMP/valid/.env" PRODUCTION_LEGACY_ENV_FILE="$TMP/valid/production.env" ERP_ENV_EXPECTED_OWNER="$OWNER" bash "$ROOT/scripts/resolve-production-env.sh" >/dev/null 2>"$TMP/build.err"
! MODE=cutover PRODUCTION_CANONICAL_ENV_FILE="$TMP/valid/.env" PRODUCTION_LEGACY_ENV_FILE="$TMP/valid/production.env" ERP_ENV_EXPECTED_OWNER="$OWNER" bash "$ROOT/scripts/resolve-production-env.sh" >"$TMP/no.out" 2>"$TMP/no.err"

# Both protected URLs accept unquoted, single-quoted, and double-quoted dotenv
# representations. Every successful publication and backup remains byte-identical.
valid_variant urls-unquoted 'postgres://user:opaque@db/prod' 'http://erp.invalid'
valid_variant urls-single-quoted "'postgresql://user:opaque@db/prod'" "'https://erp.invalid'"
valid_variant urls-double-quoted '"postgres://user:opaque@db/prod"' '"http://erp.invalid"'

failure(){ local case=$1 mutate=$2; mkdir "$TMP/$case"; write_env "$TMP/$case/production.env"; eval "$mutate"; ! run "$TMP/$case" >"$TMP/$case.out" 2>"$TMP/$case.err"; [[ ! -e "$TMP/$case/.env" ]]; }
failure missing "sed -i '/^JWT_SECRET=/d' '$TMP/missing/production.env'"
failure mode "chmod 644 '$TMP/mode/production.env'"
failure database-scheme "sed -i 's|^DATABASE_URL=.*|DATABASE_URL=mysql://db/prod|' '$TMP/database-scheme/production.env'"
failure erp-scheme "sed -i 's|^ULTRAFV3_BASE_URL=.*|ULTRAFV3_BASE_URL=ftp://erp.invalid|' '$TMP/erp-scheme/production.env'"
failure database-mismatched-quotes "sed -i 's|^DATABASE_URL=.*|DATABASE_URL=\"postgresql://db/prod\x27|' '$TMP/database-mismatched-quotes/production.env'"
failure erp-mismatched-quotes "sed -i 's|^ULTRAFV3_BASE_URL=.*|ULTRAFV3_BASE_URL=\x27https://erp.invalid\"|' '$TMP/erp-mismatched-quotes/production.env'"
failure database-empty "sed -i 's|^DATABASE_URL=.*|DATABASE_URL=|' '$TMP/database-empty/production.env'"
failure erp-empty-quotes "sed -i 's|^ULTRAFV3_BASE_URL=.*|ULTRAFV3_BASE_URL=\x27\x27|' '$TMP/erp-empty-quotes/production.env'"
mkdir "$TMP/link"; write_env "$TMP/link-target"; ln -s "$TMP/link-target" "$TMP/link/production.env"; ! run "$TMP/link" >"$TMP/link.out" 2>"$TMP/link.err"
mkdir "$TMP/owner"; write_env "$TMP/owner/production.env"; ! CONFIRM=PREPARE_CANONICAL_PRODUCTION_ENV PRODUCTION_ENV_DIR="$TMP/owner" ERP_ENV_EXPECTED_OWNER=nobody:nogroup bash "$SCRIPT" >"$TMP/owner.out" 2>"$TMP/owner.err"
! grep -FRq "$secret" "$TMP" --include='*.out' --include='*.err'
echo 'canonical production environment preparation safety: PASS'
