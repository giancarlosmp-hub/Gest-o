#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
sha=$(git rev-parse HEAD); image=${API_IMAGE:-gest-o-api:$sha}
docker image inspect "$image" >/dev/null 2>&1 || { echo "SKIP: pinned API image unavailable: $image" >&2; exit 77; }
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image") == "$sha" ]] || { echo 'image SHA mismatch' >&2; exit 1; }
[[ -z ${DATABASE_URL:-} && -z ${TEST_DATABASE_URL:-} ]] || { echo 'refusing inherited database URL' >&2; exit 1; }
id="$$-$RANDOM"; net="gesto-op-net-$id"; ref="gesto-op-ref-$id"; path="gesto-op-path-$id"; tmp=$(mktemp -d)
cleanup(){ docker rm -f "$ref" "$path" >/dev/null 2>&1||true; docker network rm "$net" >/dev/null 2>&1||true; rm -rf "$tmp"; }; trap cleanup EXIT
docker network create --internal "$net" >/dev/null
for c in "$ref" "$path"; do docker run -d --rm --pull=never --name "$c" --network "$net" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=gesto postgres:16 >/dev/null; done
for c in "$ref" "$path"; do for _ in {1..60}; do docker exec "$c" pg_isready -U postgres -d gesto >/dev/null 2>&1&&break;sleep 1;done; docker exec "$c" pg_isready -U postgres -d gesto >/dev/null; done
refurl="postgresql://postgres:test@$ref:5432/gesto?schema=public"; pathurl="postgresql://postgres:test@$path:5432/gesto?schema=public"
run_api(){ local url=$1; shift; docker run --rm --pull=never --network "$net" -e DATABASE_URL="$url" "$@"; }
# A is the final reference. B is the registry-validated historical datamodel, never a filtered schema.
run_api "$refurl" "$image" ./node_modules/.bin/prisma db push --schema apps/api/prisma/schema.prisma --skip-generate >/dev/null
node scripts/resolve-control-plane-predecessor.mjs --write-schema "$tmp/predecessor.prisma" >"$tmp/predecessor.json"
[[ $(sha256sum "$tmp/predecessor.prisma"|awk '{print $1}') == $(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).predecessorSchemaSha256)' "$tmp/predecessor.json") ]]
docker run --rm --pull=never --network "$net" -e DATABASE_URL="$pathurl" -v "$tmp/predecessor.prisma:/tmp/schema.prisma:ro" "$image" ./node_modules/.bin/prisma db push --schema /tmp/schema.prisma --skip-generate >/dev/null
test "$(docker exec "$path" psql -U postgres -d gesto -Atc "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('Tenant','TenantMembership')")" = 0
docker exec -i "$path" psql -X -U postgres -d gesto -v ON_ERROR_STOP=1 -1 <apps/api/prisma/migrations/20260802120000_tenancy_control_plane/migration.sql >/dev/null
if ! docker exec -i "$path" psql -X -U postgres -d gesto -v ON_ERROR_STOP=1 -AtF $'\t' <scripts/control-plane-catalog.sql >"$tmp/catalog.tsv"; then
  printf '%s\n' '===== CATALOG_QUERY_FAILED =====' >&2
  exit 1
fi
if ! node scripts/control-plane-catalog-validate.mjs "$tmp/catalog.tsv" >/dev/null; then
  printf '%s\n' '===== ACTUAL FK CATALOG ROWS =====' >&2
  awk -F '\t' '$1=="fk" && ($2=="TenantMembership_tenantId_fkey" || $2=="TenantMembership_userId_fkey")' "$tmp/catalog.tsv" >&2
  exit 1
fi
run_api "$pathurl" "$image" ./node_modules/.bin/prisma migrate diff --from-url "$pathurl" --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/post.sql"
test -z "$(sed '/^[[:space:]]*--/d;/^[[:space:]]*$/d' "$tmp/post.sql")"
if docker exec -i "$path" psql -X -U postgres -d gesto -v ON_ERROR_STOP=1 -1 <apps/api/prisma/migrations/20260802120000_tenancy_control_plane/migration.sql >/dev/null 2>&1; then echo 'literal reapply succeeded' >&2; exit 1; fi
docker exec "$path" psql -U postgres -d gesto -v ON_ERROR_STOP=1 -c 'CREATE ROLE runtime_test LOGIN; GRANT USAGE ON SCHEMA public TO runtime_test' >/dev/null
if docker exec "$path" psql -U runtime_test -d gesto -c 'CREATE TABLE permission_probe(id int)' >/dev/null 2>&1; then echo 'runtime CREATE succeeded' >&2; exit 1; fi
# Catalog mutations exercise partial/divergent enum, table, column/type/default/nullability, index, FK and CHECK.
for pattern in '^enum\tTenantStatus' '^table\tTenant' '^column\tTenant.id' '^index\tTenant_slug_key' '^fk\tTenantMembership_tenantId_fkey' '^check\tTenantMembership_version_positive'; do
  awk -v p="$pattern" '$0 !~ p' "$tmp/catalog.tsv" >"$tmp/bad.tsv"
  if node scripts/control-plane-catalog-validate.mjs "$tmp/bad.tsv" >/dev/null 2>&1; then echo "catalog mutation accepted: $pattern" >&2; exit 1; fi
done
sed '0,/active/{s/active/divergent/}' "$tmp/catalog.tsv" >"$tmp/bad.tsv"; ! node scripts/control-plane-catalog-validate.mjs "$tmp/bad.tsv" >/dev/null 2>&1
sed '0,/text|text|NO|/{s/text|text|NO|/integer|int4|YES|0/}' "$tmp/catalog.tsv" >"$tmp/bad.tsv"; ! node scripts/control-plane-catalog-validate.mjs "$tmp/bad.tsv" >/dev/null 2>&1
docker exec "$path" psql -U postgres -d gesto -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "User" (id,name,email,"passwordHash",role,"isActive","createdAt") VALUES
('op-d','Synthetic','d@example.invalid','x','diretor',true,now()),('op-g','Synthetic','g@example.invalid','x','gerente',true,now()),('op-v','Synthetic','v@example.invalid','x','vendedor',false,now());
SQL
mkdir "$tmp/evidence"
runner(){ run_api "$pathurl" -e APP_COMMIT="$sha" -e EXPECTED_SHA="$sha" -e TENANCY_MODE=default-only -e EVIDENCE_DIR=/evidence -v "$tmp/evidence:/evidence" ${CONFIRM:+-e CONFIRM} ${EXPECTED_AGGREGATE_HASH:+-e EXPECTED_AGGREGATE_HASH} "$image" node apps/api/dist/scripts/prepareDefaultTenant.js "$@"; }
runner --dry-run >/dev/null; test "$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "Tenant"')" = 0
EXPECTED_AGGREGATE_HASH=$(awk -F '\t' 'NR==2{for(i=1;i<=NF;i++)if(h[i]=="expectedAggregateHash")print $i}NR==1{for(i=1;i<=NF;i++)h[i]=$i}' "$tmp/evidence/dry-run-result.tsv"); export EXPECTED_AGGREGATE_HASH CONFIRM=PREPARE_DEFAULT_TENANT
runner --apply >/dev/null
test "$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "TenantMembership"')" = 3
rm -f "$tmp/evidence/result.tsv"; runner --apply >/dev/null
test "$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "TenantMembership"')" = 3
echo 'tenancy control-plane operation PostgreSQL test passed'
