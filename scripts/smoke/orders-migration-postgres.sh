#!/usr/bin/env bash
set -eEuo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
sha=$(git rev-parse HEAD); image=${API_IMAGE:-gest-o-api:$sha}
docker image inspect "$image" >/dev/null 2>&1 || { echo 'required pinned API tooling image unavailable' >&2; exit 1; }
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image") == "$sha" ]] || { echo 'API tooling image SHA mismatch' >&2; exit 1; }
[[ -z ${DATABASE_URL:-} && -z ${TEST_DATABASE_URL:-} ]] || { echo 'refusing inherited database URL' >&2; exit 1; }
id="$$-$RANDOM"; pg="gesto-orders-pg-$id"; net="gesto-orders-net-$id"; tmp=$(mktemp -d)
cleanup(){ docker rm -f "$pg" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
docker network create --internal "$net" >/dev/null
docker run -d --rm --pull=never --name "$pg" --network "$net" -e POSTGRES_PASSWORD=test postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$pg" pg_isready -U postgres >/dev/null
for db in fresh upgrade invalid; do docker exec "$pg" createdb -U postgres "$db"; done
url(){ printf 'postgresql://postgres:test@%s:5432/%s?schema=public' "$pg" "$1"; }
run_tooling(){ local db=$1; shift; docker run --rm --pull=never --network "$net" -v "$tmp:/work" -w /app -e DATABASE_URL="$(url "$db")" "$image" "$@"; }

intro=$(git log --all --format=%H --diff-filter=A -- apps/api/prisma/migrations/20260904120000_orders_operational_view/migration.sql)
[[ -n "$intro" && "$intro" != *$'\n'* ]]
git show "${intro}^:apps/api/prisma/schema.prisma" >"$tmp/previous.prisma"
mkdir -p "$tmp/previous/migrations"
cp "$tmp/previous.prisma" "$tmp/previous/schema.prisma"
find apps/api/prisma/migrations -mindepth 1 -maxdepth 1 -type d ! -name 20260904120000_orders_operational_view -print0 | while IFS= read -r -d '' migration; do cp -R "$migration" "$tmp/previous/migrations/"; done

echo 'ORDERS_MIGRATION_STEP=fresh_sequence'
run_tooling fresh ./node_modules/.bin/prisma db push --schema /app/apps/api/prisma/schema.prisma --skip-generate >/dev/null
run_tooling fresh ./node_modules/.bin/prisma migrate diff --from-url "$(url fresh)" --to-schema-datamodel /app/apps/api/prisma/schema.prisma --exit-code >"$tmp/fresh.diff"
[[ ! -s "$tmp/fresh.diff" ]]

for db in upgrade invalid; do run_tooling "$db" ./node_modules/.bin/prisma db push --schema /work/previous/schema.prisma --skip-generate >/dev/null; done
fixture_sql='INSERT INTO "Tenant" (id,slug,"legalName","displayName",status,"createdAt","updatedAt") VALUES ('"'"'tenant-a'"'"','"'"'tenant-a'"'"','"'"'Synthetic A'"'"','"'"'Synthetic A'"'"','"'"'active'"'"',now(),now()),('"'"'tenant-b'"'"','"'"'tenant-b'"'"','"'"'Synthetic B'"'"','"'"'Synthetic B'"'"','"'"'active'"'"',now(),now());
INSERT INTO "User" (id,name,email,"passwordHash",role,"isActive","createdAt") VALUES ('"'"'seller-a'"'"','"'"'Synthetic A'"'"','"'"'a@example.invalid'"'"','"'"'x'"'"','"'"'vendedor'"'"',true,now()),('"'"'seller-b'"'"','"'"'Synthetic B'"'"','"'"'b@example.invalid'"'"','"'"'x'"'"','"'"'vendedor'"'"',true,now());
INSERT INTO "Client" (id,"tenantId",name,city,state,region,"ownerSellerId","createdAt") VALUES ('"'"'client-a'"'"','"'"'tenant-a'"'"','"'"'Synthetic A'"'"','"'"'City'"'"','"'"'ST'"'"','"'"'Region'"'"','"'"'seller-a'"'"',now()),('"'"'client-b'"'"','"'"'tenant-b'"'"','"'"'Synthetic B'"'"','"'"'City'"'"','"'"'ST'"'"','"'"'Region'"'"','"'"'seller-b'"'"',now());
INSERT INTO "Opportunity" (id,title,value,stage,"proposalDate","followUpDate","expectedCloseDate","clientId","ownerSellerId","createdAt") VALUES ('"'"'opp-a'"'"','"'"'Synthetic'"'"',1,'"'"'ganho'"'"',now(),now(),now(),'"'"'client-a'"'"','"'"'seller-a'"'"',now()),('"'"'opp-b'"'"','"'"'Synthetic'"'"',1,'"'"'ganho'"'"',now(),now(),now(),'"'"'client-b'"'"','"'"'seller-b'"'"',now());
INSERT INTO "ErpOrderSync" (id,"opportunityId","sellerId","pedidoIdImportacao",status,"payloadSent","createdAt","updatedAt") VALUES ('"'"'order-sent'"'"','"'"'opp-a'"'"','"'"'seller-a'"'"','"'"'import-sent'"'"','"'"'sent'"'"','"'"'{}'"'"',now(),now()),('"'"'order-pending'"'"','"'"'opp-b'"'"','"'"'seller-b'"'"','"'"'import-pending'"'"','"'"'pending'"'"','"'"'{}'"'"',now(),now()),('"'"'order-error'"'"','"'"'opp-a'"'"','"'"'seller-a'"'"','"'"'import-error'"'"','"'"'error'"'"','"'"'{}'"'"',now(),now());'
printf '%s\n' "$fixture_sql" | docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d upgrade >/dev/null

echo 'ORDERS_MIGRATION_STEP=upgrade_from_previous'
docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d upgrade <apps/api/prisma/migrations/20260904120000_orders_operational_view/migration.sql >/dev/null
[[ $(docker exec "$pg" psql -X -U postgres -d upgrade -qAt -c 'SELECT count(*) FROM "ErpOrderSync" WHERE "tenantId" IS NULL') == 0 ]]
[[ $(docker exec "$pg" psql -X -U postgres -d upgrade -qAt -c 'SELECT count(*) FROM "ErpOrderStatusHistory" WHERE source='"'"'migration-backfill'"'"'') == 3 ]]
[[ $(docker exec "$pg" psql -X -U postgres -d upgrade -qAt -c 'SELECT count(DISTINCT "erpOrderSyncId") FROM "ErpOrderStatusHistory" WHERE source='"'"'migration-backfill'"'"'') == 3 ]]
if docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d upgrade <apps/api/prisma/migrations/20260904120000_orders_operational_view/migration.sql >/dev/null 2>&1; then echo 'orders migration unexpectedly applied twice as raw DDL' >&2; exit 1; fi
[[ $(docker exec "$pg" psql -X -U postgres -d upgrade -qAt -c 'SELECT count(*) FROM "ErpOrderStatusHistory" WHERE source='"'"'migration-backfill'"'"'') == 3 ]]
[[ $(docker exec "$pg" psql -X -U postgres -d upgrade -qAt -c 'SELECT count(*) FROM "ErpOrderSync"') == 3 ]]
[[ $(docker exec "$pg" psql -X -U postgres -d upgrade -qAt -c "SELECT count(*) FROM pg_constraint WHERE conname IN ('ErpOrderSync_tenantId_fkey','ErpOrderStatusHistory_erpOrderSyncId_fkey','ErpOrderStatusHistory_opportunityId_fkey')") == 3 ]]
[[ $(docker exec "$pg" psql -X -U postgres -d upgrade -qAt -c "SELECT count(*) FROM pg_indexes WHERE indexname IN ('ErpOrderSync_tenantId_createdAt_idx','ErpOrderSync_tenantId_sellerId_createdAt_idx','ErpOrderStatusHistory_erpOrderSyncId_occurredAt_idx','ErpOrderStatusHistory_opportunityId_occurredAt_idx')") == 4 ]]
run_tooling upgrade ./node_modules/.bin/prisma migrate diff --from-url "$(url upgrade)" --to-schema-datamodel /app/apps/api/prisma/schema.prisma --exit-code >"$tmp/upgrade.diff"
[[ ! -s "$tmp/upgrade.diff" ]]

printf '%s\n' "$fixture_sql" | docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d invalid >/dev/null
docker exec "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d invalid -c 'ALTER TABLE "ErpOrderSync" DROP CONSTRAINT "ErpOrderSync_opportunityId_fkey"; INSERT INTO "ErpOrderSync" (id,"opportunityId","sellerId","pedidoIdImportacao",status,"payloadSent","createdAt","updatedAt") VALUES ('"'"'order-orphan'"'"','"'"'missing-opportunity'"'"','"'"'seller-a'"'"','"'"'import-orphan'"'"','"'"'error'"'"','"'"'{}'"'"',now(),now());' >/dev/null
echo 'ORDERS_MIGRATION_STEP=unresolved_tenant_fail_closed'
if docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d invalid <apps/api/prisma/migrations/20260904120000_orders_operational_view/migration.sql >"$tmp/invalid.out" 2>"$tmp/invalid.err"; then echo 'unresolved tenant migration unexpectedly succeeded' >&2; exit 1; fi
grep -Eq 'unresolved_count=[1-9][0-9]*' "$tmp/invalid.err"
! grep -Eq 'order-orphan|missing-opportunity|import-orphan|seller-a' "$tmp/invalid.err"
[[ $(docker exec "$pg" psql -X -U postgres -d invalid -qAt -c "SELECT count(*) FROM information_schema.columns WHERE table_name='ErpOrderSync' AND column_name='tenantId'") == 0 ]]
if grep -Eiq '\b(delete|truncate|drop[[:space:]]+table)\b' apps/api/prisma/migrations/20260904120000_orders_operational_view/migration.sql; then echo 'destructive SQL found' >&2; exit 1; fi
echo 'ORDERS_MIGRATION_POSTGRES=PASS'
