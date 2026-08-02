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
RUNTIME_PASSWORD="runtime-test-$id"
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

docker exec "$PG_NAME" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE runtime LOGIN PASSWORD '${RUNTIME_PASSWORD}'; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT CONNECT ON DATABASE gesto_test TO runtime; GRANT USAGE ON SCHEMA public TO runtime" >/dev/null
TEST_DATABASE_URL="postgresql://runtime:${RUNTIME_PASSWORD}@${PG_NAME}:5432/gesto_test?schema=public"
reject_production_target "$NETWORK_NAME"
[[ "$TEST_DATABASE_URL" == "postgresql://runtime:"*"@${PG_NAME}:5432/gesto_test?schema=public" ]] || {
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
-- The generated from-empty SQL materializes the current datamodel, including the control plane.
-- The recovered-production fixture predates both authorized migrations, so remove those
-- generated objects here. The control-plane migration is then executed exactly once below.
DROP TABLE "TenantMembership", "Tenant";
DROP TYPE "TenantMembershipStatus", "TenantRole", "TenantStatus";
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
docker exec "$PG_NAME" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 -c \
  'GRANT SELECT ON ALL TABLES IN SCHEMA public TO runtime' >/dev/null
count_incidents() { docker exec "$PG_NAME" psql -U postgres -d gesto_test -Atc "SELECT tablename||':'||(xpath('/row/c/text()',query_to_xml(format('SELECT count(*) c FROM %I',tablename),false,true,'')))[1]::text FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'incident\_%' ESCAPE '\\' ORDER BY 1"; }
count_incidents >"$tmp/before"

# Preflight accepts the exact additive transition.
prisma_diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/pre.raw.sql"
node scripts/schema-diff-filter.mjs "$tmp/pre.raw.sql" "$tmp/pre.sql" pre
if docker exec -i "$PG_NAME" psql -U runtime -d gesto_test -v ON_ERROR_STOP=1 --single-transaction \
  <apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >"$tmp/runtime.out" 2>&1; then
  echo 'runtime role unexpectedly acquired DDL authority' >&2
  exit 1
fi
grep -q 'permission denied for schema public' "$tmp/runtime.out"

# A failure after successful DDL in the same transaction must leave no partial object.
printf 'CREATE TABLE rollback_probe(id int);\nSELECT missing_mid_migration();\n' >"$tmp/rollback.sql"
if docker exec --user postgres -i "$PG_NAME" psql --dbname=gesto_test -X -v ON_ERROR_STOP=1 --single-transaction -f - \
  <"$tmp/rollback.sql" >/dev/null 2>&1; then
  echo 'deliberately broken migration unexpectedly succeeded' >&2
  exit 1
fi
test "$(docker exec --user postgres "$PG_NAME" psql --dbname=gesto_test -X -Atc "SELECT to_regclass('public.rollback_probe') IS NULL")" = t

docker exec --user postgres -i "$PG_NAME" psql --dbname=gesto_test -X -v ON_ERROR_STOP=1 --single-transaction -f - \
  <apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >/dev/null
docker exec --user postgres -i "$PG_NAME" psql --dbname=gesto_test -X -v ON_ERROR_STOP=1 --single-transaction -f - \
  <apps/api/prisma/migrations/20260802120000_tenancy_control_plane/migration.sql >/dev/null
count_incidents >"$tmp/after-first"
cmp "$tmp/before" "$tmp/after-first"
prisma_diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/post.raw.sql"
set +e
node scripts/schema-diff-filter.mjs "$tmp/post.raw.sql" "$tmp/post.sql" post
FILTER_STATUS=$?
set -e
if [[ "$FILTER_STATUS" -ne 0 ]]; then
  docker exec --user postgres "$PG_NAME" psql --dbname=gesto_test -X -v ON_ERROR_STOP=1 -At <<'SQL' >"$tmp/control-plane-catalog.tsv"
SELECT 'enum', t.typname, e.enumsortorder::text, e.enumlabel
FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
WHERE t.typnamespace='public'::regnamespace
  AND t.typname IN ('TenantStatus','TenantMembershipStatus','TenantRole')
UNION ALL
SELECT 'column', table_name, ordinal_position::text,
       column_name || E'\t' || data_type || E'\t' || is_nullable || E'\t' || coalesce(column_default,'')
FROM information_schema.columns
WHERE table_schema='public' AND table_name IN ('Tenant','TenantMembership')
UNION ALL
SELECT 'index', tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname='public' AND tablename IN ('Tenant','TenantMembership')
UNION ALL
SELECT CASE c.contype WHEN 'f' THEN 'foreign_key' WHEN 'c' THEN 'check' ELSE 'constraint' END,
       r.relname, c.conname, pg_get_constraintdef(c.oid, true)
FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
WHERE c.connamespace='public'::regnamespace
  AND r.relname IN ('Tenant','TenantMembership') AND c.contype IN ('f','c')
ORDER BY 1,2,3;
SQL
  printf '%s\n' '===== POST-APPLY PRISMA DIFF RAW ====='
  cat "$tmp/post.raw.sql"
  printf '%s\n' '===== POST-APPLY MANAGED DIFF ====='
  cat "$tmp/post.sql"
  printf '%s\n' '===== CONTROL-PLANE STRUCTURAL CATALOG ====='
  cat "$tmp/control-plane-catalog.tsv"
  exit "$FILTER_STATUS"
fi
test ! -s "$tmp/post.sql"

# The historical repeatable transition remains safe; the new Prisma migration is applied exactly once.
docker exec --user postgres -i "$PG_NAME" psql --dbname=gesto_test -X -v ON_ERROR_STOP=1 --single-transaction -f - <apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >/dev/null
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
