#!/usr/bin/env bash
set -euo pipefail

name="gesto-preview-seed-${RANDOM}-$$"
network="${name}-net"
image="${API_IMAGE:-gest-o-preview-seed:local}"
tenant_id="tenant-default-v1"
db="gesto_preview_certification"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || :; docker network rm "$network" >/dev/null 2>&1 || :; }
trap cleanup EXIT
unset DATABASE_URL

if [[ -z "${API_IMAGE:-}" ]]; then
  docker build --build-arg APP_COMMIT="$(git rev-parse HEAD)" -t "$image" -f apps/api/Dockerfile . >/dev/null
fi
docker network create "$network" >/dev/null
docker run -d --name "$name" --network "$network" -e POSTGRES_PASSWORD=preview_ephemeral -e POSTGRES_DB="$db" postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$name" pg_isready -U postgres -d "$db" >/dev/null 2>&1 && break; sleep 1; done
docker exec "$name" pg_isready -U postgres -d "$db" >/dev/null
url="postgresql://postgres:preview_ephemeral@${name}:5432/${db}?schema=public"
run_api() { docker run --rm --network "$network" -e DATABASE_URL="$url" -e NODE_ENV=test -e DEPLOYMENT_ENV=preview -e ENABLE_PREVIEW_SEED=true -e DEFAULT_TENANT_ID="$tenant_id" --entrypoint sh "$image" -c "$1"; }

echo "checkpoint: schema"
run_api 'npx prisma db push --schema=apps/api/prisma/schema.prisma --skip-generate >/dev/null'
echo "checkpoint: seed"
run_api 'npm run seed:preview -w @salesforce-pro/api >/dev/null'
before="$(docker exec -i "$name" psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 -At <<'SQL'
SET search_path TO public;
SELECT (SELECT count(*) FROM "Tenant") || ':' || (SELECT count(*) FROM "TenantMembership") || ':' || (SELECT count(*) FROM "Client");
SQL
)"
echo "checkpoint: validate"
run_api 'npx tsx apps/api/prisma/validatePreviewTenantReadPilot.ts'
echo "checkpoint: reapply"
run_api 'npm run seed:preview -w @salesforce-pro/api >/dev/null'
after="$(docker exec -i "$name" psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 -At <<'SQL'
SET search_path TO public;
SELECT (SELECT count(*) FROM "Tenant") || ':' || (SELECT count(*) FROM "TenantMembership") || ':' || (SELECT count(*) FROM "Client");
SQL
)"
test "$before" = "$after"
docker exec -i "$name" psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 <<SQL >/dev/null
SET search_path TO public;
DO \$\$ BEGIN
 IF (SELECT count(*) FROM "Tenant" WHERE id = '$tenant_id' AND status = 'active') <> 1 THEN RAISE EXCEPTION 'tenant'; END IF;
 IF EXISTS (SELECT 1 FROM "Client" WHERE "tenantId" IS NULL OR "tenantId" <> '$tenant_id') THEN RAISE EXCEPTION 'client tenant'; END IF;
 IF EXISTS (SELECT 1 FROM "Client" c LEFT JOIN "TenantMembership" m ON m."userId"=c."ownerSellerId" AND m."tenantId"=c."tenantId" AND m.status='active' WHERE m.id IS NULL) THEN RAISE EXCEPTION 'ownership'; END IF;
END \$\$;
SQL
echo "TENANT_READ_PREVIEW_SEED=PASS"
echo "TENANT_READ_PREVIEW_DATASET=PASS"
echo "PASS: tenant read pilot preview seed PostgreSQL 16"
