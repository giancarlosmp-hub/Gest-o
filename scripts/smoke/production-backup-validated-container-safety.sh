#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
APP="$TMP/app"; AUTH="$TMP/authorized"; BIN="$TMP/bin"; ENV_FILE="$TMP/production.env"
mkdir -p "$APP/scripts/lib" "$AUTH" "$BIN"
cp "$ROOT/scripts/prepare-production-recovery-backup.sh" "$APP/scripts/"
cp "$ROOT/scripts/lib/production-backup-common.sh" "$APP/scripts/lib/"
cat >"$APP/scripts/check-prod-health.sh" <<'EOF'
#!/usr/bin/env bash
printf 'USER_COUNT=1\nCLIENT_COUNT=1\nOPPORTUNITY_COUNT=0\nTIMELINE_EVENT_COUNT=0\n'
EOF
cat >"$APP/scripts/production-preflight.sh" <<'EOF'
#!/usr/bin/env bash
printf 'preflight\n' >>"$ORDER_LOG"
EOF
chmod +x "$APP/scripts/check-prod-health.sh" "$APP/scripts/production-preflight.sh"
git -C "$APP" init -q -b main; git -C "$APP" config user.email test@example.invalid
git -C "$APP" config user.name validated-container-test; git -C "$APP" add .; git -C "$APP" commit -qm initial
SHA="$(git -C "$APP" rev-parse HEAD)"; git -C "$APP" update-ref refs/remotes/origin/main "$SHA"

cat >"$BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
case "$1 $2 ${3:-}" in
  'inspect -f {{.Name}}{{"\t"}}{{.Id}}{{"\t"}}{{.State.Running}}{{"\t"}}{{if'*)
    count=0; [[ -f "$INSPECT_COUNT" ]] && read -r count <"$INSPECT_COUNT"; count=$((count + 1)); printf '%s\n' "$count" >"$INSPECT_COUNT"
    [[ "${MOCK_STATE:-running}" != absent ]] || exit 1
    identity="${MOCK_ID:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
    [[ "${MOCK_REPLACE:-false}" != true || "$count" -lt 2 ]] || identity=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    running=true; [[ "${MOCK_STATE:-running}" != stopped ]] || running=false
    health="${MOCK_HEALTH:-healthy}"
    printf '/%s\t%s\t%s\t%s\n' "$4" "$identity" "$running" "$health"
    [[ "${MOCK_AMBIGUOUS:-false}" != true ]] || printf '/%s\t%s\ttrue\thealthy\n' "$4" cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
    ;;
  'inspect -f {{range .Mounts}}{{println .Name .Destination}}{{end}}') printf 'production-data /var/lib/postgresql/data\n' ;;
  'network inspect gest-o_default'|'volume inspect production-data') exit 0 ;;
  'exec -i postgres-production')
    printf 'dump\n' >>"$ORDER_LOG"
    printf '%s\n' '-- PostgreSQL database dump' 'CREATE TABLE validated_container (id integer);' 'COPY validated_container (id) FROM stdin;' '1' '\\.'
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$BIN/docker"

run_case(){
  local label=$1 expected_stage=${2:-} out
  out="$TMP/$label.out"
  rm -f "$AUTH"/* "$TMP/inspect-count"; : >"$TMP/docker.log"; : >"$TMP/order.log"
  cat >"$ENV_FILE" <<EOF
DATABASE_URL=postgresql://user-sentinel:password-sentinel@database.example.invalid/salesforce_pro
PRODUCTION_DB_HOST_EXPECTED=database.example.invalid
PRODUCTION_DB_CONTAINER_EXPECTED=postgres-production
PRODUCTION_DB_VOLUME_EXPECTED=production-data
EOF
  chmod 600 "$ENV_FILE"
  set +e
  env PATH="$BIN:$PATH" APP_DIR="$APP" PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY="$AUTH" \
    PRODUCTION_BACKUP_ENV_FILE="$TMP/absent" PRODUCTION_BACKUP_LEGACY_ENV_FILE="$ENV_FILE" \
    PRODUCTION_MIN_DISK_KB=1 PRODUCTION_BACKUP_MIN_SIZE_BYTES=1 MOCK_DOCKER_LOG="$TMP/docker.log" \
    INSPECT_COUNT="$TMP/inspect-count" ORDER_LOG="$TMP/order.log" MOCK_STATE="${MOCK_STATE:-running}" \
    MOCK_HEALTH="${MOCK_HEALTH:-healthy}" MOCK_REPLACE="${MOCK_REPLACE:-false}" MOCK_AMBIGUOUS="${MOCK_AMBIGUOUS:-false}" \
    CONFIRM=PREPARE_PRODUCTION_RECOVERY_BACKUP EXPECTED_SHA="$SHA" \
    bash "$APP/scripts/prepare-production-recovery-backup.sh" >"$out" 2>&1
  rc=$?; set -e
  ! grep -Eq 'user-sentinel|password-sentinel|database\.example\.invalid|production\.sql|/tmp/|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$out"
  if [[ -n "$expected_stage" ]]; then
    (( rc != 0 )); grep -Fq "BACKUP_FAILURE_STAGE=$expected_stage" "$out"
    ! grep -Fq 'exec -i postgres-production pg_dump' "$TMP/docker.log"
  else
    (( rc == 0 )); grep -Fq 'PRODUCTION_BACKUP_DUMP_TARGET=VALIDATED_CONTAINER' "$out"
    grep -Fq 'PRODUCTION_BACKUP_DB_IDENTITY_REVALIDATED=PASS' "$out"
    grep -Fq 'PRODUCTION_BACKUP_DUMP=PASS' "$out"
    [[ -f "$AUTH/production.sql.gz" && -f "$AUTH/production.sql.gz.sha256" ]]
    (cd "$AUTH" && sha256sum -c production.sql.gz.sha256 >/dev/null)
    [[ "$(cat "$TMP/order.log")" == $'dump\npreflight' ]]
    grep -Fxq 'exec -i postgres-production pg_dump -U postgres -d salesforce_pro' "$TMP/docker.log"
  fi
  unset MOCK_STATE MOCK_HEALTH MOCK_REPLACE MOCK_AMBIGUOUS
}

run_case happy
MOCK_REPLACE=true; run_case replaced dump_target_revalidation
MOCK_STATE=stopped; run_case stopped database_container
MOCK_HEALTH=unhealthy; run_case unhealthy database_container
MOCK_STATE=absent; run_case absent database_container
MOCK_AMBIGUOUS=true; run_case ambiguous database_container

! grep -Fq 'docker compose exec -T db' "$ROOT/scripts/prepare-production-recovery-backup.sh"
! grep -Eq 'docker (compose )?(up|start|restart)|docker compose run|sh -c|bash -c' "$ROOT/scripts/prepare-production-recovery-backup.sh"
! grep -Eqi 'recovery|cutover|migrat|seed|backfill|sync' "$TMP/docker.log"
printf '%s\n' 'Production backup validated external container: PASS'
