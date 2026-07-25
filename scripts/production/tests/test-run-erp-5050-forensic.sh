#!/usr/bin/env bash

set -Eeuo pipefail

readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
readonly RUNNER="$ROOT/scripts/production/run-erp-5050-forensic.sh"
readonly SQL="$ROOT/docs/investigations/evidence/erp-5050-read-only.sql"

[[ -x "$RUNNER" ]]

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
grep -Fq "POSTGRES_DB=" "$RUNNER"
grep -Fq "DB_NAME:-salesforce_pro" "$RUNNER"
grep -Fq "CONFIRM:-" "$RUNNER"
grep -Fq "FORENSIC5050" "$RUNNER"
grep -Eiq '^BEGIN( TRANSACTION)? READ ONLY;' "$SQL"
grep -Fq "SET LOCAL statement_timeout = '60s';" "$SQL"
grep -Fq "SET LOCAL lock_timeout = '5s';" "$SQL"
grep -Fq -- '-f "$EVIDENCE_DIR/consultas.sql"' "$RUNNER"
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
if [[ "$1" == command && "$2" == -v && "$3" == psql ]]; then printf '/usr/bin/psql\n'; exit 0; fi
[[ "$1" == psql && "$2" == -U && "$3" == postgres && "$4" == -d ]]
printf '%s\n' "$5" >"$MOCK_SELECTED_DB"
shift 5
if [[ " $* " == *' --version '* ]]; then printf 'psql (PostgreSQL) mock\n'; exit 0; fi
if [[ " $* " == *' SELECT current_database()'* ]]; then printf '%s\n' "$(<"$MOCK_SELECTED_DB")"; exit 0; fi
if [[ " $* " == *' SELECT current_user'* ]]; then printf 'postgres\n'; exit 0; fi
if [[ " $* " == *' -f '* ]]; then printf 'mock forensic output\n'; exit 0; fi
# Successful accessibility and READ ONLY preflight.
printf 'BEGIN\nSET\npostgres\nROLLBACK\n'
MOCK
chmod +x "$TMP/bin/docker"

run_success() {
  local case_dir="$TMP/$1"
  shift
  mkdir -p "$case_dir/safe"
  : >"$case_dir/docker.log"
  env PATH="$TMP/bin:$PATH" SAFE_ROOT="$case_dir/safe" MOCK_LOG="$case_dir/docker.log" \
    MOCK_SELECTED_DB="$case_dir/database" CONFIRM=FORENSIC5050 DATABASE_URL='postgresql://secret:never-log@db/prod' \
    "$@" "$RUNNER" >"$case_dir/terminal.out" 2>"$case_dir/terminal.err"
  local evidence
  evidence="$(find "$case_dir/safe" -mindepth 1 -maxdepth 1 -type d)"
  [[ -n "$evidence" ]]
  grep -Fq '"connectionMode": "docker-peer"' "$evidence/manifest.json"
  grep -Fq '"databaseUser": "postgres"' "$evidence/manifest.json"
  ! find "$case_dir" -type f -exec grep -Fq 'secret:never-log' {} \;
  grep -Fq 'exec -i -u postgres' "$case_dir/docker.log"
}

run_success explicit env DB_CONTAINER=custom-db DB_NAME=operator_db MOCK_POSTGRES_DB=container_db
[[ "$(<"$TMP/explicit/database")" == operator_db ]]
grep -Fq '"dbContainer": "custom-db"' "$(find "$TMP/explicit/safe" -mindepth 1 -maxdepth 1 -type d)/manifest.json"

run_success container env MOCK_POSTGRES_DB=container_db
[[ "$(<"$TMP/container/database")" == container_db ]]

run_success fallback env -u MOCK_POSTGRES_DB
[[ "$(<"$TMP/fallback/database")" == salesforce_pro ]]

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
