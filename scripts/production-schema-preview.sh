#!/usr/bin/env bash
set -euo pipefail
log(){ printf '[production-schema-preview] %s\n' "$*"; }
die(){ log "ERRO: $*" >&2; exit "${2:-1}"; }
MODE="${MODE:-preview}"
SQL_FILE="${SQL_FILE:-}"
tmp=""; trap '[[ -z "$tmp" ]] || rm -f "$tmp"' EXIT

if [[ -n "$SQL_FILE" ]]; then
  [[ -f "$SQL_FILE" ]] || die "SQL_FILE ausente: $SQL_FILE"
  sql="$SQL_FILE"
else
  : "${DATABASE_URL:?DATABASE_URL is required}"
  : "${PRODUCTION_DB_HOST_EXPECTED:?PRODUCTION_DB_HOST_EXPECTED is required}"
  : "${APP_COMMIT:?APP_COMMIT is required}"
  host=$(DATABASE_URL="$DATABASE_URL" node -e 'console.log(new URL(process.env.DATABASE_URL).hostname)')
  [[ "$host" == "$PRODUCTION_DB_HOST_EXPECTED" ]] || die "host não autorizado"
  image="gest-o-api:${APP_COMMIT}"
  docker image inspect "$image" >/dev/null 2>&1 || die "imagem API pinada ausente: $image"
  tmp=$(mktemp); sql="$tmp"
  log "Prisma pinado em $image; diff somente leitura; nenhuma alteração aplicada"
  docker run --rm --network gest-o_default -e DATABASE_URL "$image" \
    ./node_modules/.bin/prisma migrate diff \
    --from-schema-datasource apps/api/prisma/schema.prisma \
    --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$sql"
fi

cat "$sql"
# Comments are removed by a lexer that respects strings, quoted identifiers and dollar-quoted
# bodies; SQL it cannot read the way PostgreSQL does is blocked instead of checked.
strip_comments="$(dirname "${BASH_SOURCE[0]}")/sql-strip-comments.mjs"
normalized=$(node "$strip_comments" "$sql") || { log "BLOQUEADO: SQL não pôde ser lido com segurança"; exit 42; }
without_identifiers=$(node "$strip_comments" "$sql" --blank-identifiers)
# The only accepted ALTER TYPE is one exact enum addition per line; every other ALTER TYPE
# (RENAME, DROP, ADD VALUE without IF NOT EXISTS, anything else) stays blocked below.
enum_add_line="^[[:space:]]*ALTER TYPE \"[A-Za-z][A-Za-z0-9_]*\" ADD VALUE IF NOT EXISTS '[a-z][a-z0-9_]*';[[:space:]]*\$"
# Each check runs line by line and again on every statement collapsed onto one line, so keywords
# split across lines (DROP / TABLE) are still seen; each count is the larger of the two.
statements(){ printf '%s\n' "$1" | tr '\n\r\t' '   ' | sed -E 's/[[:space:]]+/ /g; s/;/;\n/g'; }
count(){
  local lines stmts
  lines=$(printf '%s\n' "$2" | grep -Eic "$1" || true)
  stmts=$(printf '%s\n' "$3" | grep -Eic "$1" || true)
  printf '%d' $(( lines > stmts ? lines : stmts ))
}
normalized_statements=$(statements "$normalized")
checked=$(printf '%s\n' "$normalized" | grep -Ev "$enum_add_line" || true)
checked_statements=$(printf '%s\n' "$normalized_statements" | grep -Ev "$enum_add_line" || true)
additive=$(count "^[[:space:]]*(CREATE (TYPE|TABLE|UNIQUE INDEX|INDEX)|ALTER TABLE .*ADD (COLUMN|CONSTRAINT))|$enum_add_line" "$normalized" "$normalized_statements")
destructive=$(count 'DROP[[:space:]]+(TABLE|COLUMN|TYPE)|TRUNCATE|DROP[^;]*CASCADE|ALTER[[:space:]]+(TABLE|TYPE)[^;]*(TYPE|DROP VALUE|RENAME VALUE)|^[[:space:]]*ALTER[[:space:]]+TYPE' "$checked" "$checked_statements")
incident=$(printf '%s\n' "$normalized" | grep -Eic 'incident_[0-9]+' || true)
blocked=0

if (( destructive > 0 )); then
  blocked=$destructive
  log "BLOQUEADO: SQL destrutivo/incompatível detectado"
fi
if grep -Eiq 'DROP[[:space:]]+(TABLE|COLUMN)[^;]*incident_' "$sql"; then
  log "BLOQUEADO: tentativa de alterar objeto incident_* não gerenciado"
  blocked=$((blocked + 1))
fi
# DML is checked on the comment-free SQL text, case-insensitively, as whole words. Quoted
# identifiers ("updatedAt") are not statements and ON DELETE/ON UPDATE are foreign key actions;
# everything else, string and dollar-quoted bodies included, is checked.
fk_actions(){ sed -E 's/(^|[^A-Za-z0-9_$])ON[[:space:]]+(DELETE|UPDATE)/\1ON_FK_ACTION/gI'; }
dml_scan=$(printf '%s\n' "$without_identifiers" | fk_actions)
dml_statements=$(statements "$without_identifiers" | fk_actions)
dml=$(count '(^|[^A-Za-z0-9_$])((UPDATE|DELETE|INSERT|MERGE|COPY|TRUNCATE)|CREATE[[:space:]]+OR[[:space:]]+REPLACE)([^A-Za-z0-9_$]|$)' "$dml_scan" "$dml_statements")
# Migrations already approved with a data backfill. Each exemption is bound to the manifest id,
# its sha256 and its backfill token; any other content, even under the same id, stays blocked.
approved_dml_migrations=(
  "20260904120000_orders_operational_view:486c25d46702a8f91131fa6669b12e9119a62b098aed6c3a091fff4cdca892b9:orders-tenant-authority-v1"
)
approved_dml_id(){
  local entry id sha token actual manifest
  actual=$(sha256sum "$SQL_FILE" | cut -d' ' -f1)
  for entry in "${approved_dml_migrations[@]}"; do
    IFS=: read -r id sha token <<<"$entry"
    [[ "$actual" == "$sha" && "${ALLOW_DATA_BACKFILL:-}" == "$token" ]] || continue
    manifest=$(node "$(dirname "${BASH_SOURCE[0]}")/production-schema-migrations.mjs" "$id" 2>/dev/null) || continue
    [[ $(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha256)' "$manifest") == "$sha" ]] || continue
    printf '%s' "$id"; return 0
  done
  return 1
}
if [[ -n "$SQL_FILE" ]] && (( dml > 0 )); then
  if dml_id=$(approved_dml_id); then
    log "DML aprovado: $dml_id (id e sha256 conferidos no manifesto)"
  else
    log "BLOQUEADO: arquivo aprovado deve conter somente DDL aditiva"
    blocked=$((blocked + 1))
  fi
fi
printf 'RESUMO aditivas=%d destrutivas=%d bloqueadas=%d nao_gerenciadas=%d\n' "$additive" "$destructive" "$blocked" "$incident"
[[ "$MODE" != validate || "$blocked" -eq 0 ]] || exit 42
