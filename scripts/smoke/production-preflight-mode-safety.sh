#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/backup"
COMMAND_LOG="$TMP/commands.log"; export COMMAND_LOG

cat >"$TMP/bin/git" <<'SH'
#!/usr/bin/env bash
case "$1" in
  status) exit 0 ;;
  branch) printf 'main\n' ;;
  show-ref) exit 0 ;;
  rev-parse) printf '1111111111111111111111111111111111111111\n' ;;
  *) exit 1 ;;
esac
SH
cat >"$TMP/bin/node" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *'new URL'* ]]; then printf 'prod-db.example 5432 salesforce_pro\n'; else cat >/dev/null; fi
SH
cat >"$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
case "$1 $2" in
  'network inspect'|'volume inspect'|'image inspect') exit 0 ;;
  'inspect -f')
    case "$3" in
      '{{.State.Running}}') printf 'true\n' ;;
      '{{json .NetworkSettings.Networks}}') printf '{"gest-o_default":{}}\n' ;;
      '{{range .Mounts}}{{println .Name .Destination}}{{end}}') printf '%s /var/lib/postgresql/data\n' "$PRODUCTION_DB_VOLUME_EXPECTED" ;;
      *) exit 0 ;;
    esac ;;
  'run --rm') exit 0 ;;
  'ps --format') exit 0 ;;
  *) exit 0 ;;
esac
SH
cat >"$TMP/bin/timeout" <<'SH'
#!/usr/bin/env bash
shift
"$@"
SH
cat >"$TMP/bin/df" <<'SH'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nmock 99999999 1 99999998 1%% /\n'
SH
chmod +x "$TMP/bin/"*

export PATH="$TMP/bin:$PATH"
export DATABASE_URL='postgresql://sensitive-user:sensitive-password@prod-db.example:5432/salesforce_pro?secret=sensitive-query'
export PRODUCTION_DB_HOST_EXPECTED=prod-db.example
export PRODUCTION_DB_CONTAINER_EXPECTED=production-postgres
export PRODUCTION_DB_VOLUME_EXPECTED=production-pgdata
export PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY="$TMP/backup"
export PRODUCTION_BACKUP_FILE="$TMP/backup/production.sql.gz"
export PRODUCTION_BACKUP_SHA256_FILE="$TMP/backup/production.sql.gz.sha256"
export PR827_BACKUP_PROOF_ROOT="$TMP/protected-backup"
export PR827_BACKUP_PROOF_EXPECTED_OWNER="$(id -un):$(id -gn)"
export BACKUP_RESULT_FILE="$PR827_BACKUP_PROOF_ROOT/latest/result.tsv"
export PRODUCTION_BACKUP_MAX_AGE_SECONDS=60
export EXPECTED_SHA=1111111111111111111111111111111111111111
export PREFLIGHT_RESULT_FILE="$TMP/preflight/latest/result.tsv"
export PRODUCTION_PREFLIGHT_PROOF_ROOT="$TMP/preflight"
export PRODUCTION_PREFLIGHT_PROOF_EXPECTED_OWNER="$(id -un):$(id -gn)"

make_valid_backup() {
  printf 'valid backup payload\n' >"$PRODUCTION_BACKUP_FILE"
  (cd "$(dirname "$PRODUCTION_BACKUP_FILE")" && sha256sum "$(basename "$PRODUCTION_BACKUP_FILE")" >"$(basename "$PRODUCTION_BACKUP_SHA256_FILE")")
  rm -rf "$PR827_BACKUP_PROOF_ROOT"
  source "$ROOT/scripts/lib/pr827-backup-proof.sh"
  pr827_backup_proof_publish "$PRODUCTION_BACKUP_FILE" "$EXPECTED_SHA" "$BACKUP_RESULT_FILE" 3600
}
run_case() {
  local name=$1 mode=${2-__unset}; shift 2 || true
  : >"$COMMAND_LOG"
  if [[ "$mode" == __unset ]]; then
    env -u PRODUCTION_PREFLIGHT_MODE bash "$ROOT/scripts/production-preflight.sh" >"$TMP/$name.out" 2>&1
  else
    PRODUCTION_PREFLIGHT_MODE="$mode" bash "$ROOT/scripts/production-preflight.sh" >"$TMP/$name.out" 2>&1
  fi
}

# A: build tolera idade, preservando presença e o SHA256 existente.
make_valid_backup; touch -d '2 days ago' "$PRODUCTION_BACKUP_FILE"
run_case build_stale build
grep -qx 'PRODUCTION_PREFLIGHT_MODE=build' "$TMP/build_stale.out"
grep -qx 'PRODUCTION_BACKUP_PRESENCE=PASS' "$TMP/build_stale.out"
grep -qx 'PRODUCTION_BACKUP_INTEGRITY=PASS' "$TMP/build_stale.out"
grep -qx 'PRODUCTION_BACKUP_FRESHNESS=NOT_REQUIRED_BUILD_ONLY' "$TMP/build_stale.out"
grep -qx 'PRODUCTION_PREFLIGHT=PASS' "$TMP/build_stale.out"

# B/C: ausência e corrupção falham com diagnóstico sanitizado.
rm -f "$PR827_BACKUP_RESOLVED_DUMP"
if run_case build_missing build; then exit 1; fi
grep -qx 'PRODUCTION_PREFLIGHT_FAILURE=backup_proof_invalid' "$TMP/build_missing.out"
make_valid_backup; printf 'corruption\n' >>"$PR827_BACKUP_RESOLVED_DUMP"
if run_case build_invalid build; then exit 1; fi
grep -qx 'PRODUCTION_PREFLIGHT_FAILURE=backup_proof_invalid' "$TMP/build_invalid.out"

# D/E: cutover mantém frescor obrigatório.
make_valid_backup
sed -i "s/^CREATED_AT_EPOCH.*/CREATED_AT_EPOCH\t$(( $(date +%s) - 172800 ))/" "$BACKUP_RESULT_FILE"
if run_case cutover_stale cutover; then exit 1; fi
grep -qx 'PRODUCTION_PREFLIGHT_FAILURE=backup_proof_invalid' "$TMP/cutover_stale.out"
make_valid_backup
run_case cutover_fresh cutover
grep -qx 'PRODUCTION_BACKUP_FRESHNESS=PASS' "$TMP/cutover_fresh.out"
grep -qx 'PRODUCTION_PREFLIGHT=PASS' "$TMP/cutover_fresh.out"
grep -qx 'PRODUCTION_PREFLIGHT_PROOF=PASS' "$TMP/cutover_fresh.out"
source "$ROOT/scripts/lib/production-preflight-proof.sh"
production_preflight_proof_validate "$PREFLIGHT_RESULT_FILE" "$EXPECTED_SHA" salesforce_pro \
  "$PRODUCTION_DB_CONTAINER_EXPECTED" "$PRODUCTION_DB_VOLUME_EXPECTED" 900

# F/G: contrato de modo falha fechado antes de consultar ambiente ou runtime.
if run_case missing_mode __unset; then exit 1; fi
grep -qx 'PRODUCTION_PREFLIGHT_FAILURE=invalid_preflight_mode' "$TMP/missing_mode.out"
if run_case invalid_mode preview; then exit 1; fi
grep -qx 'PRODUCTION_PREFLIGHT_FAILURE=invalid_preflight_mode' "$TMP/invalid_mode.out"

# H/I: o gate precede build/cutover e o próprio preflight não toca no runtime.
deploy=$(cat "$ROOT/scripts/deploy-production.sh")
preflight_line=$(grep -n 'PRODUCTION_PREFLIGHT_MODE="$MODE" bash "$APP_DIR/scripts/production-preflight.sh"' <<<"$deploy" | cut -d: -f1)
build_line=$(grep -n '"${COMPOSE\[@\]}" build api web' <<<"$deploy" | cut -d: -f1)
stop_line=$(grep -n 'docker stop "$container_id"' <<<"$deploy" | cut -d: -f1)
(( preflight_line < build_line && build_line < stop_line ))
if grep -Eq 'docker (stop|rm|compose .* (up|down|build))' "$COMMAND_LOG"; then exit 1; fi

# J: nem credenciais, query, nem paths dos artefatos aparecem em qualquer saída.
if grep -R -E 'sensitive-(user|password|query|backup-name)|postgresql://' "$TMP"/*.out; then exit 1; fi

printf 'production preflight mode safety smoke passed\n'
