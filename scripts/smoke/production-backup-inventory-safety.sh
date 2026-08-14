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
  'inspect -f {{.Name}}') [[ "${MOCK_CONTAINER:-valid}" != absent ]] && printf '/%s\n' "$4" ;;
  'inspect -f {{.State.Running}}') [[ "${MOCK_CONTAINER:-valid}" != absent ]] && { [[ "${MOCK_CONTAINER:-valid}" == stopped ]] && echo false || echo true; } ;;
  'inspect -f {{if .State.Health}}{{.State.Health.Status}}{{end}}') echo "${MOCK_HEALTH:-healthy}" ;;
  'inspect -f {{range .Mounts}}{{println .Name .Destination}}{{end}}') printf '%s %s\n' "${MOCK_MOUNT_VOLUME:-production-data}" "${MOCK_MOUNT_DEST:-/var/lib/postgresql/data}" ;;
  'network inspect gest-o_default') [[ "${MOCK_NETWORK:-valid}" == valid ]] ;;
  'volume inspect production-data') [[ "${MOCK_VOLUME:-valid}" == valid ]] ;;
  'compose exec -T') printf '%s\n' 'PostgreSQL database dump'; return 1 ;;
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
PRODUCTION_BACKUP_FILE=${CASE_BACKUP_FILE:-$AUTH/production.sql.gz}
PRODUCTION_BACKUP_SHA256_FILE=${CASE_MANIFEST_FILE:-$AUTH/production.sql.gz.sha256}
EOF
  chmod 600 "$ENV_FILE"
}
run_case(){
  local label=$1; shift; local out="$TMP/$label.out"
  : >"$TMP/docker.log"; write_env
  set +e
  env PATH="$BIN:$PATH" APP_DIR="$APP" PRODUCTION_BACKUP_AUTHORIZED_DIR="${CASE_AUTH:-$AUTH}" \
    PRODUCTION_BACKUP_ENV_FILE="$TMP/absent-canonical" PRODUCTION_BACKUP_LEGACY_ENV_FILE="$ENV_FILE" \
    PRODUCTION_MIN_DISK_KB="${CASE_MIN_DISK:-1}" MOCK_DOCKER_LOG="$TMP/docker.log" \
    MOCK_CONTAINER="${MOCK_CONTAINER:-valid}" MOCK_NETWORK="${MOCK_NETWORK:-valid}" \
    MOCK_VOLUME="${MOCK_VOLUME:-valid}" MOCK_MOUNT_VOLUME="${MOCK_MOUNT_VOLUME:-production-data}" \
    MOCK_MOUNT_DEST="${MOCK_MOUNT_DEST:-/var/lib/postgresql/data}" \
    CONFIRM=PREPARE_PRODUCTION_RECOVERY_BACKUP EXPECTED_SHA="$SHA" bash "$APP/scripts/prepare-production-recovery-backup.sh" >"$out" 2>&1
  CASE_RC=$?; set -e
  (( CASE_RC != 0 )) || { echo "$label unexpectedly passed" >&2; exit 1; }
  grep -Fq "BACKUP_FAILURE_STAGE=$1" "$out" || { cat "$out" >&2; exit 1; }
  ! grep -Eq 'user-sentinel|password-sentinel|database\.example\.invalid|production\.sql|/tmp/' "$out"
  if [[ "$1" != dump ]]; then ! grep -Fq 'compose exec -T db pg_dump' "$TMP/docker.log"; fi
  unset CASE_AUTH CASE_BACKUP_FILE CASE_MANIFEST_FILE CASE_DATABASE_URL CASE_EXPECTED_HOST CASE_MIN_DISK
  unset MOCK_CONTAINER MOCK_NETWORK MOCK_VOLUME MOCK_MOUNT_VOLUME MOCK_MOUNT_DEST
}

# Directory and path contracts.
CASE_AUTH="$TMP/missing"; run_case missing-directory authorized_directory
mv "$AUTH" "$TMP/real-auth"; ln -s "$TMP/real-auth" "$AUTH"; run_case symlink-directory authorized_directory
rm "$AUTH"; mv "$TMP/real-auth" "$AUTH"
CASE_MANIFEST_FILE="$AUTH/production.sql.gz"; run_case equal-paths backup_path_contract
CASE_BACKUP_FILE="$TMP/outside.gz"; run_case outside-path backup_path_contract
ln -s "$TMP/target" "$AUTH/production.sql.gz"; run_case backup-symlink backup_path_contract; rm "$AUTH/production.sql.gz"
ln -s "$TMP/target" "$AUTH/production.sql.gz.sha256"; run_case manifest-symlink manifest_path_contract; rm "$AUTH/production.sql.gz.sha256"
touch "$AUTH/production.sql.gz" "$AUTH/production.sql.gz.sha256"; chmod 640 "$AUTH/production.sql.gz"
run_case invalid-mode existing_pair_metadata; rm -f "$AUTH"/*
touch "$AUTH/production.sql.gz" "$AUTH/production.sql.gz.sha256"; chmod 600 "$AUTH"/*
chown 65534:65534 "$AUTH/production.sql.gz"; run_case invalid-owner existing_pair_metadata; rm -f "$AUTH"/*
touch "$AUTH/production.sql.gz"; chmod 600 "$AUTH/production.sql.gz"; run_case incomplete-pair existing_pair_metadata; rm -f "$AUTH"/*

# URL and deterministic PostgreSQL topology contracts.
CASE_DATABASE_URL='not-a-url'; run_case invalid-url database_url_contract
CASE_EXPECTED_HOST='other.example.invalid'; run_case divergent-host database_url_contract
CASE_DATABASE_URL='postgresql://u:p@database.example.invalid/other'; run_case divergent-database database_url_contract
MOCK_CONTAINER=absent; run_case absent-container database_container
MOCK_CONTAINER=stopped; run_case stopped-container database_container
MOCK_NETWORK=absent; run_case absent-network database_network
MOCK_VOLUME=absent; run_case absent-volume database_volume
MOCK_MOUNT_DEST=/wrong; run_case divergent-mount database_mount
CASE_MIN_DISK=999999999999; run_case insufficient-disk disk_capacity

# A held exclusive lock blocks before dump creation.
exec 8>"$AUTH/.prepare-production-recovery-backup.lock"; flock -n 8
run_case occupied-lock preparation_lock; flock -u 8

# The fully valid inventory emits every sanitized checkpoint before the mocked dump fails.
run_case valid-inventory dump
for marker in AUTHORIZED_DIRECTORY PATHS DATABASE_URL_CONTRACT DB_CONTAINER DB_NETWORK DB_VOLUME DB_MOUNT DISK_CAPACITY; do
  grep -Fq "PRODUCTION_BACKUP_${marker}=PASS" "$TMP/valid-inventory.out"
done
grep -Fq 'PRODUCTION_BACKUP_LOCK=ACQUIRED' "$TMP/valid-inventory.out"
grep -Fq 'PRODUCTION_BACKUP_SOURCE_VALIDATED=PASS' "$TMP/valid-inventory.out"

# The selected legacy env remains byte-identical and canonical is never created.
before="$(sha256sum "$ENV_FILE")"; [[ "$before" == "$(sha256sum "$ENV_FILE")" && ! -e "$TMP/absent-canonical" ]]
! grep -Eq 'recovery|cutover|migrate|seed|backfill' "$TMP/docker.log"
printf '%s\n' 'Production backup read-only inventory: PASS (24 fail-closed contracts)'
