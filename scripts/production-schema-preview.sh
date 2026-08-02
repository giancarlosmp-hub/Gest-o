#!/usr/bin/env bash
set -euo pipefail
log(){ printf '[production-schema-preview] %s\n' "$*"; }
die(){ log "ERRO: $*" >&2; exit "${2:-1}"; }
MODE="${MODE:-preview}"
SQL_FILE="${SQL_FILE:-}"
tmp=""; trap '[[ -z "$tmp" ]] || rm -f "$tmp"' EXIT

if [[ -n "${MIGRATION_ID:-}" ]]; then
  registry_line=$(node scripts/production-schema-migrations.mjs "$MIGRATION_ID") || exit 42
  IFS=$'\t' read -r _ SQL_FILE _ _ _ <<<"$registry_line"
fi
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
  [[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$APP_COMMIT" ]] || die "label OCI divergente"
  tmp=$(mktemp); sql="$tmp"
  log "Prisma pinado em $image; diff somente leitura; nenhuma alteração aplicada"
  docker run --rm --pull=never --network gest-o_default -e DATABASE_URL "$image" \
    ./node_modules/.bin/prisma migrate diff \
    --from-schema-datasource apps/api/prisma/schema.prisma \
    --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$sql"
fi

[[ -z "${RAW_DIFF_OUTPUT:-}" ]] || { [[ ! -e "$RAW_DIFF_OUTPUT" ]] || die "evidência raw já existe"; install -m 600 "$sql" "$RAW_DIFF_OUTPUT"; }
cat "$sql"
normalized=$(sed -E 's/--.*$//' "$sql")
additive=$(printf '%s\n' "$normalized" | grep -Eic '^[[:space:]]*(CREATE (TYPE|TABLE|UNIQUE INDEX|INDEX)|ALTER TABLE .*ADD (COLUMN|CONSTRAINT))' || true)
destructive=$(printf '%s\n' "$normalized" | grep -Eic 'DROP[[:space:]]+(TABLE|COLUMN|TYPE)|TRUNCATE|DROP[^;]*CASCADE|ALTER[[:space:]]+(TABLE|TYPE)[^;]*(TYPE|DROP VALUE|RENAME VALUE)' || true)
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
if [[ -n "$SQL_FILE" ]] && grep -Eiq '^[[:space:]]*(UPDATE|DELETE|INSERT|MERGE|COPY|CREATE[[:space:]]+OR[[:space:]]+REPLACE)' "$normalized"; then
  log "BLOQUEADO: arquivo aprovado deve conter somente DDL aditiva"
  blocked=$((blocked + 1))
fi
printf 'RESUMO aditivas=%d destrutivas=%d bloqueadas=%d nao_gerenciadas=%d\n' "$additive" "$destructive" "$blocked" "$incident"
[[ "$MODE" != validate || "$blocked" -eq 0 ]] || exit 42
