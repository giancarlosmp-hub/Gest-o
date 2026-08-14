#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="${APP_DIR:-/apps/gest-o}"
CANONICAL_ENV_FILE="${PRODUCTION_BACKUP_ENV_FILE:-/root/demetra-env/.env}"
LEGACY_ENV_FILE="${PRODUCTION_BACKUP_LEGACY_ENV_FILE:-/root/demetra-env/production.env}"
ENV_FILE=''
ENV_SOURCE=''
AUTHORIZED_DIR="${PRODUCTION_BACKUP_AUTHORIZED_DIR:-/root/backups}"
STAGE=initial
COMMAND=initial_validation
TMP_DIR=''; OLD_BACKUP=''; OLD_MANIFEST=''; PROMOTION_STARTED=false; HAD_PRIOR=false

checkpoint(){ printf '%s\n' "$1"; }
failure(){
  local rc=$?
  trap - ERR
  if [[ "$PROMOTION_STARTED" == true ]]; then
    [[ -n "$OLD_BACKUP" && -f "$OLD_BACKUP" ]] && install -o root -g root -m 600 "$OLD_BACKUP" "$PRODUCTION_BACKUP_FILE"
    [[ -n "$OLD_MANIFEST" && -f "$OLD_MANIFEST" ]] && install -o root -g root -m 600 "$OLD_MANIFEST" "$PRODUCTION_BACKUP_SHA256_FILE"
    if [[ "$HAD_PRIOR" == false ]]; then rm -f -- "$PRODUCTION_BACKUP_FILE" "$PRODUCTION_BACKUP_SHA256_FILE"; fi
  fi
  [[ -n "$TMP_DIR" ]] && rm -rf -- "$TMP_DIR"
  printf 'BACKUP_FAILURE_STAGE=%s\nBACKUP_FAILURE_COMMAND=%s\nBACKUP_FAILURE_EXIT_CODE=%s\n' "$STAGE" "$COMMAND" "$rc" >&2
  exit "$rc"
}
trap failure ERR
need(){ command -v "$1" >/dev/null 2>&1; }
protected_regular(){ [[ -f "$1" && ! -L "$1" && ( "$(id -u)" != 0 || "$(stat -c %U:%G "$1")" == root:root ) && "$(stat -c %a "$1")" == 600 ]]; }
future_path_in_authorized_dir(){
  local path=$1 parent base normalized
  [[ "$path" == /* && "$path" != */../* && "$path" != */.. && "$path" != */./* && "$path" != */. ]] || return 1
  parent="$(dirname -- "$path")"; base="$(basename -- "$path")"
  [[ -n "$base" && "$base" != . && "$base" != .. && "$parent" == "$AUTHORIZED_DIR" ]] || return 1
  normalized="$(readlink -m -- "$path")"
  [[ "$normalized" == "$path" && "$normalized" == "$AUTHORIZED_DIR/$base" ]]
}
valid_existing_manifest(){
  local manifest=$1 expected=$2
  awk -v expected="$expected" '
    NF != 2 || length($1) != 64 || $1 !~ /^[0-9a-f]+$/ || $2 != expected { exit 1 }
    { count++ }
    END { exit count == 1 ? 0 : 1 }
  ' "$manifest" >/dev/null 2>&1
}
valid_env_syntax(){
  awk '/^[[:space:]]*($|#)/{next} /^[A-Za-z_][A-Za-z0-9_]*=/{next} {exit 1}' "$1" >/dev/null 2>&1 &&
    bash -n "$1" >/dev/null 2>&1
}

checkpoint PRODUCTION_BACKUP_PREPARATION=STARTED
STAGE=confirmation; COMMAND=validate_confirmation
[[ "${CONFIRM:-}" == PREPARE_PRODUCTION_RECOVERY_BACKUP ]]
STAGE=expected_sha; COMMAND=validate_expected_sha
[[ "${EXPECTED_SHA:-}" =~ ^[0-9a-f]{40}$ ]]
STAGE=prerequisites; COMMAND=validate_required_commands
for c in awk bash cp date docker df flock git grep gzip install mktemp mv node readlink sha256sum stat sync; do need "$c"; done
STAGE=checkout; COMMAND=validate_main_checkout
cd "$APP_DIR"
[[ "$(git branch --show-current 2>/dev/null)" == main && "$(git rev-parse HEAD 2>/dev/null)" == "$EXPECTED_SHA" && -z "$(git status --porcelain 2>/dev/null)" ]]
git show-ref --verify --quiet refs/remotes/origin/main >/dev/null 2>&1
[[ "$(git rev-parse HEAD 2>/dev/null)" == "$(git rev-parse origin/main 2>/dev/null)" ]]

# The canonical file is authoritative whenever any directory entry exists.
# Only its complete absence authorizes the single, read-only legacy source.
STAGE=env_resolution; COMMAND=resolve_production_configuration
if [[ -e "$CANONICAL_ENV_FILE" || -L "$CANONICAL_ENV_FILE" ]]; then
  ENV_FILE="$CANONICAL_ENV_FILE"; ENV_SOURCE=canonical
elif [[ -e "$LEGACY_ENV_FILE" || -L "$LEGACY_ENV_FILE" ]]; then
  ENV_FILE="$LEGACY_ENV_FILE"; ENV_SOURCE=legacy_read_only
else
  false
fi
STAGE=env_metadata; COMMAND=validate_protected_configuration_metadata
protected_regular "$ENV_FILE"
STAGE=env_syntax; COMMAND=validate_protected_configuration_syntax
valid_env_syntax "$ENV_FILE"
# Loading is read-only. Neither source is copied, reconciled, installed or promoted.
set -a; source "$ENV_FILE"; set +a
STAGE=required_configuration; COMMAND=validate_backup_configuration_contract
for required in DATABASE_URL PRODUCTION_DB_HOST_EXPECTED PRODUCTION_DB_CONTAINER_EXPECTED PRODUCTION_DB_VOLUME_EXPECTED; do
  [[ -n "${!required:-}" ]]
done
checkpoint "PRODUCTION_BACKUP_ENV_SOURCE=$ENV_SOURCE"

STAGE=authorized_directory; COMMAND=validate_authorized_directory
AUTHORIZED_DIR="${PRODUCTION_BACKUP_AUTHORIZED_DIR:-/root/backups}"
[[ "$AUTHORIZED_DIR" == /* ]]
[[ "$AUTHORIZED_DIR" != */../* && "$AUTHORIZED_DIR" != */.. && "$AUTHORIZED_DIR" != */./* && "$AUTHORIZED_DIR" != */. ]]
[[ -e "$AUTHORIZED_DIR" && -d "$AUTHORIZED_DIR" && ! -L "$AUTHORIZED_DIR" ]]
[[ "$(readlink -m -- "$AUTHORIZED_DIR")" == "$AUTHORIZED_DIR" && "$AUTHORIZED_DIR" != / ]]
checkpoint PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY=PASS

STAGE=dump_path_contract; COMMAND=validate_dump_path_contract
raw_dump="${PRODUCTION_BACKUP_FILE:-production.sql.gz}"
dump_base="$(basename -- "$raw_dump")"
[[ -n "$dump_base" && "$dump_base" != . && "$dump_base" != .. ]]
EXPECTED_DUMP_PATH="$AUTHORIZED_DIR/$dump_base"
target_dump="${PRODUCTION_BACKUP_FILE:-$EXPECTED_DUMP_PATH}"

STAGE=dump_path_contract; COMMAND=validate_dump_path_absolute
[[ "$target_dump" == /* ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_ABSOLUTE=PASS

STAGE=dump_path_contract; COMMAND=validate_dump_path_traversal
[[ "$target_dump" != */../* && "$target_dump" != */.. && "$target_dump" != */./* && "$target_dump" != */. ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_TRAVERSAL=PASS

STAGE=dump_path_contract; COMMAND=validate_dump_path_normalized
[[ "$(readlink -m -- "$target_dump")" == "$target_dump" ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_NORMALIZED=PASS

STAGE=dump_path_contract; COMMAND=validate_dump_path_parent
dump_parent="$(dirname -- "$target_dump")"
[[ "$dump_parent" == "$AUTHORIZED_DIR" ]]
[[ "$target_dump" == "$EXPECTED_DUMP_PATH" ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_PARENT=PASS

STAGE=dump_path_contract; COMMAND=validate_dump_path_contract
[[ ! -L "$target_dump" ]]
[[ ! -e "$target_dump" || -f "$target_dump" ]]
PRODUCTION_BACKUP_FILE="$target_dump"
checkpoint PRODUCTION_BACKUP_DUMP_PATH_CONTRACT=PASS

STAGE=manifest_path_contract; COMMAND=validate_manifest_path_contract
raw_manifest="${PRODUCTION_BACKUP_SHA256_FILE:-${dump_base}.sha256}"
manifest_base="$(basename -- "$raw_manifest")"
[[ -n "$manifest_base" && "$manifest_base" != . && "$manifest_base" != .. ]]
EXPECTED_MANIFEST_PATH="$AUTHORIZED_DIR/$manifest_base"
target_manifest="${PRODUCTION_BACKUP_SHA256_FILE:-$EXPECTED_MANIFEST_PATH}"

STAGE=manifest_path_contract; COMMAND=validate_manifest_path_absolute
[[ "$target_manifest" == /* ]]
checkpoint PRODUCTION_BACKUP_MANIFEST_PATH_ABSOLUTE=PASS

STAGE=manifest_path_contract; COMMAND=validate_manifest_path_traversal
[[ "$target_manifest" != */../* && "$target_manifest" != */.. && "$target_manifest" != */./* && "$target_manifest" != */. ]]
checkpoint PRODUCTION_BACKUP_MANIFEST_PATH_TRAVERSAL=PASS

STAGE=manifest_path_contract; COMMAND=validate_manifest_path_normalized
[[ "$(readlink -m -- "$target_manifest")" == "$target_manifest" ]]
checkpoint PRODUCTION_BACKUP_MANIFEST_PATH_NORMALIZED=PASS

STAGE=manifest_path_contract; COMMAND=validate_manifest_path_parent
manifest_parent="$(dirname -- "$target_manifest")"
[[ "$manifest_parent" == "$AUTHORIZED_DIR" ]]
[[ "$target_manifest" == "$EXPECTED_MANIFEST_PATH" ]]
checkpoint PRODUCTION_BACKUP_MANIFEST_PATH_PARENT=PASS

STAGE=manifest_path_contract; COMMAND=validate_manifest_path_contract
[[ ! -L "$target_manifest" ]]
[[ ! -e "$target_manifest" || -f "$target_manifest" ]]
[[ "$target_manifest" != "$PRODUCTION_BACKUP_FILE" ]]
PRODUCTION_BACKUP_SHA256_FILE="$target_manifest"
checkpoint PRODUCTION_BACKUP_MANIFEST_PATH_CONTRACT=PASS

STAGE=existing_pair_state; COMMAND=validate_existing_pair_state
if [[ ! -e "$PRODUCTION_BACKUP_FILE" && ! -e "$PRODUCTION_BACKUP_SHA256_FILE" ]]; then
  checkpoint PRODUCTION_BACKUP_EXISTING_PAIR_STATE=absent
else
  protected_regular "$PRODUCTION_BACKUP_FILE"
  protected_regular "$PRODUCTION_BACKUP_SHA256_FILE"
  valid_existing_manifest "$PRODUCTION_BACKUP_SHA256_FILE" "$(basename "$PRODUCTION_BACKUP_FILE")"
  (cd "$AUTHORIZED_DIR" && sha256sum -c "$(basename "$PRODUCTION_BACKUP_SHA256_FILE")" >/dev/null)
  checkpoint PRODUCTION_BACKUP_EXISTING_PAIR_STATE=complete_valid
fi

STAGE=database_url_contract; COMMAND=parse_database_url
db_inventory="$(DATABASE_URL="$DATABASE_URL" node -e 'const u=new URL(process.env.DATABASE_URL); if (!u.hostname || !u.pathname.slice(1)) process.exit(1); process.stdout.write(`${u.hostname}\t${u.pathname.slice(1)}`)')"
IFS=$'\t' read -r db_host db_name <<<"$db_inventory"
STAGE=database_url_contract; COMMAND=validate_database_url
[[ "$db_host" == "$PRODUCTION_DB_HOST_EXPECTED" ]]
[[ "$db_host" != db && "$db_host" != localhost && "$db_host" != 127.0.0.1 ]]
[[ "$db_name" == salesforce_pro ]]
unset db_inventory db_host db_name
checkpoint PRODUCTION_BACKUP_DATABASE_URL_CONTRACT=PASS

STAGE=database_container; COMMAND=validate_database_container_exists
container_name="$(docker inspect -f '{{.Name}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" 2>/dev/null)"
[[ "$container_name" == "/$PRODUCTION_DB_CONTAINER_EXPECTED" ]]
STAGE=database_container; COMMAND=validate_database_container_running
[[ "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" 2>/dev/null)" == true ]]
STAGE=database_container; COMMAND=validate_database_container_health
container_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" 2>/dev/null)"
[[ -z "$container_health" || "$container_health" == healthy ]]
unset container_name container_health
checkpoint PRODUCTION_BACKUP_DB_CONTAINER=PASS

STAGE=database_network; COMMAND=validate_database_network
docker network inspect gest-o_default >/dev/null 2>&1
checkpoint PRODUCTION_BACKUP_DB_NETWORK=PASS
STAGE=database_volume; COMMAND=validate_database_volume
docker volume inspect "$PRODUCTION_DB_VOLUME_EXPECTED" >/dev/null 2>&1
checkpoint PRODUCTION_BACKUP_DB_VOLUME=PASS
STAGE=database_mount; COMMAND=validate_database_mount
docker inspect -f '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" 2>/dev/null |
  grep -Fqx "$PRODUCTION_DB_VOLUME_EXPECTED /var/lib/postgresql/data"
checkpoint PRODUCTION_BACKUP_DB_MOUNT=PASS

STAGE=disk_capacity; COMMAND=read_available_disk_capacity
available_kb="$(df -Pk "$AUTHORIZED_DIR" | awk 'NR==2{print $4}')"
[[ "$available_kb" =~ ^[0-9]+$ ]]
STAGE=disk_capacity; COMMAND=validate_available_disk_capacity
(( available_kb >= ${PRODUCTION_MIN_DISK_KB:-5242880} ))
unset available_kb
checkpoint PRODUCTION_BACKUP_DISK_CAPACITY=PASS
STAGE=preparation_lock; COMMAND=open_preparation_lock
exec 9>"$AUTHORIZED_DIR/.prepare-production-recovery-backup.lock"
STAGE=preparation_lock; COMMAND=acquire_preparation_lock
flock -n 9
checkpoint PRODUCTION_BACKUP_LOCK=ACQUIRED
checkpoint PRODUCTION_BACKUP_SOURCE_VALIDATED=PASS

STAGE=dump; COMMAND=create_validated_dump
source "$APP_DIR/scripts/lib/production-backup-common.sh"
backup_validate_database_health
TMP_DIR="$(mktemp -d "$AUTHORIZED_DIR/.recovery-backup.XXXXXX")"
plain="$TMP_DIR/dump.sql"; candidate="$TMP_DIR/$(basename "$PRODUCTION_BACKUP_FILE")"; manifest="$TMP_DIR/$(basename "$PRODUCTION_BACKUP_SHA256_FILE")"
docker compose exec -T db pg_dump -U postgres salesforce_pro >"$plain"
backup_validate_database_health
backup_validate_plain_dump "$plain"
checkpoint PRODUCTION_BACKUP_DUMP=PASS
gzip -c "$plain" >"$candidate"; rm -f "$plain"
backup_validate_gzip_dump "$candidate"
checkpoint PRODUCTION_BACKUP_GZIP=PASS
chmod 600 "$candidate"
(cd "$TMP_DIR" && sha256sum "$(basename "$candidate")" >"$(basename "$manifest")" && sha256sum -c "$(basename "$manifest")" >/dev/null)
chmod 600 "$manifest"; checkpoint PRODUCTION_BACKUP_MANIFEST=PASS

STAGE=atomic_promotion; COMMAND=promote_consistent_pair
[[ ! -e "$PRODUCTION_BACKUP_FILE" || -f "$PRODUCTION_BACKUP_SHA256_FILE" ]]
[[ ! -e "$PRODUCTION_BACKUP_SHA256_FILE" || -f "$PRODUCTION_BACKUP_FILE" ]]
if [[ -f "$PRODUCTION_BACKUP_FILE" ]]; then HAD_PRIOR=true; OLD_BACKUP="$TMP_DIR/old.backup"; cp -p "$PRODUCTION_BACKUP_FILE" "$OLD_BACKUP"; OLD_MANIFEST="$TMP_DIR/old.manifest"; cp -p "$PRODUCTION_BACKUP_SHA256_FILE" "$OLD_MANIFEST"; fi
PROMOTION_STARTED=true
mv -f "$candidate" "$PRODUCTION_BACKUP_FILE"
sync -f "$PRODUCTION_BACKUP_FILE"
[[ "${PRODUCTION_BACKUP_TEST_FAIL_BETWEEN_PROMOTIONS:-false}" != true ]]
mv -f "$manifest" "$PRODUCTION_BACKUP_SHA256_FILE"
sync -f "$PRODUCTION_BACKUP_SHA256_FILE"; sync -f "$AUTHORIZED_DIR"
protected_regular "$PRODUCTION_BACKUP_FILE"; protected_regular "$PRODUCTION_BACKUP_SHA256_FILE"
(cd "$AUTHORIZED_DIR" && sha256sum -c "$(basename "$PRODUCTION_BACKUP_SHA256_FILE")" >/dev/null)
PROMOTION_STARTED=false; checkpoint PRODUCTION_BACKUP_ATOMIC_PROMOTION=PASS
checkpoint PRODUCTION_BACKUP_PRESENCE=PASS; checkpoint PRODUCTION_BACKUP_INTEGRITY=PASS
(( $(date +%s) - $(stat -c %Y "$PRODUCTION_BACKUP_FILE") <= ${PRODUCTION_BACKUP_MAX_AGE_SECONDS:-86400} ))
checkpoint PRODUCTION_BACKUP_FRESHNESS=PASS
STAGE=preflight; COMMAND=run_readonly_cutover_preflight
PRODUCTION_PREFLIGHT_MODE=cutover bash scripts/production-preflight.sh >/dev/null
checkpoint PRODUCTION_PREFLIGHT=PASS
rm -rf "$TMP_DIR"; TMP_DIR=''; checkpoint PRODUCTION_BACKUP_PREPARATION=PASS
