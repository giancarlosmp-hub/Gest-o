#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
APP="$TMP/app"; AUTH="$TMP/backups"; ENV_FILE="$TMP/production.env"; BIN="$TMP/bin"
mkdir -p "$APP/scripts/lib" "$AUTH" "$BIN"
cp "$ROOT/scripts/prepare-production-recovery-backup.sh" "$APP/scripts/"
cp "$ROOT/scripts/lib/production-backup-common.sh" "$APP/scripts/lib/"
git -C "$APP" init -q -b main; git -C "$APP" config user.email test@example.invalid
git -C "$APP" config user.name inventory-test; git -C "$APP" add .; git -C "$APP" commit -qm initial
SHA="$(git -C "$APP" rev-parse HEAD)"; git -C "$APP" update-ref refs/remotes/origin/main "$SHA"

cat >"$BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
case "$1 $2 ${3:-}" in
  'inspect -f {{.Name}}{{"\t"}}{{.Id}}{{"\t"}}{{.State.Running}}{{"\t"}}{{if'*)
    [[ "${MOCK_CONTAINER:-valid}" != absent ]] && printf '/%s\t%064d\t%s\t%s\n' "$4" 1 "$([[ "${MOCK_CONTAINER:-valid}" == stopped ]] && echo false || echo true)" "${MOCK_HEALTH:-healthy}" ;;
  'inspect -f {{range .Mounts}}{{println .Name .Destination}}{{end}}') printf '%s %s\n' "${MOCK_MOUNT_VOLUME:-production-data}" "${MOCK_MOUNT_DEST:-/var/lib/postgresql/data}" ;;
  'network inspect gest-o_default') [[ "${MOCK_NETWORK:-valid}" == valid ]] ;;
  'volume inspect production-data') [[ "${MOCK_VOLUME:-valid}" == valid ]] ;;
  'exec -i postgres-production') printf '%s\n' 'PostgreSQL database dump'; return 1 ;;
  *) return 1 ;;
esac
EOF
chmod +x "$BIN/docker"

write_env(){
  cat >"$ENV_FILE" <<EOF
DATABASE_URL=${CASE_DATABASE_URL:-postgresql://user-sentinel:password-sentinel@database.example.invalid:5432/salesforce_pro}
PRODUCTION_DB_HOST_EXPECTED=${CASE_EXPECTED_HOST:-database.example.invalid}
PRODUCTION_DB_CONTAINER_EXPECTED=postgres-production
PRODUCTION_DB_VOLUME_EXPECTED=production-data
EOF
  [[ "${CASE_OMIT_BACKUP_FILE:-false}" == true ]] || printf 'PRODUCTION_BACKUP_FILE=%s\n' "${CASE_BACKUP_FILE-$AUTH/production.sql.gz}" >>"$ENV_FILE"
  [[ "${CASE_OMIT_MANIFEST_FILE:-false}" == true ]] || printf 'PRODUCTION_BACKUP_SHA256_FILE=%s\n' "${CASE_MANIFEST_FILE-$AUTH/production.sql.gz.sha256}" >>"$ENV_FILE"
  chmod 600 "$ENV_FILE"
}
run_case(){
  local label=$1; shift; local out="$TMP/$label.out"
  : >"$TMP/docker.log"; write_env
  set +e
  local canonical="$TMP/absent-canonical" legacy="$ENV_FILE"
  if [[ "${CASE_SOURCE:-legacy_read_only}" == canonical ]]; then canonical="$ENV_FILE"; legacy="$TMP/legacy-fallback-must-not-be-read"; fi
  env PATH="$BIN:$PATH" APP_DIR="$APP" PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY="${CASE_AUTH:-$AUTH}" \
    PRODUCTION_BACKUP_ENV_FILE="$canonical" PRODUCTION_BACKUP_LEGACY_ENV_FILE="$legacy" \
    PRODUCTION_MIN_DISK_KB="${CASE_MIN_DISK:-1}" MOCK_DOCKER_LOG="$TMP/docker.log" \
    MOCK_CONTAINER="${MOCK_CONTAINER:-valid}" MOCK_NETWORK="${MOCK_NETWORK:-valid}" \
    MOCK_VOLUME="${MOCK_VOLUME:-valid}" MOCK_MOUNT_VOLUME="${MOCK_MOUNT_VOLUME:-production-data}" \
    MOCK_MOUNT_DEST="${MOCK_MOUNT_DEST:-/var/lib/postgresql/data}" MOCK_HEALTH="${MOCK_HEALTH:-healthy}" \
    CONFIRM=PREPARE_PRODUCTION_RECOVERY_BACKUP EXPECTED_SHA="$SHA" bash "$APP/scripts/prepare-production-recovery-backup.sh" >"$out" 2>&1
  CASE_RC=$?; set -e
  (( CASE_RC != 0 )) || { echo "$label unexpectedly passed" >&2; exit 1; }
  grep -Fq "BACKUP_FAILURE_STAGE=$1" "$out" || { cat "$out" >&2; exit 1; }
  ! grep -Eq 'user-sentinel|password-sentinel|database\.example\.invalid|production\.sql|/tmp/' "$out"
  if [[ "$1" != dump ]]; then ! grep -Fq 'exec -i postgres-production pg_dump' "$TMP/docker.log"; fi
  unset CASE_AUTH CASE_BACKUP_FILE CASE_MANIFEST_FILE CASE_DATABASE_URL CASE_EXPECTED_HOST CASE_MIN_DISK CASE_SOURCE
  unset CASE_OMIT_BACKUP_FILE CASE_OMIT_MANIFEST_FILE
unset MOCK_CONTAINER MOCK_NETWORK MOCK_VOLUME MOCK_MOUNT_VOLUME MOCK_MOUNT_DEST
  unset MOCK_HEALTH
}

# Directory and path contracts.
CASE_AUTH="$TMP/missing"; run_case missing-directory authorized_directory
mv "$AUTH" "$TMP/real-auth"; ln -s "$TMP/real-auth" "$AUTH"; run_case symlink-directory authorized_directory
rm "$AUTH"; mv "$TMP/real-auth" "$AUTH"
CASE_BACKUP_FILE="$AUTH/../backups/production.sql.gz"; run_case dotdot-path historical_path_contract
CASE_BACKUP_FILE=''; run_case empty-dump-path historical_path_contract
# Legacy hints with former parents and basenames are syntactically checked, then
# rebound; they cannot influence any effective path contract.
CASE_BACKUP_FILE="$TMP/former/production.sql.gz"; CASE_MANIFEST_FILE="$TMP/former/production.sql.gz.sha256"
CASE_DATABASE_URL='not-a-url'; run_case historical-parent-rebound database_url_contract
grep -Fq 'PRODUCTION_BACKUP_HISTORICAL_PATH_POLICY=REBOUND_LEGACY_READ_ONLY' "$TMP/historical-parent-rebound.out"
grep -Fq 'PRODUCTION_BACKUP_HISTORICAL_PATH_CONTRACT=PASS' "$TMP/historical-parent-rebound.out"
grep -Fq 'PRODUCTION_BACKUP_DUMP_PATH_PARENT=PASS' "$TMP/historical-parent-rebound.out"
grep -Fq 'PRODUCTION_BACKUP_MANIFEST_PATH_CONTRACT=PASS' "$TMP/historical-parent-rebound.out"
CASE_BACKUP_FILE="$TMP/former/database-old.dump"; CASE_MANIFEST_FILE="$TMP/other/legacy.checksum"
CASE_DATABASE_URL='not-a-url'; run_case historical-basename-rebound database_url_contract
grep -Fq 'PRODUCTION_BACKUP_HISTORICAL_PATH_POLICY=REBOUND_LEGACY_READ_ONLY' "$TMP/historical-basename-rebound.out"
CASE_BACKUP_FILE=$'"/absolute/control\vpath"'; run_case historical-control-character historical_path_contract
CASE_OMIT_BACKUP_FILE=true; CASE_OMIT_MANIFEST_FILE=true; CASE_DATABASE_URL='not-a-url'
run_case historical-variables-absent database_url_contract

# Canonical source remains fail-closed: present assertions must exactly match
# the effective pair, while absent assertions are permitted and never fall back.
CASE_SOURCE=canonical; CASE_BACKUP_FILE="$TMP/former/production.sql.gz"; run_case canonical-divergent historical_path_contract
grep -Fq 'PRODUCTION_BACKUP_ENV_SOURCE=canonical' "$TMP/canonical-divergent.out"
! grep -Fq 'REBOUND_LEGACY_READ_ONLY' "$TMP/canonical-divergent.out"
CASE_SOURCE=canonical; CASE_DATABASE_URL='not-a-url'; run_case canonical-valid database_url_contract
grep -Fq 'PRODUCTION_BACKUP_HISTORICAL_PATH_POLICY=STRICT_CANONICAL' "$TMP/canonical-valid.out"
ln -s "$TMP/target" "$AUTH/production.sql.gz"; run_case backup-symlink dump_path_contract; rm "$AUTH/production.sql.gz"
ln -s "$TMP/target" "$AUTH/production.sql.gz.sha256"; run_case manifest-symlink manifest_path_contract; rm "$AUTH/production.sql.gz.sha256"
touch "$AUTH/production.sql.gz" "$AUTH/production.sql.gz.sha256"; chmod 640 "$AUTH/production.sql.gz"
run_case invalid-mode existing_pair_state; rm -f "$AUTH"/*
touch "$AUTH/production.sql.gz" "$AUTH/production.sql.gz.sha256"; chmod 600 "$AUTH"/*
chown 65534:65534 "$AUTH/production.sql.gz"; run_case invalid-owner existing_pair_state; rm -f "$AUTH"/*
touch "$AUTH/production.sql.gz"; chmod 600 "$AUTH/production.sql.gz"; run_case dump-only existing_pair_state; rm -f "$AUTH"/*
touch "$AUTH/production.sql.gz.sha256"; chmod 600 "$AUTH/production.sql.gz.sha256"; run_case manifest-only existing_pair_state; rm -f "$AUTH"/*

# A future destination does not have to exist. A complete previous pair does,
# however, have to be protected and validate its own checksum metadata.
CASE_DATABASE_URL='not-a-url'; run_case absent-pair database_url_contract
printf 'previous backup\n' >"$AUTH/production.sql.gz"; chmod 600 "$AUTH/production.sql.gz"
(cd "$AUTH" && sha256sum production.sql.gz >production.sql.gz.sha256); chmod 600 "$AUTH/production.sql.gz.sha256"
CASE_DATABASE_URL='not-a-url'; run_case complete-valid-pair database_url_contract
grep -Fq 'PRODUCTION_BACKUP_EXISTING_PAIR_STATE=complete_valid' "$TMP/complete-valid-pair.out"
rm -f "$AUTH"/*
printf 'previous backup\n' >"$AUTH/production.sql.gz"; chmod 600 "$AUTH/production.sql.gz"
printf '%064d  ../path-sentinel\n' 0 >"$AUTH/production.sql.gz.sha256"; chmod 600 "$AUTH/production.sql.gz.sha256"
run_case invalid-manifest-metadata existing_pair_state; rm -f "$AUTH"/*

# URL and deterministic PostgreSQL topology contracts.
CASE_DATABASE_URL='not-a-url'; run_case invalid-url database_url_contract
CASE_EXPECTED_HOST='other.example.invalid'; run_case divergent-host database_url_contract
CASE_DATABASE_URL='postgresql://u:p@database.example.invalid/other'; run_case divergent-database database_url_contract
MOCK_CONTAINER=absent; run_case absent-container database_container
MOCK_CONTAINER=stopped; run_case stopped-container database_container
MOCK_HEALTH=unhealthy; run_case unhealthy-container database_container
MOCK_NETWORK=absent; run_case absent-network database_network
MOCK_VOLUME=absent; run_case absent-volume database_volume
MOCK_MOUNT_DEST=/wrong; run_case divergent-mount database_mount
CASE_MIN_DISK=999999999999; run_case insufficient-disk disk_capacity

# A held exclusive lock blocks before dump creation.
exec 8>"$AUTH/.prepare-production-recovery-backup.lock"; flock -n 8
run_case occupied-lock preparation_lock; flock -u 8

# The fully valid inventory emits every sanitized checkpoint before the mocked dump fails.
run_case valid-inventory dump
for marker in AUTHORIZED_DIRECTORY DUMP_PATH_ABSOLUTE DUMP_PATH_TRAVERSAL DUMP_PATH_NORMALIZED DUMP_PATH_PARENT DUMP_PATH_BASENAME DUMP_PATH_SYMLINK DUMP_PATH_ENTRY_TYPE DUMP_PATH_CONTRACT MANIFEST_PATH_CONTRACT DATABASE_URL_CONTRACT DB_CONTAINER DB_NETWORK DB_VOLUME DB_MOUNT DISK_CAPACITY; do
  grep -Fq "PRODUCTION_BACKUP_${marker}=PASS" "$TMP/valid-inventory.out"
done
grep -Fq 'PRODUCTION_BACKUP_EXISTING_PAIR_STATE=absent' "$TMP/valid-inventory.out"
grep -Fq 'PRODUCTION_BACKUP_LOCK=ACQUIRED' "$TMP/valid-inventory.out"
grep -Fq 'PRODUCTION_BACKUP_SOURCE_VALIDATED=PASS' "$TMP/valid-inventory.out"

# The selected legacy env remains byte-identical and canonical is never created.
CASE_DATABASE_URL='not-a-url'; write_env; before="$(sha256sum "$ENV_FILE")"; run_case legacy-source-immutable database_url_contract
[[ "$before" == "$(sha256sum "$ENV_FILE")" && ! -e "$TMP/absent-canonical" ]]
! grep -Eq 'recovery|cutover|migrate|seed|backfill' "$TMP/docker.log"
printf '%s\n' 'Production backup read-only inventory: PASS (source-aware historical path contract)'
