#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REAL_PYTHON3="$(command -v python3)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
APP="$TMP/app"; AUTH="$TMP/root/backups"; HIST="$TMP/var/backups/gest-o/automatic"; ENV_FILE="$TMP/production.env"; BIN="$TMP/bin"
mkdir -p "$APP/scripts/lib" "$AUTH" "$HIST" "$BIN"
chmod 700 "$HIST"
cp "$ROOT/scripts/prepare-production-recovery-backup.sh" "$APP/scripts/"
cp "$ROOT/scripts/resolve-production-env.sh" "$APP/scripts/"
cp "$ROOT/scripts/lib/production-backup-common.sh" "$APP/scripts/lib/"
git -C "$APP" init -q -b main; git -C "$APP" config user.email test@example.invalid
git -C "$APP" config user.name inventory-test; git -C "$APP" add .; git -C "$APP" commit -qm initial
SHA="$(git -C "$APP" rev-parse HEAD)"; git -C "$APP" update-ref refs/remotes/origin/main "$SHA"

cat >"$BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
case "$1 $2 ${3:-}" in
  'ps -aq --no-trunc') [[ "${MOCK_CONTAINER:-valid}" != absent ]] && printf '%064d\n' 1 ;;
  'inspect 0000000000000000000000000000000000000000000000000000000000000001'*)
    printf '[{"Name":"/postgres-production","Id":"%064d","State":{"Running":%s,"Health":{"Status":"%s"}}}]\n' 1 "$([[ "${MOCK_CONTAINER:-valid}" == stopped ]] && echo false || echo true)" "${MOCK_HEALTH:-healthy}" ;;
  'inspect -f {{range .Mounts}}{{println .Name .Destination}}{{end}}') printf '%s %s\n' "${MOCK_MOUNT_VOLUME:-production-data}" "${MOCK_MOUNT_DEST:-/var/lib/postgresql/data}" ;;
  'network inspect gest-o_default') [[ "${MOCK_NETWORK:-valid}" == valid ]] ;;
  'volume inspect production-data') [[ "${MOCK_VOLUME:-valid}" == valid ]] ;;
  'exec --user postgres')
    [[ "${4:-}" == -i && "${5:-}" == postgres-production ]]
    [[ "${6:-}" != id ]] || { printf '999\n'; exit 0; }
    printf '%s\n' 'PostgreSQL database dump'; return 1 ;;
  *) return 1 ;;
esac
EOF
chmod +x "$BIN/docker"
cat >"$BIN/date" <<'EOF'
#!/usr/bin/env bash
[[ "${MOCK_BUNDLE_COLLISION:-false}" == true && "$*" == '-u +%Y%m%dT%H%M%S' ]] && { printf '%s\n' 20260801T141905; exit; }
exec /usr/bin/date "$@"
EOF
cat >"$BIN/python3" <<'EOF'
#!/usr/bin/env bash
[[ "${MOCK_BUNDLE_COLLISION:-false}" == true && "$*" == *secrets.token_hex* ]] && { printf '%s\n' 0123456789abcdef; exit; }
exec "$REAL_PYTHON3" "$@"
EOF
chmod +x "$BIN/date" "$BIN/python3"

write_env(){
  cat >"$ENV_FILE" <<EOF
DATABASE_URL=${CASE_DATABASE_URL:-postgresql://user-sentinel:password-sentinel@database.example.invalid:5432/salesforce_pro}
PRODUCTION_DB_HOST_EXPECTED=${CASE_EXPECTED_HOST:-database.example.invalid}
PRODUCTION_DB_CONTAINER_EXPECTED=postgres-production
PRODUCTION_DB_VOLUME_EXPECTED=production-data
EOF
  [[ "${CASE_OMIT_BACKUP_FILE:-false}" == true ]] || printf 'PRODUCTION_BACKUP_FILE=%s\n' "${CASE_BACKUP_FILE-$HIST/salesforce_pro-20260801-141905.dump}" >>"$ENV_FILE"
  [[ "${CASE_OMIT_MANIFEST_FILE:-false}" == true ]] || printf 'PRODUCTION_BACKUP_SHA256_FILE=%s\n' "${CASE_MANIFEST_FILE-$HIST/salesforce_pro-20260801-141905.dump.sha256}" >>"$ENV_FILE"
  chmod 600 "$ENV_FILE"
}
run_case(){
  local label=$1; shift; local out="$TMP/$label.out"
  : >"$TMP/docker.log"; write_env
  set +e
  local canonical="$TMP/absent-canonical" legacy="$ENV_FILE"
  if [[ "${CASE_SOURCE:-canonical}" == canonical ]]; then canonical="$ENV_FILE"; legacy="$TMP/legacy-fallback-must-not-be-read"; fi
  env PATH="$BIN:$PATH" REAL_PYTHON3="$REAL_PYTHON3" APP_DIR="$APP" PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY="${CASE_AUTH:-$AUTH}" \
    PRODUCTION_BACKUP_HISTORICAL_AUTHORIZED_DIRECTORY="${CASE_HIST_AUTH:-$HIST}" \
    PRODUCTION_BACKUP_ENV_FILE="$canonical" PRODUCTION_BACKUP_LEGACY_ENV_FILE="$legacy" \
    PRODUCTION_MIN_DISK_KB="${CASE_MIN_DISK:-1}" MOCK_DOCKER_LOG="$TMP/docker.log" \
    MOCK_CONTAINER="${MOCK_CONTAINER:-valid}" MOCK_NETWORK="${MOCK_NETWORK:-valid}" \
    MOCK_VOLUME="${MOCK_VOLUME:-valid}" MOCK_MOUNT_VOLUME="${MOCK_MOUNT_VOLUME:-production-data}" \
    MOCK_MOUNT_DEST="${MOCK_MOUNT_DEST:-/var/lib/postgresql/data}" MOCK_HEALTH="${MOCK_HEALTH:-healthy}" \
    MOCK_BUNDLE_COLLISION="${MOCK_BUNDLE_COLLISION:-false}" \
    CONFIRM=PREPARE_PRODUCTION_RECOVERY_BACKUP EXPECTED_SHA="$SHA" bash "$APP/scripts/prepare-production-recovery-backup.sh" >"$out" 2>&1
  CASE_RC=$?; set -e
  (( CASE_RC != 0 )) || { echo "$label unexpectedly passed" >&2; exit 1; }
  grep -Fq "BACKUP_FAILURE_STAGE=$1" "$out" || { cat "$out" >&2; exit 1; }
  ! grep -Eq 'user-sentinel|password-sentinel|database\.example\.invalid|production\.sql|/tmp/' "$out"
  if [[ "$1" != dump ]]; then ! grep -Fq 'exec --user postgres -i postgres-production pg_dump' "$TMP/docker.log"; fi
  unset CASE_AUTH CASE_HIST_AUTH CASE_BACKUP_FILE CASE_MANIFEST_FILE CASE_DATABASE_URL CASE_EXPECTED_HOST CASE_MIN_DISK CASE_SOURCE
  unset CASE_OMIT_BACKUP_FILE CASE_OMIT_MANIFEST_FILE
unset MOCK_CONTAINER MOCK_NETWORK MOCK_VOLUME MOCK_MOUNT_VOLUME MOCK_MOUNT_DEST
  unset MOCK_HEALTH
  unset MOCK_BUNDLE_COLLISION
}

# Directory and path contracts.
CASE_AUTH="$TMP/missing"; run_case missing-directory new_authorized_directory
mv "$AUTH" "$TMP/real-auth"; ln -s "$TMP/real-auth" "$AUTH"; run_case symlink-directory new_authorized_directory
rm "$AUTH"; mv "$TMP/real-auth" "$AUTH"
CASE_BACKUP_FILE="$HIST/../automatic/salesforce_pro-20260801-141905.dump"; run_case dotdot-path historical_path_contract
CASE_BACKUP_FILE=''; run_case empty-dump-path historical_path_contract
# Historical variables are either both absent or a protected complete pair.
CASE_OMIT_BACKUP_FILE=true; CASE_OMIT_MANIFEST_FILE=true; CASE_DATABASE_URL='not-a-url'
run_case historical-variables-absent database_url_contract
grep -Fq 'PRODUCTION_BACKUP_HISTORICAL_PAIR_STATE=absent' "$TMP/historical-variables-absent.out"

touch "$HIST/salesforce_pro-20260801-141905.dump"; chmod 600 "$HIST/salesforce_pro-20260801-141905.dump"
run_case dump-only historical_path_contract; rm -f "$HIST"/*
touch "$HIST/salesforce_pro-20260801-141905.dump.sha256"; chmod 600 "$HIST/salesforce_pro-20260801-141905.dump.sha256"
run_case manifest-only historical_path_contract; rm -f "$HIST"/*
printf 'previous backup\n' >"$HIST/salesforce_pro-20260801-141905.dump"; chmod 600 "$HIST/salesforce_pro-20260801-141905.dump"
(cd "$HIST" && sha256sum salesforce_pro-20260801-141905.dump >salesforce_pro-20260801-141905.dump.sha256); chmod 600 "$HIST/salesforce_pro-20260801-141905.dump.sha256"
CASE_DATABASE_URL='not-a-url'; run_case complete-valid-pair database_url_contract
grep -Fq 'PRODUCTION_BACKUP_HISTORICAL_PAIR_STATE=complete_valid' "$TMP/complete-valid-pair.out"
rm -f "$HIST"/*
printf 'previous backup\n' >"$HIST/salesforce_pro-20260801-141905.dump"; chmod 600 "$HIST/salesforce_pro-20260801-141905.dump"
printf '%064d  salesforce_pro-20260801-141905.dump\n' 0 >"$HIST/salesforce_pro-20260801-141905.dump.sha256"; chmod 600 "$HIST/salesforce_pro-20260801-141905.dump.sha256"
run_case checksum-mismatch historical_path_contract; rm -f "$HIST"/*

# Historical root and pair fail closed independently of the new destination.
CASE_BACKUP_FILE="$AUTH/outside.dump"; CASE_MANIFEST_FILE="$AUTH/outside.dump.sha256"; run_case outside-historical-root historical_path_contract
CASE_HIST_AUTH="$AUTH"; run_case same-new-and-historical historical_authorized_directory
chmod 755 "$HIST"; run_case historical-root-mode historical_authorized_directory; chmod 700 "$HIST"
chown 65534:65534 "$HIST"; run_case historical-root-owner historical_authorized_directory; chown root:root "$HIST"
mv "$HIST" "$TMP/real-historical"; ln -s "$TMP/real-historical" "$HIST"; run_case historical-root-symlink historical_authorized_directory
rm "$HIST"; mv "$TMP/real-historical" "$HIST"

printf 'previous backup\n' >"$HIST/pair.dump"; chmod 600 "$HIST/pair.dump"
(cd "$HIST" && sha256sum pair.dump >pair.dump.sha256); chmod 600 "$HIST/pair.dump.sha256"
CASE_BACKUP_FILE="$HIST/pair.dump"; CASE_MANIFEST_FILE="$HIST/other.sha256"; run_case divergent-manifest-path historical_path_contract
printf '%s  wrong.dump\n' "$(sha256sum "$HIST/pair.dump" | awk '{print $1}')" >"$HIST/pair.dump.sha256"
CASE_BACKUP_FILE="$HIST/pair.dump"; CASE_MANIFEST_FILE="$HIST/pair.dump.sha256"
run_case divergent-basename historical_path_contract
rm -f "$HIST/pair.dump.sha256"; ln -s pair.dump "$HIST/pair.dump.sha256"; CASE_BACKUP_FILE="$HIST/pair.dump"; CASE_MANIFEST_FILE="$HIST/pair.dump.sha256"; run_case manifest-symlink historical_path_contract
rm -f "$HIST/pair.dump" "$HIST/pair.dump.sha256"; printf x >"$HIST/target"; chmod 600 "$HIST/target"; ln -s target "$HIST/pair.dump"; printf '%064d  pair.dump\n' 0 >"$HIST/pair.dump.sha256"; chmod 600 "$HIST/pair.dump.sha256"; CASE_BACKUP_FILE="$HIST/pair.dump"; CASE_MANIFEST_FILE="$HIST/pair.dump.sha256"; run_case dump-symlink historical_path_contract
rm -f "$HIST"/*

# A deterministic generated name that already exists is rejected before dump.
touch "$AUTH/production-$SHA-20260801T141905-0123456789abcdef.sql.gz"
MOCK_BUNDLE_COLLISION=true; run_case new-destination-collision dump_path_contract
rm -f "$AUTH/production-$SHA-20260801T141905-0123456789abcdef.sql.gz"

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
for marker in HISTORICAL_AUTHORIZED_DIRECTORY NEW_AUTHORIZED_DIRECTORY DUMP_PATH_ABSOLUTE DUMP_PATH_TRAVERSAL DUMP_PATH_NORMALIZED DUMP_PATH_PARENT DUMP_PATH_BASENAME DUMP_PATH_SYMLINK DUMP_PATH_ENTRY_TYPE DUMP_PATH_CONTRACT MANIFEST_PATH_CONTRACT DATABASE_URL_CONTRACT DB_CONTAINER DB_NETWORK DB_VOLUME DB_MOUNT DISK_CAPACITY; do
  grep -Fq "PRODUCTION_BACKUP_${marker}=PASS" "$TMP/valid-inventory.out"
done
grep -Fq 'PRODUCTION_BACKUP_NEW_DESTINATION_STATE=absent' "$TMP/valid-inventory.out"
grep -Fq 'PRODUCTION_BACKUP_LOCK=ACQUIRED' "$TMP/valid-inventory.out"
grep -Fq 'PRODUCTION_BACKUP_SOURCE_VALIDATED=PASS' "$TMP/valid-inventory.out"

printf '%s\n' 'Production backup read-only inventory: PASS (source-aware historical path contract)'
