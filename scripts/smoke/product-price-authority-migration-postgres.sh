#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
container="product-price-authority-pg16-${RANDOM}-$$"
cleanup(){ docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --pull=never --name "$container" -e POSTGRES_PASSWORD=synthetic -e POSTGRES_DB=gesto_test postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$container" pg_isready -U postgres -d gesto_test >/dev/null 2>&1 && break; sleep 1; done
psql(){ docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d gesto_test "$@"; }
psql <<'SQL'
CREATE TABLE "ProductPrice" (
  id text PRIMARY KEY, "productId" text NOT NULL, "erpPriceId" text,
  "branchCode" text, "validFrom" timestamp, price double precision NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now()
);
INSERT INTO "ProductPrice" (id,"productId","erpPriceId","branchCode",price)
VALUES ('positive','p1','1','1',128),('zero','p2','1','1',0);
SQL
before=$(psql -Atc 'SELECT string_agg(id||'\''|'\''||price, '\'', '\'' ORDER BY id) FROM "ProductPrice"')
psql <apps/api/prisma/migrations/20260911190000_product_price_authority/migration.sql
after=$(psql -Atc 'SELECT string_agg(id||'\''|'\''||price, '\'', '\'' ORDER BY id) FROM "ProductPrice"')
[[ "$before" == "$after" ]]
[[ $(psql -Atc 'SELECT count(*) FROM "ProductPrice" WHERE "source"='\''legacy'\'' AND "availabilityState"='\''available'\''') == 2 ]]
[[ $(psql -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ProductPrice' AND column_name IN ('source','availabilityState') AND is_nullable='NO' AND column_default IS NOT NULL") == 2 ]]
[[ $(psql -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='ProductPrice_source_availabilityState_idx'") == 1 ]]
# The previous release omits both new fields; defaults keep its INSERTs valid.
psql -c 'INSERT INTO "ProductPrice" (id,"productId",price) VALUES ('\''old-api-write'\'','\''p3'\'',42)' >/dev/null
[[ $(psql -Atc 'SELECT "source"||'\''|'\''||"availabilityState" FROM "ProductPrice" WHERE id='\''old-api-write'\''') == 'legacy|available' ]]
echo PRODUCT_PRICE_AUTHORITY_EXISTING_ROWS=PRESERVED
echo PRODUCT_PRICE_AUTHORITY_OLD_API_COMPATIBILITY=PASS
echo PRODUCT_PRICE_AUTHORITY_MIGRATION_POSTGRES=PASS
