#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="${APP_DIR:-/apps/gest-o}"
ENV_FILE="${PRODUCTION_BACKUP_ENV_FILE:-/root/demetra-env/.env}"
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
need(){ command -v "$1" >/dev/null; }
protected_regular(){ [[ -f "$1" && ! -L "$1" && "$(stat -c %U:%G "$1")" == root:root && "$(stat -c %a "$1")" == 600 ]]; }
inside_authorized(){ [[ "$(dirname -- "$1")" == "$AUTHORIZED_DIR" && "$(readlink -m -- "$1")" == "$AUTHORIZED_DIR/$(basename -- "$1")" ]]; }

checkpoint PRODUCTION_BACKUP_PREPARATION=STARTED
[[ "${CONFIRM:-}" == PREPARE_PRODUCTION_RECOVERY_BACKUP ]]
[[ "${EXPECTED_SHA:-}" =~ ^[0-9a-f]{40}$ ]]
for c in awk bash cp date docker df flock git grep gzip install mktemp mv node readlink sha256sum stat sync; do need "$c"; done
cd "$APP_DIR"
[[ "$(git branch --show-current)" == main && "$(git rev-parse HEAD)" == "$EXPECTED_SHA" && -z "$(git status --porcelain)" ]]
git show-ref --verify --quiet refs/remotes/origin/main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]]
protected_regular "$ENV_FILE"
# Syntax is checked before the protected configuration is loaded; it is never printed.
awk '/^[[:space:]]*($|#)/{next} /^[A-Za-z_][A-Za-z0-9_]*=/{next} {exit 1}' "$ENV_FILE"
set -a; source "$ENV_FILE"; set +a
: "${DATABASE_URL:?}" "${PRODUCTION_DB_HOST_EXPECTED:?}" "${PRODUCTION_DB_CONTAINER_EXPECTED:?}" "${PRODUCTION_DB_VOLUME_EXPECTED:?}" "${PRODUCTION_BACKUP_FILE:?}" "${PRODUCTION_BACKUP_SHA256_FILE:?}"

STAGE=readonly_inventory; COMMAND=validate_inventory
[[ "$AUTHORIZED_DIR" == /* && -d "$AUTHORIZED_DIR" && ! -L "$AUTHORIZED_DIR" ]]
[[ "$PRODUCTION_BACKUP_FILE" != "$PRODUCTION_BACKUP_SHA256_FILE" ]]
inside_authorized "$PRODUCTION_BACKUP_FILE"; inside_authorized "$PRODUCTION_BACKUP_SHA256_FILE"
[[ ! -L "$PRODUCTION_BACKUP_FILE" && ! -L "$PRODUCTION_BACKUP_SHA256_FILE" ]]
[[ ! -e "$PRODUCTION_BACKUP_FILE" || -f "$PRODUCTION_BACKUP_FILE" ]]
[[ ! -e "$PRODUCTION_BACKUP_SHA256_FILE" || -f "$PRODUCTION_BACKUP_SHA256_FILE" ]]
[[ ! -e "$PRODUCTION_BACKUP_FILE" || "$(stat -c %U:%G "$PRODUCTION_BACKUP_FILE")" == root:root && "$(stat -c %a "$PRODUCTION_BACKUP_FILE")" == 600 ]]
[[ ! -e "$PRODUCTION_BACKUP_SHA256_FILE" || "$(stat -c %U:%G "$PRODUCTION_BACKUP_SHA256_FILE")" == root:root && "$(stat -c %a "$PRODUCTION_BACKUP_SHA256_FILE")" == 600 ]]
read -r db_host db_name < <(DATABASE_URL="$DATABASE_URL" node -e 'const u=new URL(process.env.DATABASE_URL); console.log(u.hostname,u.pathname.slice(1))')
[[ "$db_host" == "$PRODUCTION_DB_HOST_EXPECTED" && "$db_host" != db && "$db_host" != localhost && "$db_host" != 127.0.0.1 && "$db_name" == salesforce_pro ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")" == true ]]
docker network inspect gest-o_default >/dev/null
docker volume inspect "$PRODUCTION_DB_VOLUME_EXPECTED" >/dev/null
docker inspect -f '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" | grep -Fqx "$PRODUCTION_DB_VOLUME_EXPECTED /var/lib/postgresql/data"
(( $(df -Pk "$AUTHORIZED_DIR" | awk 'NR==2{print $4}') >= ${PRODUCTION_MIN_DISK_KB:-5242880} ))
exec 9>"$AUTHORIZED_DIR/.prepare-production-recovery-backup.lock"
flock -n 9
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
