#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
docker image inspect node:20 >/dev/null 2>&1 || { echo 'SKIP: node:20 unavailable locally' >&2; exit 77; }
[[ -z ${DATABASE_URL:-} && -z ${TEST_DATABASE_URL:-} ]] || { echo 'refusing inherited database URL' >&2; exit 1; }
id="$$-$RANDOM"; pg="gesto-expand-pg-$id"; net="gesto-expand-net-$id"; tmp=$(mktemp -d)
cleanup(){ docker rm -f "$pg" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$tmp"; }; trap cleanup EXIT
git show HEAD:apps/api/prisma/schema.prisma > "$tmp/predecessor.prisma"
docker network create --internal "$net" >/dev/null
docker run -d --rm --pull=never --name "$pg" --network "$net" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=expand postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$pg" pg_isready -U postgres -d expand >/dev/null 2>&1 && break; sleep 1; done
docker exec "$pg" pg_isready -U postgres -d expand >/dev/null
url="postgresql://postgres:test@$pg:5432/expand?schema=public"
run_node(){ docker run --rm --pull=never --network "$net" -v "$root:/repo:ro" -v "$tmp:/work" -w /repo -e DATABASE_URL="$url" node:20 "$@"; }
run_node ./node_modules/.bin/prisma db push --schema /work/predecessor.prisma --skip-generate >/dev/null
# Synthetic pre-existing rows cover legacy inserts, global uniques and integration lock/idempotency semantics.
docker exec "$pg" psql -U postgres -d expand -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "AppConfig" (id,key,value,"createdAt","updatedAt") VALUES ('cfg','synthetic-key','value',now(),now());
INSERT INTO "Product" (id,"erpProductCode","erpProductClassCode",name,"isActive","isSuspended","createdAt","updatedAt") VALUES ('product','P1','C1','Synthetic',true,false,now(),now());
INSERT INTO "ErpSyncRun" (id,scope,trigger,status,"authMode","startedAt","syncedCount","createdAt") VALUES ('run','products','manual','success','global',now(),1,now());
INSERT INTO "ErpSyncLock" (scope,"runId","lockedUntil","createdAt","updatedAt") VALUES ('products','run',now()+interval '1 minute',now(),now());
CREATE TABLE "incident_synthetic" (id integer PRIMARY KEY);
INSERT INTO "incident_synthetic" VALUES (1);
SQL
roots=(KnowledgeDocument Client AgendaEvent Goal ActivityKPI Sale SellerTerritoryCity AppConfig Product ErpSyncRun ErpSyncLock)
for table in "${roots[@]}"; do docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM \"$table\"" > "$tmp/$table.before"; done
incident_before=$(docker exec "$pg" psql -U postgres -d expand -Atc 'SELECT count(*) FROM "incident_synthetic"')
docker exec -i "$pg" psql -U postgres -d expand -v ON_ERROR_STOP=1 < apps/api/prisma/migrations/20260808120000_tenancy_expand_roots/migration.sql >/dev/null
if docker exec -i "$pg" psql -U postgres -d expand -v ON_ERROR_STOP=1 < apps/api/prisma/migrations/20260808120000_tenancy_expand_roots/migration.sql >/dev/null 2>&1; then echo 'migration unexpectedly applied twice' >&2; exit 1; fi
for table in "${roots[@]}"; do
  test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='$table' AND column_name='tenantId'")" = YES
  test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM \"$table\" WHERE \"tenantId\" IS NOT NULL")" = 0
  test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM \"$table\"")" = "$(cat "$tmp/$table.before")"
  test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='${table}_tenantId_idx'")" = 1
  test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM pg_constraint WHERE conname='${table}_tenantId_fkey' AND confdeltype='a'")" = 1
done
test "$(docker exec "$pg" psql -U postgres -d expand -Atc 'SELECT count(*) FROM "incident_synthetic"')" = "$incident_before"
# Old writes remain valid; valid ownership succeeds; unknown ownership is rejected.
docker exec "$pg" psql -U postgres -d expand -c "INSERT INTO \"AppConfig\" (id,key,value,\"createdAt\",\"updatedAt\") VALUES ('legacy','legacy-key','value',now(),now())" >/dev/null
docker exec "$pg" psql -U postgres -d expand -c "INSERT INTO \"Tenant\" (id,slug,\"legalName\",\"displayName\",status,\"createdAt\",\"updatedAt\") VALUES ('synthetic-tenant','synthetic','Synthetic','Synthetic','active',now(),now()); UPDATE \"Product\" SET \"tenantId\"='synthetic-tenant' WHERE id='product'" >/dev/null
if docker exec "$pg" psql -U postgres -d expand -c "UPDATE \"AppConfig\" SET \"tenantId\"='missing' WHERE id='cfg'" >/dev/null 2>&1; then echo 'unknown tenant accepted' >&2; exit 1; fi
# Existing global unique constraints still reject duplicates.
if docker exec "$pg" psql -U postgres -d expand -c "INSERT INTO \"AppConfig\" (id,key,value,\"createdAt\",\"updatedAt\") VALUES ('duplicate','synthetic-key','value',now(),now())" >/dev/null 2>&1; then echo 'global unique changed' >&2; exit 1; fi
run_node ./node_modules/.bin/prisma migrate diff --from-url "$url" --to-schema-datamodel apps/api/prisma/schema.prisma --script > "$tmp/post-diff.raw.sql"
# The sole raw diff is the deliberately unmanaged forensic fixture; stripping that exact block yields an empty managed diff.
sed '/-- DropTable/,/DROP TABLE "incident_synthetic";/d' "$tmp/post-diff.raw.sql" | sed '/^[[:space:]]*$/d' > "$tmp/post-diff.managed.sql"
test "$(rg -c 'DROP TABLE "incident_synthetic"' "$tmp/post-diff.raw.sql")" = 1
test ! -s "$tmp/post-diff.managed.sql"
echo 'tenancy expand disposable PostgreSQL 16 test passed'
