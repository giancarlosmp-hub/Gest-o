#!/usr/bin/env bash

set -Eeuo pipefail

readonly EXPECTED_CONFIRMATION='FORENSIC5050'
readonly SAFE_ROOT="${SAFE_ROOT:-/root/gest-o-safe}"
readonly CONNECTION_MODE="${CONNECTION_MODE:-docker-peer}"
readonly DB_CONTAINER="${DB_CONTAINER:-gest-o-db-clean-v2-20260717}"
SCRIPT_DIR="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd -P)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly REPO_ROOT
readonly SOURCE_SQL="$REPO_ROOT/docs/investigations/evidence/erp-5050-read-only.sql"

if [[ "${CONFIRM:-}" != "$EXPECTED_CONFIRMATION" ]]; then
  printf 'ABORTADO: defina CONFIRM=%s para confirmar a coleta read-only.\n' "$EXPECTED_CONFIRMATION" >&2
  exit 1
fi

require_host_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'ABORTADO: comando obrigatório no host não encontrado: %s\n' "$command_name" >&2
    exit 127
  fi
}

for command_name in git hostname date sha256sum wc jq cp chmod mkdir mktemp rm; do
  require_host_command "$command_name"
done

PSQL_TARGET=()
case "$CONNECTION_MODE" in
  docker-peer)
    require_host_command docker
    docker inspect "$DB_CONTAINER" >/dev/null
    [[ "$(docker inspect --format '{{.State.Running}}' "$DB_CONTAINER")" == 'true' ]]
    if ! docker exec -i -u postgres "$DB_CONTAINER" sh -c 'command -v psql' >/dev/null; then
      printf 'ABORTADO: psql não encontrado no container PostgreSQL: %s\n' "$DB_CONTAINER" >&2
      exit 127
    fi
    CONTAINER_DB_NAME=''
    while IFS= read -r container_env; do
      if [[ "$container_env" == POSTGRES_DB=* ]]; then
        CONTAINER_DB_NAME="${container_env#POSTGRES_DB=}"
        break
      fi
    done < <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CONTAINER")
    DB_NAME="${DB_NAME:-$CONTAINER_DB_NAME}"
    DB_NAME="${DB_NAME:-salesforce_pro}"
    PSQL_TARGET=(docker exec -i -u postgres "$DB_CONTAINER" psql -U postgres -d "$DB_NAME")
    ;;
  libpq)
    if ! command -v psql >/dev/null 2>&1; then
      printf 'ABORTADO: psql é obrigatório no host quando CONNECTION_MODE=libpq\n' >&2
      exit 127
    fi
    DB_NAME="${DB_NAME:-${PGDATABASE:-}}"
    PSQL_TARGET=(psql)
    if [[ -n "${DATABASE_URL:-}" ]]; then
      PSQL_TARGET+=("$DATABASE_URL")
    fi
    ;;
  *)
    printf 'ABORTADO: CONNECTION_MODE deve ser docker-peer ou libpq.\n' >&2
    exit 1
    ;;
esac
readonly DB_NAME

[[ -f "$SOURCE_SQL" && -r "$SOURCE_SQL" ]]
[[ -d "$SAFE_ROOT" && -w "$SAFE_ROOT" ]]

RUN_TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
readonly RUN_TIMESTAMP
readonly EVIDENCE_DIR="$SAFE_ROOT/$RUN_TIMESTAMP-forensic-erp5050"
PREFLIGHT_STDOUT="$(mktemp)"
readonly PREFLIGHT_STDOUT
PREFLIGHT_STDERR="$(mktemp)"
readonly PREFLIGHT_STDERR
cleanup() {
  rm -f -- "$PREFLIGHT_STDOUT" "$PREFLIGHT_STDERR"
}
trap cleanup EXIT

# The default target uses local peer authentication inside the recovered database
# container. libpq is opt-in; credentials are never persisted as evidence.
"${PSQL_TARGET[@]}" -X -v ON_ERROR_STOP=1 \
  -c 'BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout='"'"'60s'"'"'; SET LOCAL lock_timeout='"'"'5s'"'"'; SELECT current_database(), current_user; ROLLBACK;' \
  >"$PREFLIGHT_STDOUT" 2>"$PREFLIGHT_STDERR"

DATABASE_NAME="$("${PSQL_TARGET[@]}" -X -v ON_ERROR_STOP=1 -At -c 'SELECT current_database()' 2>"$PREFLIGHT_STDERR")"
readonly DATABASE_NAME
DATABASE_USER="$("${PSQL_TARGET[@]}" -X -v ON_ERROR_STOP=1 -At -c 'SELECT current_user' 2>"$PREFLIGHT_STDERR")"
readonly DATABASE_USER
[[ -n "$DATABASE_NAME" && -n "$DATABASE_USER" ]]

mkdir -m 700 -- "$EVIDENCE_DIR"
cp -- "$SOURCE_SQL" "$EVIDENCE_DIR/consultas.sql"
chmod 600 "$EVIDENCE_DIR/consultas.sql"

"${PSQL_TARGET[@]}" --version >"$EVIDENCE_DIR/psql-version.txt"
git -C "$REPO_ROOT" rev-parse HEAD >"$EVIDENCE_DIR/git-revision.txt"
hostname >"$EVIDENCE_DIR/hostname.txt"
date -u +%Y-%m-%dT%H:%M:%SZ >"$EVIDENCE_DIR/date.txt"
printf '%s\n' "$DATABASE_NAME" >"$EVIDENCE_DIR/database.txt"

# consultas.sql is an immutable copy of the versioned SQL and already contains
# BEGIN TRANSACTION READ ONLY, both LOCAL timeouts, and COMMIT.
"${PSQL_TARGET[@]}" -X -v ON_ERROR_STOP=1 <"$EVIDENCE_DIR/consultas.sql" \
  >"$EVIDENCE_DIR/stdout.txt" 2>"$EVIDENCE_DIR/stderr.txt"

SQL_SHA256="$(sha256sum "$EVIDENCE_DIR/consultas.sql")"
readonly SQL_SHA256
OUTPUT_SHA256="$(sha256sum "$EVIDENCE_DIR/stdout.txt")"
readonly OUTPUT_SHA256
OUTPUT_LINES="$(wc -l <"$EVIDENCE_DIR/stdout.txt")"
readonly OUTPUT_LINES
readonly GIT_REVISION="$(<"$EVIDENCE_DIR/git-revision.txt")"
readonly HOST_NAME="$(<"$EVIDENCE_DIR/hostname.txt")"
readonly COLLECTED_AT="$(<"$EVIDENCE_DIR/date.txt")"

jq -n \
  --arg data "$COLLECTED_AT" \
  --arg commit "$GIT_REVISION" \
  --arg hostname "$HOST_NAME" \
  --arg banco "$DATABASE_NAME" \
  --arg usuario "$DATABASE_USER" \
  --arg connection_mode "$CONNECTION_MODE" \
  --arg db_container "$([[ "$CONNECTION_MODE" == docker-peer ]] && printf '%s' "$DB_CONTAINER")" \
  --arg script "$SOURCE_SQL" \
  --arg sha256_sql "${SQL_SHA256%% *}" \
  --argjson linhas "$OUTPUT_LINES" \
  '{data: $data, commit: $commit, hostname: $hostname, banco: $banco,
    usuario: $usuario, script_utilizado: $script, sha256_sql: $sha256_sql,
    quantidade_linhas_produzidas: $linhas, connectionMode: $connection_mode,
    dbContainer: $db_container, database: $banco, databaseUser: $usuario}' >"$EVIDENCE_DIR/manifest.json"

(
  cd -- "$EVIDENCE_DIR"
  sha256sum consultas.sql >consultas.sql.sha256
  sha256sum stdout.txt >stdout.txt.sha256
  sha256sum manifest.json >manifest.json.sha256
)
chmod 600 "$EVIDENCE_DIR"/*

printf 'LOCAL DAS EVIDÊNCIAS: %s\n' "$EVIDENCE_DIR"
printf 'SHA256:\n%s\n%s\n' "$SQL_SHA256" "$OUTPUT_SHA256"
printf '%s\n' "$(<"$EVIDENCE_DIR/manifest.json.sha256")"
