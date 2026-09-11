#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
sha=$(git rev-parse HEAD); image=${API_IMAGE:-gest-o-api:$sha}
docker image inspect "$image" >/dev/null 2>&1 || { echo 'required pinned API tooling image unavailable' >&2; exit 1; }
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image") == "$sha" ]] || { echo 'API tooling image SHA mismatch' >&2; exit 1; }
[[ -z ${DATABASE_URL:-} && -z ${TEST_DATABASE_URL:-} ]] || { echo 'refusing inherited database URL' >&2; exit 1; }
id="$$-$RANDOM"; pg="product-price-authority-pg16-$id"; net="$pg-net"; tmp=$(mktemp -d); chmod 700 "$tmp"
cleanup(){ docker rm -f "$pg" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
docker network create --internal "$net" >/dev/null
docker run -d --rm --pull=never --name "$pg" --network "$net" -e POSTGRES_PASSWORD=synthetic -e POSTGRES_DB=gesto_test postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$pg" pg_isready -U postgres -d gesto_test >/dev/null 2>&1 && break; sleep 1; done
docker exec "$pg" pg_isready -U postgres -d gesto_test >/dev/null
url="postgresql://postgres:synthetic@$pg:5432/gesto_test?schema=public"
intro=$(git log --all --format=%H --diff-filter=A -- apps/api/prisma/migrations/20260911190000_product_price_authority/migration.sql)
[[ -n "$intro" && "$intro" != *$'\n'* ]]
git show "${intro}^:apps/api/prisma/schema.prisma" >"$tmp/predecessor.prisma"
! grep -Eq '^  (source|availabilityState) +String' "$tmp/predecessor.prisma"
docker run --rm --pull=never --network "$net" -v "$tmp:/work:ro" -e DATABASE_URL="$url" "$image" ./node_modules/.bin/prisma db push --schema /work/predecessor.prisma --skip-generate >/dev/null
psql(){ docker exec -i "$pg" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d gesto_test "$@"; }
psql <<'SQL'
INSERT INTO "Product" (id,"erpProductCode","erpProductClassCode",name,"createdAt","updatedAt")
VALUES ('p1','1','9','Synthetic Positive',now(),now()),('p2','1','12','Synthetic Zero',now(),now()),('p3','1','19','Old API',now(),now());
INSERT INTO "ProductPrice" (id,"productId","erpPriceId","branchCode",price,"createdAt","updatedAt")
VALUES ('positive','p1','1','1',128,now(),now()),('zero','p2','1','1',0,now(),now());
SQL
before=$(psql -Atc 'SELECT string_agg(id||'\''|'\''||price, '\'', '\'' ORDER BY id) FROM "ProductPrice"')
psql <apps/api/prisma/migrations/20260911190000_product_price_authority/migration.sql
after=$(psql -Atc 'SELECT string_agg(id||'\''|'\''||price, '\'', '\'' ORDER BY id) FROM "ProductPrice"')
[[ "$before" == "$after" ]]
[[ $(psql -Atc 'SELECT count(*) FROM "ProductPrice" WHERE "source"='\''legacy'\'' AND "availabilityState"='\''available'\''') == 2 ]]
[[ $(psql -Atc 'SELECT count(*) FROM information_schema.columns WHERE table_schema='\''public'\'' AND table_name='\''ProductPrice'\'' AND column_name IN ('\''source'\','\''availabilityState'\'') AND is_nullable='\''NO'\'' AND column_default IS NOT NULL') == 2 ]]
[[ $(psql -Atc 'SELECT count(*) FROM pg_indexes WHERE schemaname='\''public'\'' AND indexname='\''ProductPrice_source_availabilityState_idx'\''') == 1 ]]
# Previous API INSERT omits both new columns; database defaults must keep it valid.
psql -c 'INSERT INTO "ProductPrice" (id,"productId",price,"createdAt","updatedAt") VALUES ('\''old-api-write'\'','\''p3'\'',42,now(),now())' >/dev/null
[[ $(psql -Atc 'SELECT "source"||'\''|'\''||"availabilityState" FROM "ProductPrice" WHERE id='\''old-api-write'\''') == 'legacy|available' ]]
docker run --rm --pull=never --network "$net" -e DATABASE_URL="$url" "$image" ./node_modules/.bin/prisma migrate diff --from-url "$url" --to-schema-datamodel /app/apps/api/prisma/schema.prisma --exit-code
printf '%s\n' PRODUCT_PRICE_AUTHORITY_PREDECESSOR_SCHEMA=PASS PRODUCT_PRICE_AUTHORITY_EXISTING_ROWS=PRESERVED PRODUCT_PRICE_AUTHORITY_OLD_API_COMPATIBILITY=PASS PRODUCT_PRICE_AUTHORITY_FINAL_SCHEMA_DIFF=PASS PRODUCT_PRICE_AUTHORITY_MIGRATION_POSTGRES=PASS
