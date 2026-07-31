#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }
name="gesto-schema-test-$$"; port="${SCHEMA_TEST_PORT:-55432}"
tmp=$(mktemp -d); trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=gesto_test -p "127.0.0.1:$port:5432" postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$name" pg_isready -U postgres -d gesto_test >/dev/null 2>&1 && break; sleep 1; done
docker exec "$name" pg_isready -U postgres -d gesto_test >/dev/null
export DATABASE_URL="postgresql://postgres:test@127.0.0.1:$port/gesto_test"
./node_modules/.bin/prisma migrate diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/full.sql"
docker exec -i "$name" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 <"$tmp/full.sql" >/dev/null
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
docker exec -i "$name" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 <"$tmp/recovered.sql" >/dev/null
count_incidents(){ docker exec "$name" psql -U postgres -d gesto_test -Atc "SELECT tablename||':'||(xpath('/row/c/text()',query_to_xml(format('SELECT count(*) c FROM %I',tablename),false,true,'')))[1]::text FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'incident\_%' ESCAPE '\\' ORDER BY 1"; }
count_incidents >"$tmp/before"
# Preflight accepts the exact additive transition.
./node_modules/.bin/prisma migrate diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/pre.raw.sql"
node scripts/schema-diff-filter.mjs "$tmp/pre.raw.sql" "$tmp/pre.sql" pre
docker exec -i "$name" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 --single-transaction <apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >/dev/null
count_incidents >"$tmp/after-first"; cmp "$tmp/before" "$tmp/after-first"
./node_modules/.bin/prisma migrate diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/post.raw.sql"
node scripts/schema-diff-filter.mjs "$tmp/post.raw.sql" "$tmp/post.sql" post
test ! -s "$tmp/post.sql"
# A second application is safe and leaves both managed schema and incident evidence unchanged.
docker exec -i "$name" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 --single-transaction <apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >/dev/null
count_incidents >"$tmp/after-second"; cmp "$tmp/before" "$tmp/after-second"
./node_modules/.bin/prisma migrate diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/post2.raw.sql"
node scripts/schema-diff-filter.mjs "$tmp/post2.raw.sql" "$tmp/post2.sql" post
# Prove a partially existing target table is rejected by the preflight filter.
docker exec "$name" psql -U postgres -d gesto_test -v ON_ERROR_STOP=1 -c 'ALTER TABLE "CommunicationMessage" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP' >/dev/null
./node_modules/.bin/prisma migrate diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/partial.raw.sql"
if node scripts/schema-diff-filter.mjs "$tmp/partial.raw.sql" "$tmp/partial.sql" pre 2>/dev/null; then echo 'partial table was accepted' >&2; exit 1; fi
echo 'production schema disposable PostgreSQL test passed'
