#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }

APP_COMMIT=${APP_COMMIT:-${EXPECTED_SHA:-}}
if [[ -z "$APP_COMMIT" ]]; then
  echo 'APP_COMMIT or EXPECTED_SHA is required' >&2
  exit 1
fi
if [[ -n "${EXPECTED_SHA:-}" && -n "${APP_COMMIT:-}" && "$EXPECTED_SHA" != "$APP_COMMIT" ]]; then
  echo 'APP_COMMIT and EXPECTED_SHA must identify the same revision' >&2
  exit 1
fi
API_IMAGE=${API_IMAGE:-"gest-o-api:${APP_COMMIT}"}

reject_production_target() {
  local value=${1:-}
  [[ -z "$value" ]] && return 0
  if [[ "$value" == *gest-o-db-clean-v2-20260717* ||
        "$value" == *localhost* ||
        "$value" == *127.0.0.1* ||
        "$value" == *salesforce_pro* ||
        "$value" == *gest-o_default* ||
        ( -n "${PRODUCTION_DB_HOST_EXPECTED:-}" && "$value" == *"$PRODUCTION_DB_HOST_EXPECTED"* ) ]]; then
    echo 'refusing a database or network value that may target production' >&2
    exit 1
  fi
}

# Reject inherited connection settings before constructing the disposable URL; no env file is loaded.
reject_production_target "${TEST_DATABASE_URL:-}"
reject_production_target "${DATABASE_URL:-}"

if ! docker image inspect "$API_IMAGE" >/dev/null 2>&1; then
  echo "required API image is not available locally: $API_IMAGE" >&2
  exit 1
fi
image_revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$API_IMAGE")
if [[ "$image_revision" != "$APP_COMMIT" ]]; then
  echo 'API image OCI revision does not match APP_COMMIT' >&2
  exit 1
fi

id="$$-$RANDOM"
PG_NAME="gesto-schema-test-pg-$id"
NETWORK_NAME="gesto-schema-test-$id"
PG_PASSWORD="schema-test-$id"
tmp=$(mktemp -d)
pg_created=false
network_created=false
cleanup() {
  if [[ "$pg_created" == true ]]; then
    docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  fi
  if [[ "$network_created" == true ]]; then
    docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

docker network create "$NETWORK_NAME" >/dev/null
network_created=true
docker run -d --rm --pull=never \
  --name "$PG_NAME" \
  --network "$NETWORK_NAME" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB=gesto_test \
  postgres:16 >/dev/null
pg_created=true

for _ in {1..60}; do
  docker exec "$PG_NAME" pg_isready -U postgres -d gesto_test >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG_NAME" pg_isready -U postgres -d gesto_test >/dev/null

TEST_DATABASE_URL="postgresql://postgres:${PG_PASSWORD}@${PG_NAME}:5432/gesto_test?schema=public"
reject_production_target "$NETWORK_NAME"
[[ "$TEST_DATABASE_URL" == *"@${PG_NAME}:5432/gesto_test?schema=public" ]] || {
  echo 'disposable database URL invariant failed' >&2
  exit 1
}

prisma_diff() {
  docker run --rm \
    --pull=never \
    --network "$NETWORK_NAME" \
    -e DATABASE_URL="$TEST_DATABASE_URL" \
    "$API_IMAGE" \
    ./node_modules/.bin/prisma migrate diff "$@"
}

prisma_diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/full.sql"
docker exec -i "$PG_NAME" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 <"$tmp/full.sql" >/dev/null
cat >"$tmp/recovered.sql" <<'SQL'
DROP TABLE "CommunicationMessage", "CommunicationWebhookEvent", "CommunicationConversation", "CommunicationIntegrationAccount", "ClientCodeAudit";
ALTER TABLE "Contact" DROP COLUMN "phoneHash", DROP COLUMN "phoneNormalized";
ALTER TABLE "AgendaEvent" DROP CONSTRAINT "AgendaEvent_clientId_fkey";
DROP TYPE "CommunicationChannelType", "CommunicationProviderType", "CommunicationDirection", "CommunicationMessageType", "CommunicationMessageStatus", "CommunicationConversationStatus", "CommunicationWebhookStatus";
CREATE TABLE incident_20260718_client_enrichment_audit(id int primary key, evidence text);
CREATE TABLE incident_20260718_client_map(id int primary key, evidence text);
CREATE TABLE incident_20260718_june_client_source(id int primary key, evidence text);
CREATE TABLE incident_20260718_recovery_audit(id int primary key, evidence text);
CREATE TABLE incident_20260719_erp_code_enrichment_audit(id int primary key, evidence text);
CREATE TABLE incident_20260719_erp_partner_client_map(id int primary key, evidence text);
CREATE TABLE incident_20260719_orphan_productprice_audit(id int primary key, evidence text);
CREATE TABLE incident_20260719_product_snapshot_map(id int primary key, evidence text);
INSERT INTO incident_20260718_client_enrichment_audit VALUES (1,'keep');
INSERT INTO incident_20260718_client_map VALUES (1,'keep');
INSERT INTO incident_20260718_june_client_source VALUES (1,'keep');
INSERT INTO incident_20260718_recovery_audit VALUES (1,'keep');
INSERT INTO incident_20260719_erp_code_enrichment_audit VALUES (1,'keep');
INSERT INTO incident_20260719_erp_partner_client_map VALUES (1,'keep');
INSERT INTO incident_20260719_orphan_productprice_audit VALUES (1,'keep');
INSERT INTO incident_20260719_product_snapshot_map VALUES (1,'keep');
SQL
docker exec -i "$PG_NAME" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 <"$tmp/recovered.sql" >/dev/null
count_incidents() { docker exec "$PG_NAME" psql -U postgres -d gesto_test -Atc "SELECT tablename||':'||(xpath('/row/c/text()',query_to_xml(format('SELECT count(*) c FROM %I',tablename),false,true,'')))[1]::text FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'incident\_%' ESCAPE '\\' ORDER BY 1"; }
count_incidents >"$tmp/before"

# Preflight accepts the exact additive transition.
prisma_diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/pre.raw.sql"
node scripts/schema-diff-filter.mjs "$tmp/pre.raw.sql" "$tmp/pre.sql" pre
docker exec -i "$PG_NAME" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 --single-transaction <apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >/dev/null
count_incidents >"$tmp/after-first"
cmp "$tmp/before" "$tmp/after-first"
prisma_diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/post.raw.sql"
node scripts/schema-diff-filter.mjs "$tmp/post.raw.sql" "$tmp/post.sql" post
test ! -s "$tmp/post.sql"

# A second application is safe and leaves both managed schema and incident evidence unchanged.
docker exec -i "$PG_NAME" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 --single-transaction <apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >/dev/null
count_incidents >"$tmp/after-second"
cmp "$tmp/before" "$tmp/after-second"
prisma_diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/post2.raw.sql"
node scripts/schema-diff-filter.mjs "$tmp/post2.raw.sql" "$tmp/post2.sql" post
test ! -s "$tmp/post2.sql"

# Prove a partially existing target table is rejected by the preflight filter.
docker exec "$PG_NAME" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 -c 'ALTER TABLE "CommunicationMessage" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP' >/dev/null
prisma_diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/partial.raw.sql"
if node scripts/schema-diff-filter.mjs "$tmp/partial.raw.sql" "$tmp/partial.sql" pre 2>/dev/null; then
  echo 'partial table was accepted' >&2
  exit 1
fi
echo 'production schema disposable PostgreSQL test passed'
