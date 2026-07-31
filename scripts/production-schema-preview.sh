#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${PRODUCTION_DB_HOST_EXPECTED:?PRODUCTION_DB_HOST_EXPECTED is required}"
: "${APP_COMMIT:?APP_COMMIT is required}"
host=$(DATABASE_URL="$DATABASE_URL" node -e 'console.log(new URL(process.env.DATABASE_URL).hostname)')
[[ "$host" == "$PRODUCTION_DB_HOST_EXPECTED" ]] || { echo "ERRO: host não autorizado" >&2; exit 1; }
image="gest-o-api:${APP_COMMIT}"
docker image inspect "$image" >/dev/null 2>&1 || { echo "ERRO: imagem API pinada ausente: $image" >&2; exit 1; }
echo "-- Prisma da imagem $image; diagnóstico somente leitura; nenhuma alteração aplicada."
docker run --rm --network gest-o_default -e DATABASE_URL "$image" \
  ./node_modules/.bin/prisma migrate diff \
  --from-schema-datasource apps/api/prisma/schema.prisma \
  --to-schema-datamodel apps/api/prisma/schema.prisma \
  --script
