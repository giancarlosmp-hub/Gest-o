#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="${APP_DIR:-/apps/gest-o}"
CANONICAL_ENV_FILE="${PRODUCTION_BACKUP_ENV_FILE:-/root/demetra-env/.env}"
LEGACY_ENV_FILE="${PRODUCTION_BACKUP_LEGACY_ENV_FILE:-/root/demetra-env/production.env}"
ENV_FILE=''
ENV_SOURCE=''
# The canonical directory input is the sole authority for promoted artifacts.
# PRODUCTION_BACKUP_AUTHORIZED_DIR remains a CLI-compatible alias only.
AUTHORIZED_DIR="${PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY:-${PRODUCTION_BACKUP_AUTHORIZED_DIR:-/root/backups}}"
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
protected_regular(){ [[ -f "$1" && ! -L "$1" && "$(stat -c %U:%G "$1")" == root:root && "$(stat -c %a "$1")" == 600 ]]; }
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
for required in DATABASE_URL PRODUCTION_DB_HOST_EXPECTED PRODUCTION_DB_VOLUME_EXPECTED; do
  [[ -n "${!required:-}" ]]
done
checkpoint "PRODUCTION_BACKUP_ENV_SOURCE=$ENV_SOURCE"
STAGE=database_container_input; COMMAND=validate_expected_container_input
if [[ -z "${PRODUCTION_DB_CONTAINER_EXPECTED:-}" ]]; then
  checkpoint PRODUCTION_BACKUP_DB_CONTAINER_STATUS=expected_container_input_missing
  false
fi
if [[ ! "$PRODUCTION_DB_CONTAINER_EXPECTED" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  checkpoint PRODUCTION_BACKUP_DB_CONTAINER_STATUS=expected_container_name_mismatch
  false
fi
checkpoint PRODUCTION_BACKUP_DB_CONTAINER_INPUT=PASS

STAGE=authorized_directory; COMMAND=validate_authorized_directory
[[ "$AUTHORIZED_DIR" == /* ]]
[[ -e "$AUTHORIZED_DIR" && -d "$AUTHORIZED_DIR" && ! -L "$AUTHORIZED_DIR" ]]
[[ "$(readlink -m -- "$AUTHORIZED_DIR")" == "$AUTHORIZED_DIR" && "$AUTHORIZED_DIR" != / ]]
checkpoint PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY=PASS

source "$APP_DIR/scripts/lib/production-backup-common.sh"
PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY="$AUTHORIZED_DIR"
backup_bind_canonical_pair
EFFECTIVE_BACKUP_FILE="$PRODUCTION_BACKUP_CANONICAL_FILE"
EFFECTIVE_BACKUP_SHA256_FILE="$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE"

# Historical path variables never select a destination. In every environment
# source they are deprecated hints: only syntax is checked before mandatory
# rebinding to the directory-derived pair.
STAGE=historical_path_contract; COMMAND=validate_historical_path_contract
historical_path_syntax_safe(){
  local historical_path=$1
  [[ -n "$historical_path" && "$historical_path" == /* ]] || return 1
  [[ "$historical_path" != *$'\n'* && "$historical_path" != *$'\r'* ]] || return 1
  if LC_ALL=C printf '%s' "$historical_path" | grep -q '[[:cntrl:]]'; then return 1; fi
  [[ "/$historical_path/" != */../* && "/$historical_path/" != */./* ]] || return 1
}
for historical_name in PRODUCTION_BACKUP_FILE PRODUCTION_BACKUP_SHA256_FILE; do
  if [[ -v "$historical_name" ]]; then
    historical_path_syntax_safe "${!historical_name}"
  fi
done
if [[ "$ENV_SOURCE" == canonical ]]; then
  checkpoint PRODUCTION_BACKUP_HISTORICAL_PATH_POLICY=REBOUND_CANONICAL_HINTS
else
  checkpoint PRODUCTION_BACKUP_HISTORICAL_PATH_POLICY=REBOUND_LEGACY_READ_ONLY
fi
checkpoint PRODUCTION_BACKUP_HISTORICAL_PATH_CONTRACT=PASS

# Rebind after validation so neither legacy hint can be used by any inventory,
# dump, removal, rollback, or promotion operation.
backup_resolve_canonical_pair
unset EFFECTIVE_BACKUP_FILE EFFECTIVE_BACKUP_SHA256_FILE historical_name

STAGE=dump_path_contract; COMMAND=validate_dump_path_contract
COMMAND=validate_dump_path_absolute
[[ "$PRODUCTION_BACKUP_FILE" == /* ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_ABSOLUTE=PASS
COMMAND=validate_dump_path_traversal
[[ "$PRODUCTION_BACKUP_FILE" != */../* && "$PRODUCTION_BACKUP_FILE" != */.. && "$PRODUCTION_BACKUP_FILE" != */./* && "$PRODUCTION_BACKUP_FILE" != */. ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_TRAVERSAL=PASS
COMMAND=validate_dump_path_normalized
[[ "$(readlink -m -- "$PRODUCTION_BACKUP_FILE")" == "$PRODUCTION_BACKUP_FILE" ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_NORMALIZED=PASS
COMMAND=validate_dump_path_parent
[[ "$(dirname -- "$PRODUCTION_BACKUP_FILE")" == "$AUTHORIZED_DIR" ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_PARENT=PASS
COMMAND=validate_dump_path_basename
[[ "$(basename -- "$PRODUCTION_BACKUP_FILE")" == production.sql.gz ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_BASENAME=PASS
COMMAND=validate_dump_path_symlink
[[ ! -L "$PRODUCTION_BACKUP_FILE" ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_SYMLINK=PASS
COMMAND=validate_dump_path_entry_type
[[ ! -e "$PRODUCTION_BACKUP_FILE" || -f "$PRODUCTION_BACKUP_FILE" ]]
checkpoint PRODUCTION_BACKUP_DUMP_PATH_ENTRY_TYPE=PASS
checkpoint PRODUCTION_BACKUP_DUMP_PATH_CONTRACT=PASS

STAGE=manifest_path_contract; COMMAND=validate_manifest_path
[[ "$PRODUCTION_BACKUP_SHA256_FILE" == /* && "$PRODUCTION_BACKUP_SHA256_FILE" != */../* && "$PRODUCTION_BACKUP_SHA256_FILE" != */.. && "$PRODUCTION_BACKUP_SHA256_FILE" != */./* && "$PRODUCTION_BACKUP_SHA256_FILE" != */. ]]
[[ "$(readlink -m -- "$PRODUCTION_BACKUP_SHA256_FILE")" == "$PRODUCTION_BACKUP_SHA256_FILE" ]]
[[ "$(dirname -- "$PRODUCTION_BACKUP_SHA256_FILE")" == "$AUTHORIZED_DIR" ]]
[[ "$(basename -- "$PRODUCTION_BACKUP_SHA256_FILE")" == production.sql.gz.sha256 ]]
[[ ! -L "$PRODUCTION_BACKUP_SHA256_FILE" ]]
[[ ! -e "$PRODUCTION_BACKUP_SHA256_FILE" || -f "$PRODUCTION_BACKUP_SHA256_FILE" ]]
[[ "$PRODUCTION_BACKUP_FILE" != "$PRODUCTION_BACKUP_SHA256_FILE" ]]
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

capture_database_container_snapshot(){
  local matches inspect_json snapshot name identity running health extra failure_detail
  classify_docker_inspect_failure(){
    local detail=$1 classification=malformed_inspect_output
    if [[ "$detail" =~ [Tt]emplate ]] || [[ "$detail" == *"can't evaluate field"* ]] || [[ "$detail" == *"function "* ]]; then
      classification=template_error
    elif [[ "$detail" =~ [Nn]o[[:space:]]such[[:space:]](object|container) ]] || [[ "$detail" =~ [Nn]ot[[:space:]]found ]]; then
      classification=object_not_found
    elif [[ "$detail" =~ [Pp]ermission[[:space:]]denied ]] || [[ "$detail" =~ [Aa]ccess[[:space:]]denied ]]; then
      classification=permission_denied
    elif [[ "$detail" =~ [Cc]annot[[:space:]]connect.*[Dd]ocker ]] || [[ "$detail" =~ [Dd]ocker[[:space:]]daemon ]] || [[ "$detail" =~ [Cc]onnection[[:space:]]refused ]]; then
      classification=daemon_unreachable
    fi
    printf 'PRODUCTION_BACKUP_DB_CONTAINER_STATUS=%s\n' "$classification" >&2
  }
  if ! matches="$(docker ps -aq --no-trunc --filter "name=^/${PRODUCTION_DB_CONTAINER_EXPECTED}$" 2>&1)"; then
    classify_docker_inspect_failure "$matches"; return 1
  fi
  if [[ -z "$matches" ]]; then
    printf '%s\n' PRODUCTION_BACKUP_DB_CONTAINER_STATUS=expected_container_missing >&2; return 1
  fi
  if [[ "$matches" == *$'\n'* ]]; then
    printf '%s\n' PRODUCTION_BACKUP_DB_CONTAINER_STATUS=expected_container_ambiguous >&2; return 1
  fi
  # Read Docker's native JSON rather than composing fields with a Go template.
  # The parser enforces the complete schema and emits a private, fixed-width
  # snapshot used only for the checks below and the TOCTOU identity comparison.
  if ! inspect_json="$(docker inspect "$matches" 2>&1)"; then
    classify_docker_inspect_failure "$inspect_json"; return 1
  fi
  if ! snapshot="$(INSPECT_JSON="$inspect_json" node - <<'NODE'
const fail = () => process.exit(1);
let inspected;
try { inspected = JSON.parse(process.env.INSPECT_JSON); } catch { fail(); }
if (!Array.isArray(inspected) || inspected.length !== 1) fail();
const value = inspected[0];
if (!value || typeof value.Name !== 'string' || typeof value.Id !== 'string' ||
    !value.State || typeof value.State.Running !== 'boolean') fail();
let health = 'none';
if (value.State.Health != null) {
  if (typeof value.State.Health !== 'object' || typeof value.State.Health.Status !== 'string') fail();
  health = value.State.Health.Status;
}
if ([value.Name, value.Id, health].some(field => field.includes('\t') || field.includes('\n'))) fail();
process.stdout.write(`${value.Name}\t${value.Id}\t${value.State.Running}\t${health}`);
NODE
  )"; then
    printf '%s\n' PRODUCTION_BACKUP_DB_CONTAINER_STATUS=malformed_inspect_output >&2; return 1
  fi
  IFS=$'\t' read -r name identity running health extra <<<"$snapshot"
  if [[ -n "$extra" || "$name" != "/$PRODUCTION_DB_CONTAINER_EXPECTED" ]]; then
    printf '%s\n' PRODUCTION_BACKUP_DB_CONTAINER_STATUS=expected_container_name_mismatch >&2; return 1
  fi
  if [[ ! "$identity" =~ ^[0-9a-f]{64}$ || ( "$health" != none && "$health" != healthy && "$health" != unhealthy && "$health" != starting ) ]]; then
    printf '%s\n' PRODUCTION_BACKUP_DB_CONTAINER_STATUS=malformed_inspect_output >&2; return 1
  fi
  if [[ "$running" != true ]]; then
    printf '%s\n' PRODUCTION_BACKUP_DB_CONTAINER_STATUS=expected_container_not_running >&2; return 1
  fi
  if [[ "$health" != none && "$health" != healthy ]]; then
    printf '%s\n' PRODUCTION_BACKUP_DB_CONTAINER_STATUS=expected_container_unhealthy >&2; return 1
  fi
  printf '%s' "$snapshot"
}
STAGE=database_container; COMMAND=capture_validated_database_identity
database_container_snapshot="$(capture_database_container_snapshot)"
database_container_identity="${database_container_snapshot#*$'\t'}"
database_container_identity="${database_container_identity%%$'\t'*}"
checkpoint PRODUCTION_BACKUP_DB_CONTAINER_STATUS=validated
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

STAGE=dump; COMMAND=prepare_validated_dump
source "$APP_DIR/scripts/lib/production-backup-common.sh"
TMP_DIR="$(mktemp -d "$AUTHORIZED_DIR/.recovery-backup.XXXXXX")"
POSTGRES_ERROR_FILE="$TMP_DIR/postgresql.stderr"
classify_postgresql_failure(){
  local operation=$1 error_file=$2
  if grep -Eqi 'peer authentication failed' "$error_file"; then
    checkpoint PRODUCTION_BACKUP_DB_COMMAND_STATUS=peer_authentication_failed >&2
  elif [[ "$operation" == psql ]]; then
    checkpoint PRODUCTION_BACKUP_DB_COMMAND_STATUS=psql_failed >&2
  else
    checkpoint PRODUCTION_BACKUP_DB_COMMAND_STATUS=pg_dump_failed >&2
  fi
}

# Validate the fixed, non-root OS identity before the first database access.
# Docker's diagnostic is inspected privately solely to distinguish a missing
# account from an inability to select it; it is never copied to workflow logs.
STAGE=database_os_user; COMMAND=validate_postgresql_os_user
if postgres_uid="$(docker exec --user postgres -i "$PRODUCTION_DB_CONTAINER_EXPECTED" id -u 2>"$POSTGRES_ERROR_FILE")"; then
  if [[ ! "$postgres_uid" =~ ^[0-9]+$ || "$postgres_uid" == 0 ]]; then
    checkpoint PRODUCTION_BACKUP_DB_OS_USER_STATUS=os_user_selection_failed >&2
    false
  fi
else
  rc=$?
  if grep -Eqi 'unable to find user|no matching entries in passwd|unknown user' "$POSTGRES_ERROR_FILE"; then
    checkpoint PRODUCTION_BACKUP_DB_OS_USER_STATUS=postgres_os_user_missing >&2
  else
    checkpoint PRODUCTION_BACKUP_DB_OS_USER_STATUS=os_user_selection_failed >&2
  fi
  (exit "$rc")
fi
unset postgres_uid rc
: >"$POSTGRES_ERROR_FILE"
checkpoint PRODUCTION_BACKUP_DB_OS_USER=VALIDATED

STAGE=dump; COMMAND=validate_database_health
export BACKUP_POSTGRES_ERROR_FILE="$POSTGRES_ERROR_FILE"
if backup_validate_database_health_in_validated_container "$PRODUCTION_DB_CONTAINER_EXPECTED"; then
  checkpoint PRODUCTION_BACKUP_DB_HEALTH_QUERY=PASS
else
  rc=$?; classify_postgresql_failure psql "$POSTGRES_ERROR_FILE"; (exit "$rc")
fi
: >"$POSTGRES_ERROR_FILE"
plain="$TMP_DIR/dump.sql"; candidate="$TMP_DIR/$(basename "$PRODUCTION_BACKUP_FILE")"; manifest="$TMP_DIR/$(basename "$PRODUCTION_BACKUP_SHA256_FILE")"
STAGE=dump_target_revalidation; COMMAND=revalidate_validated_database_identity
checkpoint PRODUCTION_BACKUP_DUMP_TARGET=VALIDATED_CONTAINER
revalidated_database_container_snapshot="$(capture_database_container_snapshot)"
revalidated_database_container_identity="${revalidated_database_container_snapshot#*$'\t'}"
revalidated_database_container_identity="${revalidated_database_container_identity%%$'\t'*}"
[[ "$revalidated_database_container_identity" == "$database_container_identity" ]]
checkpoint PRODUCTION_BACKUP_DB_IDENTITY_REVALIDATED=PASS
STAGE=dump; COMMAND=create_validated_dump
if docker exec --user postgres -i "$PRODUCTION_DB_CONTAINER_EXPECTED" pg_dump -U postgres -d salesforce_pro >"$plain" 2>"$POSTGRES_ERROR_FILE"; then
  :
else
  rc=$?; classify_postgresql_failure pg_dump "$POSTGRES_ERROR_FILE"; (exit "$rc")
fi
: >"$POSTGRES_ERROR_FILE"
if backup_validate_database_health_in_validated_container "$PRODUCTION_DB_CONTAINER_EXPECTED"; then
  checkpoint PRODUCTION_BACKUP_DB_HEALTH_QUERY=PASS
else
  rc=$?; classify_postgresql_failure psql "$POSTGRES_ERROR_FILE"; (exit "$rc")
fi
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
backup_validate_canonical_pair_and_freshness "$PRODUCTION_BACKUP_FILE" "$PRODUCTION_BACKUP_SHA256_FILE" "${PRODUCTION_BACKUP_MAX_AGE_SECONDS:-86400}"
# Shared validation above emits PRODUCTION_BACKUP_FRESHNESS=PASS.
STAGE=preflight; COMMAND=run_readonly_cutover_preflight
PRODUCTION_PREFLIGHT_MODE=cutover bash scripts/production-preflight.sh >/dev/null
checkpoint PRODUCTION_PREFLIGHT=PASS
rm -rf "$TMP_DIR"; TMP_DIR=''; checkpoint PRODUCTION_BACKUP_PREPARATION=PASS
