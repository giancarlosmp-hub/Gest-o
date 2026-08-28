#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
name="pr827-preview-pg16-${RANDOM}-$$"; tmp=$(mktemp -d)
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || :; rm -rf "$tmp"; }; trap cleanup EXIT
docker run -d --pull=never --name "$name" -e POSTGRES_PASSWORD=synthetic -e POSTGRES_DB=salesforce_pro postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$name" pg_isready -U postgres -d salesforce_pro >/dev/null 2>&1 && break; sleep 1; done
docker exec "$name" pg_isready -U postgres -d salesforce_pro >/dev/null
psql(){ docker exec -i "$name" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d salesforce_pro "$@"; }
sql_file(){ psql -AtF $'\t' -f - <"$1"; }
reset(){ psql -c 'DROP SCHEMA IF EXISTS other CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;' >/dev/null; }
diagnose(){ local path=$1 out=$2; docker exec -e PGOPTIONS="-c search_path=$path" -i "$name" psql -X -qAtF $'\t' -v ON_ERROR_STOP=1 -U postgres -d salesforce_pro -f - <scripts/sql/pr827-connection-diagnostics.sql >"$out"; }
assert_line(){ grep -Fqx "$2" "$1" || { echo "missing sanitized classification: $2" >&2; exit 1; }; }

reset; diagnose 'public' "$tmp/absent"; assert_line "$tmp/absent" $'PRISMA_LEDGER_LOCATION\tABSENT'; assert_line "$tmp/absent" $'SEARCH_PATH_CLASS\tPUBLIC_FIRST'; assert_line "$tmp/absent" $'TRANSACTION_ACCESS_CLASS\tREAD_ONLY'
echo 'POSTGRESQL_16_LEDGER_ABSENT=PASS'
psql -c 'CREATE TABLE public."_prisma_migrations" (checksum text, finished_at timestamptz, rolled_back_at timestamptz, migration_name text, started_at timestamptz);' >/dev/null
diagnose 'public' "$tmp/public"; assert_line "$tmp/public" $'PRISMA_LEDGER_LOCATION\tPUBLIC'; echo 'POSTGRESQL_16_LEDGER_PUBLIC=PASS'
reset; psql -c 'CREATE SCHEMA other; CREATE TABLE other."_prisma_migrations" (id text);' >/dev/null
diagnose 'other,public' "$tmp/other"; assert_line "$tmp/other" $'PRISMA_LEDGER_LOCATION\tOTHER_SCHEMA_REDACTED'; assert_line "$tmp/other" $'SEARCH_PATH_CLASS\tPUBLIC_INCLUDED'; echo 'POSTGRESQL_16_LEDGER_OTHER_SCHEMA=PASS'

reset
sql_file scripts/pr827-predecessor-catalog.sql >"$tmp/pred-absent"; assert_line "$tmp/pred-absent" $'PREDECESSOR_CATALOG_STATE\tABSENT'
psql -c 'CREATE TABLE public."KnowledgeDocument" ("tenantId" text);' >/dev/null
sql_file scripts/pr827-predecessor-catalog.sql >"$tmp/pred-partial"; assert_line "$tmp/pred-partial" $'PREDECESSOR_CATALOG_STATE\tPARTIAL'
reset
psql <<'SQL' >/dev/null
CREATE TABLE public."Tenant" (id text PRIMARY KEY);
DO $fixture$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['KnowledgeDocument','Client','AgendaEvent','Goal','ActivityKPI','Sale','SellerTerritoryCity','AppConfig','Product','ErpSyncRun','ErpSyncLock'] LOOP
  EXECUTE format('CREATE TABLE public.%I (id text PRIMARY KEY, "tenantId" text)',n);
  EXECUTE format('CREATE INDEX %I ON public.%I ("tenantId")',n||'_tenantId_idx',n);
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)',n,n||'_tenantId_fkey');
 END LOOP;
END $fixture$;
SQL
sql_file scripts/pr827-predecessor-catalog.sql >"$tmp/pred-complete"; assert_line "$tmp/pred-complete" $'PREDECESSOR_CATALOG_STATE\tCOMPLETE'; echo 'POSTGRESQL_16_PREDECESSOR_STATES=COMPLETE,PARTIAL,ABSENT'

reset; sql_file scripts/pr827-schema-catalog.sql >"$tmp/pr-absent"; test ! -s "$tmp/pr-absent"
psql -c 'CREATE TYPE public."ErpOrderManualResolutionCategory" AS ENUM ($$manual_verified_not_found$$);' >/dev/null
sql_file scripts/pr827-schema-catalog.sql >"$tmp/pr-partial"; test "$(wc -l <"$tmp/pr-partial")" -eq 1; ! node scripts/pr827-schema-catalog-validate.mjs "$tmp/pr-partial" >/dev/null 2>&1
reset
psql <<'SQL' >/dev/null
CREATE TYPE public."Role" AS ENUM ('diretor');
CREATE TABLE public."ErpOrderSync" (id text PRIMARY KEY);
CREATE TABLE public."Opportunity" (id text PRIMARY KEY);
CREATE TABLE public."User" (id text PRIMARY KEY);
SQL
psql -f - <apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql >/dev/null
sql_file scripts/pr827-schema-catalog.sql >"$tmp/pr-complete"; node scripts/pr827-schema-catalog-validate.mjs "$tmp/pr-complete" >/dev/null
echo 'POSTGRESQL_16_PR827_STATES=COMPLETE,PARTIAL,ABSENT'

reset
if sql_file scripts/sql/pr827-read-only-write-rejection.sql >"$tmp/write.out" 2>"$tmp/write.err"; then echo 'read-only write unexpectedly succeeded' >&2; exit 1; fi
grep -Fq 'cannot execute CREATE TABLE in a read-only transaction' "$tmp/write.err"; test "$(psql -Atc "SELECT to_regclass('public.pr827_forbidden_write') IS NULL")" = t
echo 'READ_ONLY_ENFORCEMENT=PASS'

# Execute the exact parameterized ledger SQL used by the runner, including checksum/state projection.
psql -c 'CREATE TABLE public."_prisma_migrations" (checksum text, finished_at timestamptz, rolled_back_at timestamptz, migration_name text, started_at timestamptz); INSERT INTO public."_prisma_migrations" VALUES ($$synthetic_checksum$$,now(),NULL,$$synthetic_migration$$,now());' >/dev/null
ledger=$(psql -AtF $'\t' --set=migration_name=synthetic_migration -f - <scripts/sql/pr827-ledger-query.sql); test "$ledger" = $'synthetic_checksum\ttrue'
echo 'ALL_PREVIEW_SQL_EXECUTED_ON_POSTGRESQL_16=PASS'
echo 'PREVIEW_WRITES=NONE'
