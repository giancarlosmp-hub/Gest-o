#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
APP="$TMP/app"; AUTH="$TMP/authorized"; BIN="$TMP/bin"; ENV_FILE="$TMP/production.env"
mkdir -p "$APP/scripts/lib" "$AUTH" "$BIN"
cp "$ROOT/scripts/prepare-production-recovery-backup.sh" "$APP/scripts/"
cp "$ROOT/scripts/lib/production-backup-common.sh" "$APP/scripts/lib/"
cp "$ROOT/scripts/check-prod-health.sh" "$APP/scripts/"
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
  'compose exec -T')
    printf '%s\n' 'Compose execution is forbidden in recovery backup' >&2
    exit 99
    ;;
  'ps -aq --no-trunc')
    [[ "${MOCK_PS_FAIL:-false}" != true ]] || exit 1
    [[ "${MOCK_STATE:-running}" != absent ]] || exit 0
    printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    [[ "${MOCK_AMBIGUOUS:-false}" != true ]] || printf '%s\n' cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
    ;;
  'inspect aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'*|'inspect cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'*)
    count=0; [[ -f "$INSPECT_COUNT" ]] && read -r count <"$INSPECT_COUNT"; count=$((count + 1)); printf '%s\n' "$count" >"$INSPECT_COUNT"
    case "${MOCK_INSPECT_FAIL:-false}" in
      template) printf 'template parsing error: protected-sentinel\n' >&2; exit 1 ;;
      missing) printf 'Error: No such object: protected-sentinel\n' >&2; exit 1 ;;
      permission) printf 'permission denied: protected-sentinel\n' >&2; exit 1 ;;
      daemon) printf 'Cannot connect to the Docker daemon: protected-sentinel\n' >&2; exit 1 ;;
      malformed) printf 'not-json protected-sentinel\n'; exit 0 ;;
    esac
    identity="${MOCK_ID:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
    [[ "${MOCK_REPLACE:-false}" != true || "$count" -lt 2 ]] || identity=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    running=true; [[ "${MOCK_STATE:-running}" != stopped ]] || running=false
    health="${MOCK_HEALTH:-healthy}"
    name=postgres-production; [[ "${MOCK_NAME_MISMATCH:-false}" != true ]] || name=different-postgres
    if [[ "$health" == none ]]; then
      printf '[{"Name":"/%s","Id":"%s","State":{"Running":%s}}]\n' "$name" "$identity" "$running"
    else
      printf '[{"Name":"/%s","Id":"%s","State":{"Running":%s,"Health":{"Status":"%s"}}}]\n' "$name" "$identity" "$running" "$health"
    fi
    ;;
  'inspect -f {{range .Mounts}}{{println .Name .Destination}}{{end}}') printf 'production-data /var/lib/postgresql/data\n' ;;
  'network inspect gest-o_default'|'volume inspect production-data') exit 0 ;;
  'exec --user postgres')
    [[ "${4:-}" == -i && "${5:-}" == postgres-production ]]
    if [[ "${6:-}" == id ]]; then
      case "${MOCK_OS_USER:-present}" in
        missing) printf 'unable to find user postgres: protected-sentinel\n' >&2; exit 45 ;;
        selection) printf 'runtime selection failed: protected-sentinel\n' >&2; exit 46 ;;
      esac
      printf '999\n'
    elif [[ "${6:-}" == psql ]]; then
      printf 'health\n' >>"$ORDER_LOG"
      case "${MOCK_PSQL_FAILURE:-none}" in
        peer) printf 'FATAL: Peer authentication failed for user protected-sentinel\n' >&2; exit 47 ;;
        real) printf 'query failed with protected-sentinel\n' >&2; exit 48 ;;
      esac
      printf '1\n'
    else
      printf 'dump\n' >>"$ORDER_LOG"
      [[ "${MOCK_PG_DUMP_PEER:-false}" != true ]] || { printf 'FATAL: Peer authentication failed for user protected-sentinel\n' >&2; exit 49; }
      [[ "${MOCK_PG_DUMP_EXIT:-0}" == 0 ]] || exit "$MOCK_PG_DUMP_EXIT"
      printf '%s\n' '-- PostgreSQL database dump' 'CREATE TABLE validated_container (id integer);' 'COPY validated_container (id) FROM stdin;' '1' '\\.'
    fi
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
${OMIT_EXPECTED_INPUT:+#}PRODUCTION_DB_CONTAINER_EXPECTED=postgres-production
PRODUCTION_DB_VOLUME_EXPECTED=production-data
EOF
  chmod 600 "$ENV_FILE"
  set +e
  env PATH="$BIN:$PATH" APP_DIR="$APP" PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY="$AUTH" \
    PRODUCTION_BACKUP_ENV_FILE="$TMP/absent" PRODUCTION_BACKUP_LEGACY_ENV_FILE="$ENV_FILE" \
    PRODUCTION_MIN_DISK_KB=1 PRODUCTION_BACKUP_MIN_SIZE_BYTES=1 MOCK_DOCKER_LOG="$TMP/docker.log" \
    INSPECT_COUNT="$TMP/inspect-count" ORDER_LOG="$TMP/order.log" MOCK_STATE="${MOCK_STATE:-running}" \
    MOCK_HEALTH="${MOCK_HEALTH:-healthy}" MOCK_REPLACE="${MOCK_REPLACE:-false}" MOCK_AMBIGUOUS="${MOCK_AMBIGUOUS:-false}" \
    MOCK_NAME_MISMATCH="${MOCK_NAME_MISMATCH:-false}" MOCK_INSPECT_FAIL="${MOCK_INSPECT_FAIL:-false}" MOCK_PS_FAIL="${MOCK_PS_FAIL:-false}" \
    MOCK_OS_USER="${MOCK_OS_USER:-present}" MOCK_PSQL_FAILURE="${MOCK_PSQL_FAILURE:-none}" \
    MOCK_PG_DUMP_PEER="${MOCK_PG_DUMP_PEER:-false}" MOCK_PG_DUMP_EXIT="${MOCK_PG_DUMP_EXIT:-0}" \
    CONFIRM=PREPARE_PRODUCTION_RECOVERY_BACKUP EXPECTED_SHA="$SHA" \
    bash "$APP/scripts/prepare-production-recovery-backup.sh" >"$out" 2>&1
  rc=$?; set -e
  ! grep -Eq 'user-sentinel|password-sentinel|protected-sentinel|database\.example\.invalid|postgres-production|different-postgres|production\.sql|/tmp/|[abc]{64}' "$out"
  if [[ -n "$expected_stage" ]]; then
    (( rc != 0 )); grep -Fq "BACKUP_FAILURE_STAGE=$expected_stage" "$out"
    if [[ "${EXPECT_DUMP_ATTEMPT:-false}" == true ]]; then
      grep -Fxq 'exec --user postgres -i postgres-production pg_dump -U postgres -d salesforce_pro' "$TMP/docker.log"
    else
      ! grep -Fq 'exec --user postgres -i postgres-production pg_dump' "$TMP/docker.log"
    fi
  else
    (( rc == 0 )); grep -Fq 'PRODUCTION_BACKUP_DUMP_TARGET=VALIDATED_CONTAINER' "$out"
    grep -Fq 'PRODUCTION_BACKUP_DB_OS_USER=VALIDATED' "$out"
    grep -Fq 'PRODUCTION_BACKUP_DB_HEALTH_QUERY=PASS' "$out"
    grep -Fq 'PRODUCTION_BACKUP_DB_IDENTITY_REVALIDATED=PASS' "$out"
    grep -Fq 'PRODUCTION_BACKUP_DUMP=PASS' "$out"
    [[ -f "$AUTH/production.sql.gz" && -f "$AUTH/production.sql.gz.sha256" ]]
    (cd "$AUTH" && sha256sum -c production.sql.gz.sha256 >/dev/null)
    [[ "$(cat "$TMP/order.log")" == $'health\nhealth\nhealth\nhealth\nhealth\nhealth\ndump\nhealth\nhealth\nhealth\nhealth\nhealth\nhealth\npreflight' ]]
    grep -Fxq 'exec --user postgres -i postgres-production pg_dump -U postgres -d salesforce_pro' "$TMP/docker.log"
    ! grep -Eq '^exec -i postgres-production (psql|pg_dump)|^exec --user root ' "$TMP/docker.log"
    ! grep -Eq '^compose |^docker-compose ' "$TMP/docker.log"
  fi
  if [[ -n "${EXPECTED_STATUS:-}" ]]; then grep -Fq "PRODUCTION_BACKUP_DB_CONTAINER_STATUS=$EXPECTED_STATUS" "$out"; fi
  unset MOCK_STATE MOCK_HEALTH MOCK_REPLACE MOCK_AMBIGUOUS MOCK_NAME_MISMATCH MOCK_INSPECT_FAIL MOCK_PS_FAIL MOCK_OS_USER MOCK_PSQL_FAILURE MOCK_PG_DUMP_PEER MOCK_PG_DUMP_EXIT EXPECT_DUMP_ATTEMPT OMIT_EXPECTED_INPUT EXPECTED_STATUS
}

run_case happy
MOCK_HEALTH=none; run_case no-healthcheck
MOCK_REPLACE=true; run_case replaced dump_target_revalidation
OMIT_EXPECTED_INPUT=true EXPECTED_STATUS=expected_container_input_missing; run_case input-missing database_container_input
MOCK_STATE=stopped EXPECTED_STATUS=expected_container_not_running; run_case stopped database_container
MOCK_HEALTH=unhealthy EXPECTED_STATUS=expected_container_unhealthy; run_case unhealthy database_container
MOCK_STATE=absent EXPECTED_STATUS=expected_container_missing; run_case absent database_container
MOCK_NAME_MISMATCH=true EXPECTED_STATUS=expected_container_name_mismatch; run_case mismatch database_container
MOCK_AMBIGUOUS=true EXPECTED_STATUS=expected_container_ambiguous; run_case ambiguous database_container
MOCK_INSPECT_FAIL=malformed EXPECTED_STATUS=malformed_inspect_output; run_case inspect-malformed database_container
MOCK_INSPECT_FAIL=template EXPECTED_STATUS=template_error; run_case inspect-template-error database_container
MOCK_INSPECT_FAIL=missing EXPECTED_STATUS=object_not_found; run_case inspect-object-missing database_container
MOCK_INSPECT_FAIL=permission EXPECTED_STATUS=permission_denied; run_case inspect-permission database_container
MOCK_INSPECT_FAIL=daemon EXPECTED_STATUS=daemon_unreachable; run_case inspect-daemon database_container
MOCK_OS_USER=missing; run_case os-user-missing database_os_user
grep -Fq 'PRODUCTION_BACKUP_DB_OS_USER_STATUS=postgres_os_user_missing' "$TMP/os-user-missing.out"
MOCK_OS_USER=selection; run_case os-user-selection database_os_user
grep -Fq 'PRODUCTION_BACKUP_DB_OS_USER_STATUS=os_user_selection_failed' "$TMP/os-user-selection.out"
MOCK_PSQL_FAILURE=peer; run_case psql-peer dump
grep -Fq 'PRODUCTION_BACKUP_DB_COMMAND_STATUS=peer_authentication_failed' "$TMP/psql-peer.out"
MOCK_PSQL_FAILURE=real; run_case psql-real dump
grep -Fq 'PRODUCTION_BACKUP_DB_COMMAND_STATUS=psql_failed' "$TMP/psql-real.out"
MOCK_PG_DUMP_PEER=true EXPECT_DUMP_ATTEMPT=true; run_case pg-dump-peer dump
grep -Fq 'PRODUCTION_BACKUP_DB_COMMAND_STATUS=peer_authentication_failed' "$TMP/pg-dump-peer.out"
MOCK_PG_DUMP_EXIT=37 EXPECT_DUMP_ATTEMPT=true; run_case pg-dump-exit dump
grep -Fq 'BACKUP_FAILURE_EXIT_CODE=37' "$TMP/pg-dump-exit.out"
grep -Fq 'PRODUCTION_BACKUP_DB_COMMAND_STATUS=pg_dump_failed' "$TMP/pg-dump-exit.out"

! grep -Fq 'docker compose exec -T db' "$ROOT/scripts/prepare-production-recovery-backup.sh"
! grep -Eq "docker[ -]compose exec -T db|exec -T ['\"]?db['\"]?.*pg_dump" \
  "$ROOT/scripts/prepare-production-recovery-backup.sh" "$ROOT/scripts/lib/production-backup-common.sh"
! grep -Fq '{{.Name}}{{"\t"}}' "$ROOT/scripts/prepare-production-recovery-backup.sh"
! grep -Eq 'docker (compose )?(up|start|restart)|docker compose run|sh -c|bash -c' "$ROOT/scripts/prepare-production-recovery-backup.sh"
! grep -Eqi 'recovery|cutover|migrat|seed|backfill|sync' "$TMP/docker.log"
printf '%s\n' 'Production backup validated external container: PASS'
