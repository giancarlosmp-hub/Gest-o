#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
name="pr827-preview-pg16-${RANDOM}-$$"; network="${name}-net"; tmp=$(mktemp -d)
original_origin=''; if git show-ref --verify --quiet refs/remotes/origin/main; then original_origin=$(git rev-parse refs/remotes/origin/main); fi
cleanup(){
  local rc=$?
  if docker container inspect "$name" >/dev/null 2>&1; then docker rm -f "$name" >/dev/null 2>&1 || rc=1; fi
  if docker network inspect "$network" >/dev/null 2>&1; then docker network rm "$network" >/dev/null 2>&1 || rc=1; fi
  rm -rf "$tmp" || rc=1
  if [[ -n $original_origin ]]; then git update-ref refs/remotes/origin/main "$original_origin"; elif git show-ref --verify --quiet refs/remotes/origin/main; then git update-ref -d refs/remotes/origin/main; fi
  return "$rc"
}; trap cleanup EXIT
docker network create --internal "$network" >/dev/null
docker run -d --pull=never --name "$name" --network "$network" -e POSTGRES_PASSWORD=synthetic -e POSTGRES_DB=salesforce_pro postgres:16 >/dev/null
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
psql <<'SQL' >/dev/null
CREATE TYPE public."Role" AS ENUM ('diretor');
CREATE TABLE public."ErpOrderSync" (id text PRIMARY KEY);
CREATE TABLE public."Opportunity" (id text PRIMARY KEY);
CREATE TABLE public."User" (id text PRIMARY KEY);
SQL
sql_file scripts/pr827-baseline-catalog.sql >"$tmp/baseline-valid"; assert_line "$tmp/baseline-valid" $'PR827_BASELINE_CATALOG_STATE\tVALID'
psql -c 'ALTER TABLE public."User" ALTER COLUMN id DROP NOT NULL' >/dev/null
sql_file scripts/pr827-baseline-catalog.sql >"$tmp/baseline-invalid"; assert_line "$tmp/baseline-invalid" $'PR827_BASELINE_CATALOG_STATE\tINVALID'
echo 'POSTGRESQL_16_REAL_BASELINE=VALID,INVALID'

# Execute the real runner against PostgreSQL 16 and protected synthetic legacy history.
reset
psql <<'SQL' >/dev/null
CREATE TYPE public."Role" AS ENUM ('diretor');
CREATE TABLE public."ErpOrderSync" (id text PRIMARY KEY);
CREATE TABLE public."Opportunity" (id text PRIMARY KEY);
CREATE TABLE public."User" (id text PRIMARY KEY);
SQL
owner=$(id -un):$(id -gn); head=$(git rev-parse HEAD); git update-ref refs/remotes/origin/main "$head"; history="$tmp/history"; env_file="$tmp/production.env"
baseline_sha=$(git rev-list HEAD -- apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql | while read -r c; do [[ $(git show "$c:apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql" | sha256sum | cut -d' ' -f1) == 66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506 ]] && { echo "$c"; break; }; done)
mkdir -m 700 "$history"; printf 'DATABASE_URL=postgresql://redacted.invalid/salesforce_pro\n' >"$env_file"; chmod 600 "$env_file"
make_baseline(){
 rm -rf "$history"/*; mkdir -m 700 "$history/$baseline_sha"
 printf '%s  %s\n' '66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506' 'apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql' >"$history/$baseline_sha/migration.sha256"
 printf '%s\t%s\t%s\n' '2026-08-28T00:00:00Z' "$baseline_sha" 'apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql' >"$history/$baseline_sha/applied.tsv"
 chmod 600 "$history/$baseline_sha/"*
}
run_runner(){
 MODE=preview EXPECTED_SHA="$head" MIGRATION_ID_REQUESTED=20260827190000_add_erp_order_manual_resolution \
 PRODUCTION_ENV_SOURCE=legacy_copy PRODUCTION_ENV_FILE="$env_file" ERP_ENV_EXPECTED_OWNER="$owner" \
 APPLIED_TSV_EXPECTED_OWNER="$owner" SCHEMA_EVIDENCE_DIR="$history" DATABASE_SCHEMA_MODE=external \
 PRODUCTION_DB_CONTAINER_EXPECTED="$name" PRODUCTION_DB_NAME_EXPECTED=salesforce_pro \
 bash scripts/pr827-schema-runner.sh
}
make_baseline; db_before=$(psql -Atc "SELECT md5(string_agg(c.relname,',' ORDER BY c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'"); history_before=$(find "$history" -type f -exec sha256sum {} + | sort | sha256sum)
run_runner >"$tmp/runner-ready"; grep -Fxq READY_TO_APPLY "$tmp/runner-ready"; ! grep -q API_IMAGE "$tmp/runner-ready"
[[ $(psql -Atc "SELECT md5(string_agg(c.relname,',' ORDER BY c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'") == "$db_before" ]]
[[ $(find "$history" -type f -exec sha256sum {} + | sort | sha256sum) == "$history_before" ]]
echo 'REAL_RUNNER_PREVIEW_READ_ONLY=PASS'
rm -rf "$history"/*; if run_runner >"$tmp/missing" 2>&1; then exit 1; fi
make_baseline; printf 'malformed\n' >"$history/$baseline_sha/applied.tsv"; if run_runner >"$tmp/malformed" 2>&1; then exit 1; fi
make_baseline; sed -i 's/^./0/' "$history/$baseline_sha/migration.sha256"; if run_runner >"$tmp/checksum" 2>&1; then exit 1; fi
make_baseline; chmod 640 "$history/$baseline_sha/applied.tsv"; if run_runner >"$tmp/mode" 2>&1; then exit 1; fi
make_baseline; mv "$history/$baseline_sha/applied.tsv" "$history/$baseline_sha/real.tsv"; ln -s real.tsv "$history/$baseline_sha/applied.tsv"; if run_runner >"$tmp/symlink" 2>&1; then exit 1; fi
echo 'REAL_RUNNER_LEGACY_HISTORY_FAILURES=PASS'

reset
readonly_rc=0
if sql_file scripts/sql/pr827-read-only-write-rejection.sql >"$tmp/write.out" 2>"$tmp/write.err"; then
  echo 'read-only write unexpectedly succeeded' >&2
  exit 1
else
  readonly_rc=$?
fi
if (( readonly_rc == 0 )); then echo 'read-only rejection returned an invalid zero status' >&2; exit 1; fi
if ! grep -Eq '^psql:<stdin>:[0-9]+: ERROR:  25006: cannot execute CREATE TABLE in a read-only transaction$' "$tmp/write.err"; then
  printf 'unexpected read-only probe failure (psql exit %d)\n' "$readonly_rc" >&2
  cat "$tmp/write.err" >&2
  exit "$readonly_rc"
fi
test "$(psql -Atc "SELECT to_regclass('public.pr827_forbidden_write') IS NULL")" = t
echo 'READ_ONLY_ENFORCEMENT=PASS'

# Execute the exact parameterized ledger SQL used by the runner, including checksum/state projection.
psql -c 'CREATE TABLE public."_prisma_migrations" (checksum text, finished_at timestamptz, rolled_back_at timestamptz, migration_name text, started_at timestamptz); INSERT INTO public."_prisma_migrations" VALUES ($$synthetic_checksum$$,now(),NULL,$$synthetic_migration$$,now());' >/dev/null
ledger=$(psql -AtF $'\t' --set=migration_name=synthetic_migration -f - <scripts/sql/pr827-ledger-query.sql); test "$ledger" = $'synthetic_checksum\tt'
echo 'ALL_PREVIEW_SQL_EXECUTED_ON_POSTGRESQL_16=PASS'
echo 'PREVIEW_WRITES=NONE'
echo 'PR827_PREVIEW_POSTGRES_RESULT=PASS'
