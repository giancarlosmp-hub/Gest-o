#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/apps/gest-o}"
ENV_FILE="${PRODUCTION_ENV_FILE:-/root/demetra-env/.env}"
CONTAINER_REQUIRED=gest-o-db-clean-v2-20260717
log(){ printf '[orders-tenant-preview] %s\n' "$*"; }
die(){ log "ERRO: $*" >&2; exit 1; }

[[ "${PRODUCTION_DB_CONTAINER_EXPECTED:-}" == "$CONTAINER_REQUIRED" ]] || die "container produtivo não autorizado"
[[ -f "$ENV_FILE" ]] || die "arquivo seguro de ambiente ausente"
cd "$APP_DIR"
set -a; source "$ENV_FILE"; set +a
db_name=$(DATABASE_URL="$DATABASE_URL" node -e 'process.stdout.write(new URL(process.env.DATABASE_URL).pathname.replace(/^\//,""))')
[[ "$db_name" == salesforce_pro ]] || die "database não autorizado"
[[ -f scripts/sql/orders-tenant-authority-diagnostic.sql ]] || die "diagnóstico versionado ausente"

log 'iniciando diagnóstico agregado em transação read-only'
docker exec --user postgres -i "$PRODUCTION_DB_CONTAINER_EXPECTED" \
  psql --dbname="$db_name" -X -v ON_ERROR_STOP=1 -AtF $'\t' \
  < scripts/sql/orders-tenant-authority-diagnostic.sql
log 'diagnóstico agregado concluído; nenhuma escrita executada'
