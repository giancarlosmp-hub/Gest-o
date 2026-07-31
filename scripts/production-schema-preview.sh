#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${PRODUCTION_DB_HOST_EXPECTED:?PRODUCTION_DB_HOST_EXPECTED is required}"
host=$(DATABASE_URL="$DATABASE_URL" node -e 'console.log(new URL(process.env.DATABASE_URL).hostname)')
[[ "$host" == "$PRODUCTION_DB_HOST_EXPECTED" ]] || { echo "ERRO: host não autorizado" >&2; exit 1; }
echo "Diagnóstico SQL somente; nenhuma alteração será aplicada."
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel apps/api/prisma/schema.prisma --script
