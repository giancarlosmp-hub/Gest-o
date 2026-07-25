#!/usr/bin/env bash

set -Eeuo pipefail

readonly EXPECTED_CONFIRMATION='FORENSIC5050'
readonly SAFE_ROOT='/root/gest-o-safe'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly REPO_ROOT
readonly SOURCE_SQL="$REPO_ROOT/docs/investigations/evidence/erp-5050-read-only.sql"

if [[ "${CONFIRM:-}" != "$EXPECTED_CONFIRMATION" ]]; then
  printf 'ABORTADO: defina CONFIRM=%s para confirmar a coleta read-only.\n' "$EXPECTED_CONFIRMATION" >&2
  exit 1
fi

for command_name in psql git hostname date sha256sum wc jq cp chmod mkdir mktemp rm; do
  command -v "$command_name" >/dev/null
done

PSQL_TARGET=()
if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL_TARGET+=("$DATABASE_URL")
fi

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

# The connection target comes from DATABASE_URL or the standard libpq PG*
# environment variables; no credential is persisted in the evidence directory.
psql "${PSQL_TARGET[@]}" -X -v ON_ERROR_STOP=1 \
  -c 'BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout='"'"'60s'"'"'; SET LOCAL lock_timeout='"'"'5s'"'"'; SELECT current_database(), current_user; ROLLBACK;' \
  >"$PREFLIGHT_STDOUT" 2>"$PREFLIGHT_STDERR"

DATABASE_NAME="$(psql "${PSQL_TARGET[@]}" -X -v ON_ERROR_STOP=1 -At -c 'SELECT current_database()' 2>"$PREFLIGHT_STDERR")"
readonly DATABASE_NAME
DATABASE_USER="$(psql "${PSQL_TARGET[@]}" -X -v ON_ERROR_STOP=1 -At -c 'SELECT current_user' 2>"$PREFLIGHT_STDERR")"
readonly DATABASE_USER
[[ -n "$DATABASE_NAME" && -n "$DATABASE_USER" ]]

mkdir -m 700 -- "$EVIDENCE_DIR"
cp -- "$SOURCE_SQL" "$EVIDENCE_DIR/consultas.sql"
chmod 600 "$EVIDENCE_DIR/consultas.sql"

psql --version >"$EVIDENCE_DIR/psql-version.txt"
git -C "$REPO_ROOT" rev-parse HEAD >"$EVIDENCE_DIR/git-revision.txt"
hostname >"$EVIDENCE_DIR/hostname.txt"
date -u +%Y-%m-%dT%H:%M:%SZ >"$EVIDENCE_DIR/date.txt"
printf '%s\n' "$DATABASE_NAME" >"$EVIDENCE_DIR/database.txt"

# consultas.sql is an immutable copy of the versioned SQL and already contains
# BEGIN TRANSACTION READ ONLY, both LOCAL timeouts, and COMMIT.
psql "${PSQL_TARGET[@]}" -X -v ON_ERROR_STOP=1 -f "$EVIDENCE_DIR/consultas.sql" \
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
  --arg script "$SOURCE_SQL" \
  --arg sha256_sql "${SQL_SHA256%% *}" \
  --argjson linhas "$OUTPUT_LINES" \
  '{data: $data, commit: $commit, hostname: $hostname, banco: $banco,
    usuario: $usuario, script_utilizado: $script, sha256_sql: $sha256_sql,
    quantidade_linhas_produzidas: $linhas}' >"$EVIDENCE_DIR/manifest.json"

(
  cd -- "$EVIDENCE_DIR"
  sha256sum consultas.sql >consultas.sql.sha256
  sha256sum stdout.txt >stdout.txt.sha256
  sha256sum manifest.json >manifest.json.sha256
)
chmod 600 "$EVIDENCE_DIR"/*

printf 'LOCAL DAS EVIDÊNCIAS: %s\n' "$EVIDENCE_DIR"
printf 'SHA256:\n%s\n%s\n' "$SQL_SHA256" "$OUTPUT_SHA256"
cat "$EVIDENCE_DIR/manifest.json.sha256"
