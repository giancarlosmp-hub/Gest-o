#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
[[ -z ${DATABASE_URL:-} && -z ${TEST_DATABASE_URL:-} ]] || { echo 'refusing inherited database URL' >&2; exit 1; }
id="$$-$RANDOM"; pg="price-provenance-pg16-$id"; tmp=$(mktemp -d); chmod 700 "$tmp"
cleanup(){ docker rm -f "$pg" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
docker run -d --rm --pull=never --name "$pg" -e POSTGRES_PASSWORD=synthetic -e POSTGRES_DB=gesto_test -p 127.0.0.1::5432 postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$pg" pg_isready -U postgres -d gesto_test >/dev/null 2>&1 && break; sleep 1; done
port=$(docker port "$pg" 5432/tcp | awk -F: '{print $NF}')
url="postgresql://postgres:synthetic@127.0.0.1:${port}/gesto_test?schema=public"
intro=$(git log --all --format=%H --diff-filter=A -- apps/api/prisma/migrations/20260927160000_product_price_source_observation/migration.sql)
[[ -n "$intro" && "$intro" != *$'\n'* ]]
git show "${intro}^:apps/api/prisma/schema.prisma" >"$tmp/predecessor.prisma"
DATABASE_URL="$url" npx prisma db push --schema "$tmp/predecessor.prisma" --skip-generate >/dev/null
psql(){ docker exec -i "$pg" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d gesto_test "$@"; }
psql <<'SQL'
INSERT INTO "Product" (id,"erpProductCode","erpProductClassCode",name,"createdAt","updatedAt")
VALUES ('existing-product','1','9','Existing product',now(),now());
INSERT INTO "ProductPrice" (id,"productId","erpPriceId","branchCode","validFrom",price,source,"availabilityState","createdAt","updatedAt")
VALUES ('existing-price','existing-product',NULL,'1','2022-08-26',252.08,'prices','available',now(),now());
SQL
DATABASE_URL="$url" npx prisma db push --schema apps/api/prisma/schema.prisma --skip-generate >/dev/null
result=$(psql -At <<'SQL'
SELECT count(*) || '|' || min(price)::text || '|' ||
       count(*) FILTER (WHERE "erpSourcePriceId" IS NULL AND "sourceChangedAt" IS NULL AND "observedAt" IS NULL)
FROM "ProductPrice" WHERE id='existing-price';
SQL
)
[[ "$result" == '1|252.08|1' ]]
columns=$(psql -At <<'SQL'
SELECT count(*) FROM information_schema.columns
WHERE table_schema='public' AND table_name='ProductPrice'
AND column_name IN ('erpSourcePriceId','sourceChangedAt','observedAt') AND is_nullable='YES';
SQL
)
[[ "$columns" == 3 ]]
indexes=$(psql -At <<'SQL'
SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='ProductPrice_erpSourcePriceId_idx';
SQL
)
[[ "$indexes" == 1 ]]
printf '%s\n' PRODUCT_PRICE_PROVENANCE_DB_PUSH_EXISTING_ROWS=PRESERVED PRODUCT_PRICE_PROVENANCE_DB_PUSH_NULL_OBSERVATION=PASS PRODUCT_PRICE_PROVENANCE_DB_PUSH_INDEX=PASS
