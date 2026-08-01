#!/usr/bin/env bash

set -Eeuo pipefail

readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
readonly RUNNER="$ROOT/scripts/production/run-erp-5050-forensic.sh"
readonly SQL="$ROOT/docs/investigations/evidence/erp-5050-read-only.sql"

[[ -x "$RUNNER" ]]
grep -Fxq 'set -Eeuo pipefail' "$RUNNER"

# These static checks and Docker mocks never contact a real database or Docker daemon.
if sed 's/^[[:space:]]*#.*$//' "$RUNNER" | grep -Eiq '(^|[[:space:];])(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)[[:space:]]'; then
  printf 'runner contains a database-writing command\n' >&2
  exit 1
fi
if sed 's/^[[:space:]]*--.*$//' "$SQL" | grep -Eiq '^[[:space:]]*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)[[:space:]]'; then
  printf 'versioned SQL contains a database-writing command\n' >&2
  exit 1
fi

grep -Fq 'CONNECTION_MODE:-docker-peer' "$RUNNER"
grep -Fq 'DB_CONTAINER:-gest-o-db-clean-v2-20260717' "$RUNNER"
grep -Fq "docker exec -i -u postgres" "$RUNNER"
grep -Fq 'docker exec -i -u postgres "$DB_CONTAINER" sh -c '\''command -v psql'\''' "$RUNNER"
if grep -Fq 'docker exec -i -u postgres "$DB_CONTAINER" command -v psql' "$RUNNER"; then
  printf 'runner validates container psql without a shell\n' >&2
  exit 1
fi
grep -Fq "POSTGRES_DB=" "$RUNNER"
grep -Fq "DB_NAME:-salesforce_pro" "$RUNNER"
grep -Fq "CONFIRM:-" "$RUNNER"
grep -Fq "FORENSIC5050" "$RUNNER"
grep -Eiq '^BEGIN( TRANSACTION)? READ ONLY;' "$SQL"
grep -Fq "SET LOCAL statement_timeout = '60s';" "$SQL"
grep -Fq "SET LOCAL lock_timeout = '5s';" "$SQL"
grep -Fq -- '<"$EVIDENCE_DIR/consultas.sql"' "$RUNNER"
if grep -Fq -- '-f "$EVIDENCE_DIR/consultas.sql"' "$RUNNER"; then
  printf 'runner exposes the host SQL path to psql\n' >&2
  exit 1
fi
for field in connectionMode dbContainer database databaseUser; do grep -Fq "$field" "$RUNNER"; done
for artifact in consultas.sql stdout.txt manifest.json; do
  grep -Fq "sha256sum $artifact >$artifact.sha256" "$RUNNER"
done
if grep -Eq '(^|[[:space:]])(tee|eval)([[:space:]]|$)' "$RUNNER"; then
  printf 'runner uses a forbidden command\n' >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat >"$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%q ' "$@" >>"$MOCK_LOG"; printf '\n' >>"$MOCK_LOG"
if [[ "$1" == inspect ]]; then
  [[ "${MOCK_EXISTS:-1}" == 1 ]] || exit 1
  if [[ "${2:-}" == --format ]]; then
    case "$3" in
      *State.Running*) printf '%s\n' "${MOCK_RUNNING:-true}" ;;
      *Config.Env*) [[ -z "${MOCK_POSTGRES_DB+x}" ]] || printf 'POSTGRES_DB=%s\n' "$MOCK_POSTGRES_DB" ;;
    esac
  fi
  exit 0
fi
[[ "$1" == exec ]]
shift
[[ "$1" == -i && "$2" == -u && "$3" == postgres ]]
shift 4
if [[ "$1" == sh && "$2" == -c && "$3" == 'command -v psql' ]]; then
  [[ "${MOCK_CONTAINER_PSQL:-1}" == 1 ]] || exit 1
  printf '/usr/bin/psql\n'
  exit 0
fi
[[ "$1" == psql && "$2" == -U && "$3" == postgres && "$4" == -d ]]
printf '%s\n' "$5" >"$MOCK_SELECTED_DB"
shift 5
if [[ " $* " == *' --version '* ]]; then printf 'psql (PostgreSQL) mock\n'; exit 0; fi
if [[ " $* " == *' SELECT current_database()'* ]]; then printf '%s\n' "$(<"$MOCK_SELECTED_DB")"; exit 0; fi
if [[ " $* " == *' SELECT current_user'* ]]; then printf 'postgres\n'; exit 0; fi
if [[ " $* " != *' -c '* ]]; then
  cat >"$MOCK_SQL_STDIN"
  printf 'mock forensic output\n'
  exit 0
fi
# Successful accessibility and READ ONLY preflight.
printf 'BEGIN\nSET\npostgres\nROLLBACK\n'
MOCK
chmod +x "$TMP/bin/docker"

# An isolated host PATH proves docker-peer does not discover or execute a host
# psql. Only the documented common dependencies and the Docker mock are exposed.
mkdir -p "$TMP/host-without-psql" "$TMP/host-without-docker"
for command_name in bash env git hostname date sha256sum wc jq cp chmod mkdir mktemp rm cat node; do
  command_path="$(command -v "$command_name")"
  ln -s "$command_path" "$TMP/host-without-psql/$command_name"
  ln -s "$command_path" "$TMP/host-without-docker/$command_name"
done
ln -s "$TMP/bin/docker" "$TMP/host-without-psql/docker"
if PATH="$TMP/host-without-psql" command -v psql >/dev/null 2>&1; then
  printf 'isolated test PATH unexpectedly contains psql\n' >&2
  exit 1
fi

run_success() {
  local case_dir="$TMP/$1"
  shift
  mkdir -p "$case_dir/safe"
  : >"$case_dir/docker.log"
  if ! env PATH="$TMP/bin:${RUNNER_HOST_PATH:-$PATH}" SAFE_ROOT="$case_dir/safe" MOCK_LOG="$case_dir/docker.log" \
    MOCK_SELECTED_DB="$case_dir/database" MOCK_SQL_STDIN="$case_dir/sql-stdin" \
    CONFIRM=FORENSIC5050 DATABASE_URL='postgresql://secret:never-log@db/prod' \
    "$@" "$RUNNER" >"$case_dir/terminal.out" 2>"$case_dir/terminal.err"; then
    printf 'mocked docker-peer run failed:\n' >&2
    cat "$case_dir/terminal.err" >&2
    return 1
  fi
  local evidence
  evidence="$(find "$case_dir/safe" -mindepth 1 -maxdepth 1 -type d)"
  [[ -n "$evidence" ]]
  grep -Fq '"connectionMode": "docker-peer"' "$evidence/manifest.json"
  grep -Fq '"databaseUser": "postgres"' "$evidence/manifest.json"
  cmp "$SQL" "$case_dir/sql-stdin"
  cmp "$evidence/consultas.sql" "$case_dir/sql-stdin"
  grep -Fxq 'mock forensic output' "$evidence/stdout.txt"
  [[ ! -s "$evidence/stderr.txt" ]]
  ! find "$case_dir" -type f -exec grep -Fq 'secret:never-log' {} \;
  grep -Fq 'exec -i -u postgres' "$case_dir/docker.log"
}

RUNNER_HOST_PATH="$TMP/host-without-psql" run_success explicit env DB_CONTAINER=custom-db DB_NAME=operator_db MOCK_POSTGRES_DB=container_db
[[ "$(<"$TMP/explicit/database")" == operator_db ]]
grep -Fq '"dbContainer": "custom-db"' "$(find "$TMP/explicit/safe" -mindepth 1 -maxdepth 1 -type d)/manifest.json"
grep -Fq 'exec -i -u postgres custom-db sh -c command\ -v\ psql' "$TMP/explicit/docker.log"
# A successful validation reaches the subsequent database preflight.
grep -Fq 'exec -i -u postgres custom-db psql -U postgres -d operator_db -X' "$TMP/explicit/docker.log"

run_success container env MOCK_POSTGRES_DB=container_db
[[ "$(<"$TMP/container/database")" == container_db ]]

run_success fallback env -u MOCK_POSTGRES_DB
[[ "$(<"$TMP/fallback/database")" == salesforce_pro ]]

mkdir -p "$TMP/container-without-psql/safe"
: >"$TMP/container-without-psql/docker.log"
set +e
PATH="$TMP/host-without-psql" SAFE_ROOT="$TMP/container-without-psql/safe" \
  MOCK_LOG="$TMP/container-without-psql/docker.log" MOCK_CONTAINER_PSQL=0 \
  CONFIRM=FORENSIC5050 DB_CONTAINER=no-psql-db "$RUNNER" \
  >"$TMP/container-without-psql/out" 2>"$TMP/container-without-psql/err"
container_psql_status=$?
set -e
[[ "$container_psql_status" == 127 ]]
grep -Fxq 'ABORTADO: psql não encontrado no container PostgreSQL: no-psql-db' "$TMP/container-without-psql/err"
[[ -z "$(find "$TMP/container-without-psql/safe" -mindepth 1 -print -quit)" ]]
# Validation stops before any psql query is attempted.
[[ "$(grep -Fc 'exec -i -u postgres' "$TMP/container-without-psql/docker.log")" == 1 ]]

mkdir -p "$TMP/libpq-without-psql/safe"
set +e
PATH="$TMP/host-without-psql" SAFE_ROOT="$TMP/libpq-without-psql/safe" \
  CONFIRM=FORENSIC5050 CONNECTION_MODE=libpq "$RUNNER" \
  >"$TMP/libpq-without-psql/out" 2>"$TMP/libpq-without-psql/err"
libpq_status=$?
set -e
[[ "$libpq_status" == 127 ]]
grep -Fxq 'ABORTADO: psql é obrigatório no host quando CONNECTION_MODE=libpq' "$TMP/libpq-without-psql/err"
[[ -z "$(find "$TMP/libpq-without-psql/safe" -mindepth 1 -print -quit)" ]]

mkdir -p "$TMP/host-without-docker-safe"
set +e
PATH="$TMP/host-without-docker" SAFE_ROOT="$TMP/host-without-docker-safe" \
  CONFIRM=FORENSIC5050 "$RUNNER" \
  >"$TMP/host-without-docker.out" 2>"$TMP/host-without-docker.err"
docker_status=$?
set -e
[[ "$docker_status" == 127 ]]
grep -Fxq 'ABORTADO: comando obrigatório no host não encontrado: docker' "$TMP/host-without-docker.err"
[[ -z "$(find "$TMP/host-without-docker-safe" -mindepth 1 -print -quit)" ]]

for state in missing stopped; do
  mkdir -p "$TMP/$state/safe"
  : >"$TMP/$state/docker.log"
  extra=(MOCK_EXISTS=1 MOCK_RUNNING=true)
  [[ "$state" == missing ]] && extra=(MOCK_EXISTS=0)
  [[ "$state" == stopped ]] && extra=(MOCK_EXISTS=1 MOCK_RUNNING=false)
  if env PATH="$TMP/bin:$PATH" SAFE_ROOT="$TMP/$state/safe" MOCK_LOG="$TMP/$state/docker.log" \
    MOCK_SELECTED_DB="$TMP/$state/database" CONFIRM=FORENSIC5050 "${extra[@]}" "$RUNNER" \
    >"$TMP/$state/out" 2>"$TMP/$state/err"; then
    printf 'runner accepted %s container\n' "$state" >&2
    exit 1
  fi
  [[ -z "$(find "$TMP/$state/safe" -mindepth 1 -print -quit)" ]]
done

printf 'static and mocked forensic runner checks passed\n'
