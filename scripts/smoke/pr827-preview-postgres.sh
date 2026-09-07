#!/usr/bin/env bash
set -Eeuo pipefail
exec 3>&2
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
name="pr827-preview-pg16-${RANDOM}-$$"; network="${name}-net"; HARNESS_TEMP_ROOT=$(TMPDIR=/tmp mktemp -d)
HARNESS_CONTAINER_CREATED=0; HARNESS_NETWORK_CREATED=0; HARNESS_IMAGE_CREATED=0; HARNESS_TEMP_CREATED=1
case "$(realpath "$HARNESS_TEMP_ROOT")/" in "$(realpath "$ROOT")/"*) echo 'HARNESS_TEMP_ROOT_INSIDE_CHECKOUT=FAIL' >&2; exit 1;; esac
echo 'HARNESS_TEMP_ROOT=EXTERNAL_MKTEMP'
source scripts/lib/pr827-preview-harness-cleanup.sh
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'pr827_preview_harness_cleanup "$?"' EXIT
docker network create --internal "$network" >/dev/null
HARNESS_NETWORK_CREATED=1
docker run -d --pull=never --name "$name" --network "$network" -e POSTGRES_PASSWORD=synthetic -e POSTGRES_DB=salesforce_pro postgres:16 >/dev/null
HARNESS_CONTAINER_CREATED=1
for _ in {1..60}; do docker exec "$name" pg_isready -U postgres -d salesforce_pro >/dev/null 2>&1 && break; sleep 1; done
docker exec "$name" pg_isready -U postgres -d salesforce_pro >/dev/null
harness_psql(){ docker exec -i "$name" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d salesforce_pro "$@"; }
sql_file(){ harness_psql -AtF $'\t' -f - <"$1"; }
reset(){ harness_psql -c 'DROP SCHEMA IF EXISTS other CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;' >/dev/null; }
diagnose(){ local path=$1 out=$2; docker exec -e PGOPTIONS="-c search_path=$path" -i "$name" psql -X -qAtF $'\t' -v ON_ERROR_STOP=1 -U postgres -d salesforce_pro -f - <scripts/sql/pr827-connection-diagnostics.sql >"$out"; }
assert_line(){ grep -Fqx "$2" "$1" || { echo "missing sanitized classification: $2" >&2; exit 1; }; }
assert_clean_worktree(){
  local phase=$1 status line code path_class primary_status
  primary_status=$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)
  status=$(git -C "$HARNESS_EXECUTION_CHECKOUT" status --porcelain=v1 --untracked-files=all)
  [[ -z $primary_status ]] || status="${status}${status:+$'\n'}${primary_status}"
  if [[ -n $status ]]; then
    printf 'HARNESS_WORKTREE_%s=FAIL\n' "$phase" >&3
    while IFS= read -r line; do
      code=${line:0:2}
      case "$code" in
        '??') path_class=UNTRACKED ;;
        ' M'|'M '|'MM') path_class=TRACKED_MODIFIED ;;
        ' A'|'A ') path_class=TRACKED_ADDED ;;
        ' D'|'D ') path_class=TRACKED_DELETED ;;
        *) path_class=TRACKED_OTHER ;;
      esac
      printf 'HARNESS_DIRTY_PATH_CLASS=%s PATH=%s\n' "$path_class" "${line:3}" >&3
    done <<<"$status"
    return 1
  fi
  printf 'HARNESS_WORKTREE_%s=PASS\n' "$phase" >&3
}

reset; diagnose 'public' "$HARNESS_TEMP_ROOT/absent"; assert_line "$HARNESS_TEMP_ROOT/absent" $'PRISMA_LEDGER_LOCATION\tABSENT'; assert_line "$HARNESS_TEMP_ROOT/absent" $'SEARCH_PATH_CLASS\tPUBLIC_FIRST'; assert_line "$HARNESS_TEMP_ROOT/absent" $'TRANSACTION_ACCESS_CLASS\tREAD_ONLY'
echo 'POSTGRESQL_16_LEDGER_ABSENT=PASS'
harness_psql -c 'CREATE TABLE public."_prisma_migrations" (checksum text, finished_at timestamptz, rolled_back_at timestamptz, migration_name text, started_at timestamptz);' >/dev/null
diagnose 'public' "$HARNESS_TEMP_ROOT/public"; assert_line "$HARNESS_TEMP_ROOT/public" $'PRISMA_LEDGER_LOCATION\tPUBLIC'; echo 'POSTGRESQL_16_LEDGER_PUBLIC=PASS'
reset; harness_psql -c 'CREATE SCHEMA other; CREATE TABLE other."_prisma_migrations" (id text);' >/dev/null
diagnose 'other,public' "$HARNESS_TEMP_ROOT/other"; assert_line "$HARNESS_TEMP_ROOT/other" $'PRISMA_LEDGER_LOCATION\tOTHER_SCHEMA_REDACTED'; assert_line "$HARNESS_TEMP_ROOT/other" $'SEARCH_PATH_CLASS\tPUBLIC_INCLUDED'; echo 'POSTGRESQL_16_LEDGER_OTHER_SCHEMA=PASS'

reset
sql_file scripts/pr827-predecessor-catalog.sql >"$HARNESS_TEMP_ROOT/pred-absent"; assert_line "$HARNESS_TEMP_ROOT/pred-absent" $'PREDECESSOR_CATALOG_STATE\tABSENT'
harness_psql -c 'CREATE TABLE public."KnowledgeDocument" ("tenantId" text);' >/dev/null
sql_file scripts/pr827-predecessor-catalog.sql >"$HARNESS_TEMP_ROOT/pred-partial"; assert_line "$HARNESS_TEMP_ROOT/pred-partial" $'PREDECESSOR_CATALOG_STATE\tPARTIAL'
reset
harness_psql <<'SQL' >/dev/null
CREATE TABLE public."Tenant" (id text PRIMARY KEY);
DO $fixture$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['KnowledgeDocument','Client','AgendaEvent','Goal','ActivityKPI','Sale','SellerTerritoryCity','AppConfig','Product','ErpSyncRun','ErpSyncLock'] LOOP
  EXECUTE format('CREATE TABLE public.%I (id text PRIMARY KEY, "tenantId" text)',n);
  EXECUTE format('CREATE INDEX %I ON public.%I ("tenantId")',n||'_tenantId_idx',n);
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)',n,n||'_tenantId_fkey');
 END LOOP;
END $fixture$;
SQL
sql_file scripts/pr827-predecessor-catalog.sql >"$HARNESS_TEMP_ROOT/pred-complete"; assert_line "$HARNESS_TEMP_ROOT/pred-complete" $'PREDECESSOR_CATALOG_STATE\tCOMPLETE'; echo 'POSTGRESQL_16_PREDECESSOR_STATES=COMPLETE,PARTIAL,ABSENT'

reset; sql_file scripts/pr827-schema-catalog.sql >"$HARNESS_TEMP_ROOT/pr-absent"; test ! -s "$HARNESS_TEMP_ROOT/pr-absent"
harness_psql -c 'CREATE TYPE public."ErpOrderManualResolutionCategory" AS ENUM ($$manual_verified_not_found$$);' >/dev/null
sql_file scripts/pr827-schema-catalog.sql >"$HARNESS_TEMP_ROOT/pr-partial"; test "$(wc -l <"$HARNESS_TEMP_ROOT/pr-partial")" -eq 1; ! node scripts/pr827-schema-catalog-validate.mjs "$HARNESS_TEMP_ROOT/pr-partial" >/dev/null 2>&1
reset
harness_psql <<'SQL' >/dev/null
CREATE TYPE public."Role" AS ENUM ('diretor');
CREATE TABLE public."ErpOrderSync" (id text PRIMARY KEY);
CREATE TABLE public."Opportunity" (id text PRIMARY KEY);
CREATE TABLE public."User" (id text PRIMARY KEY);
SQL
harness_psql -f - <apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql >/dev/null
sql_file scripts/pr827-schema-catalog.sql >"$HARNESS_TEMP_ROOT/pr-complete"; node scripts/pr827-schema-catalog-validate.mjs "$HARNESS_TEMP_ROOT/pr-complete" >/dev/null
echo 'POSTGRESQL_16_PR827_STATES=COMPLETE,PARTIAL,ABSENT'

reset
harness_psql <<'SQL' >/dev/null
CREATE TYPE public."Role" AS ENUM ('diretor');
CREATE TABLE public."ErpOrderSync" (id text PRIMARY KEY);
CREATE TABLE public."Opportunity" (id text PRIMARY KEY);
CREATE TABLE public."User" (id text PRIMARY KEY);
SQL
sql_file scripts/pr827-baseline-catalog.sql >"$HARNESS_TEMP_ROOT/baseline-valid"; assert_line "$HARNESS_TEMP_ROOT/baseline-valid" $'PR827_BASELINE_CATALOG_STATE\tVALID'
erp_order_sync_pk=$(harness_psql -Atc "SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname='ErpOrderSync' AND c.contype='p'")
[[ "$erp_order_sync_pk" == ErpOrderSync_pkey ]]
harness_psql -c 'ALTER TABLE public."ErpOrderSync" DROP CONSTRAINT "ErpOrderSync_pkey"' >/dev/null
sql_file scripts/pr827-baseline-catalog.sql >"$HARNESS_TEMP_ROOT/baseline-invalid"; assert_line "$HARNESS_TEMP_ROOT/baseline-invalid" $'PR827_BASELINE_CATALOG_STATE\tINVALID'
echo 'POSTGRESQL_16_REAL_BASELINE=VALID,INVALID'

# Execute the real runner against PostgreSQL 16 and protected synthetic legacy history.
reset
harness_psql <<'SQL' >/dev/null
CREATE TYPE public."Role" AS ENUM ('diretor');
CREATE TABLE public."ErpOrderSync" (id text PRIMARY KEY);
CREATE TABLE public."Opportunity" (id text PRIMARY KEY);
CREATE TABLE public."User" (id text PRIMARY KEY);
SQL
owner=$(id -un):$(id -gn); head=$(git rev-parse HEAD); expected_main_sha=$head; HARNESS_EXECUTION_CHECKOUT="$HARNESS_TEMP_ROOT/checkout"
primary_origin_main_before=ABSENT; if git -C "$ROOT" show-ref --verify --quiet refs/remotes/origin/main; then primary_origin_main_before=$(git -C "$ROOT" rev-parse refs/remotes/origin/main); fi
git clone --quiet --no-hardlinks "$ROOT" "$HARNESS_EXECUTION_CHECKOUT"
git -C "$HARNESS_EXECUTION_CHECKOUT" switch --detach "$head" >/dev/null
git -C "$HARNESS_EXECUTION_CHECKOUT" update-ref refs/remotes/origin/main "$expected_main_sha"
harness_head=$(git -C "$HARNESS_EXECUTION_CHECKOUT" rev-parse HEAD); harness_origin_main=$(git -C "$HARNESS_EXECUTION_CHECKOUT" rev-parse refs/remotes/origin/main)
[[ $harness_head == "$head" && $expected_main_sha == "$head" && $harness_origin_main == "$head" ]]
printf 'HARNESS_HEAD_SHA=%s\nHARNESS_EXPECTED_MAIN_SHA=%s\nHARNESS_ORIGIN_MAIN_SHA=%s\n' "$harness_head" "$expected_main_sha" "$harness_origin_main"
history="$HARNESS_TEMP_ROOT/history"; env_file="$HARNESS_TEMP_ROOT/production.env"
baseline_sha=$(git rev-list HEAD -- apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql | while read -r c; do [[ $(git show "$c:apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql" | sha256sum | cut -d' ' -f1) == 66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506 ]] && { echo "$c"; break; }; done)
mkdir -m 700 "$history"; printf 'DATABASE_URL=postgresql://redacted.invalid/salesforce_pro\n' >"$env_file"; chmod 600 "$env_file"
make_baseline(){
 rm -rf "$history"/*; mkdir -m 700 "$history/$baseline_sha"
 printf '%s  %s\n' '66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506' 'apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql' >"$history/$baseline_sha/migration.sha256"
 printf '%s\t%s\t%s\n' '2026-08-28T00:00:00Z' "$baseline_sha" 'apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql' >"$history/$baseline_sha/applied.tsv"
 chmod 600 "$history/$baseline_sha/"*
}
run_runner(){
 local rc
 assert_clean_worktree BEFORE
 if MODE=preview EXPECTED_SHA="$head" MIGRATION_ID_REQUESTED=20260827190000_add_erp_order_manual_resolution \
  PRODUCTION_ENV_SOURCE=legacy_copy PRODUCTION_ENV_FILE="$env_file" ERP_ENV_EXPECTED_OWNER="$owner" \
  APPLIED_TSV_EXPECTED_OWNER="$owner" SCHEMA_EVIDENCE_DIR="$history" DATABASE_SCHEMA_MODE=external \
  PRODUCTION_DB_CONTAINER_EXPECTED="$name" PRODUCTION_DB_NAME_EXPECTED=salesforce_pro \
  ERP_PRODUCTION_ENV_SOURCE=legacy_build_only bash "$HARNESS_EXECUTION_CHECKOUT/scripts/pr827-schema-runner.sh"; then rc=0; else rc=$?; fi
 assert_clean_worktree AFTER
 return "$rc"
}
make_baseline; db_before=$(harness_psql -Atc "SELECT md5(string_agg(c.relname,',' ORDER BY c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'"); history_before=$(find "$history" -type f -exec sha256sum {} + | sort | sha256sum)
run_runner >"$HARNESS_TEMP_ROOT/runner-ready"; grep -Fxq READY_TO_APPLY "$HARNESS_TEMP_ROOT/runner-ready"; ! grep -q API_IMAGE "$HARNESS_TEMP_ROOT/runner-ready"
[[ $(harness_psql -Atc "SELECT md5(string_agg(c.relname,',' ORDER BY c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'") == "$db_before" ]]
[[ $(find "$history" -type f -exec sha256sum {} + | sort | sha256sum) == "$history_before" ]]
echo 'REAL_RUNNER_PREVIEW_READ_ONLY=PASS'
rm -rf "$history"/*; if run_runner >"$HARNESS_TEMP_ROOT/missing" 2>&1; then exit 1; fi
make_baseline; printf 'malformed\n' >"$history/$baseline_sha/applied.tsv"; if run_runner >"$HARNESS_TEMP_ROOT/malformed" 2>&1; then exit 1; fi
make_baseline; sed -i 's/^./0/' "$history/$baseline_sha/migration.sha256"; if run_runner >"$HARNESS_TEMP_ROOT/checksum" 2>&1; then exit 1; fi
make_baseline; chmod 640 "$history/$baseline_sha/applied.tsv"; if run_runner >"$HARNESS_TEMP_ROOT/mode" 2>&1; then exit 1; fi
make_baseline; mv "$history/$baseline_sha/applied.tsv" "$history/$baseline_sha/real.tsv"; ln -s real.tsv "$history/$baseline_sha/applied.tsv"; if run_runner >"$HARNESS_TEMP_ROOT/symlink" 2>&1; then exit 1; fi
echo 'REAL_RUNNER_LEGACY_HISTORY_FAILURES=PASS'

reset
readonly_rc=0
if sql_file scripts/sql/pr827-read-only-write-rejection.sql >"$HARNESS_TEMP_ROOT/write.out" 2>"$HARNESS_TEMP_ROOT/write.err"; then
  echo 'read-only write unexpectedly succeeded' >&2
  exit 1
else
  readonly_rc=$?
fi
if (( readonly_rc == 0 )); then echo 'read-only rejection returned an invalid zero status' >&2; exit 1; fi
if ! grep -Eq '^psql:<stdin>:[0-9]+: ERROR:  25006: cannot execute CREATE TABLE in a read-only transaction$' "$HARNESS_TEMP_ROOT/write.err"; then
  printf 'unexpected read-only probe failure (harness_psql exit %d)\n' "$readonly_rc" >&2
  cat "$HARNESS_TEMP_ROOT/write.err" >&2
  exit "$readonly_rc"
fi
test "$(harness_psql -Atc "SELECT to_regclass('public.pr827_forbidden_write') IS NULL")" = t
echo 'READ_ONLY_ENFORCEMENT=PASS'

# Execute the exact parameterized ledger SQL used by the runner, including checksum/state projection.
harness_psql -c 'CREATE TABLE public."_prisma_migrations" (checksum text, finished_at timestamptz, rolled_back_at timestamptz, migration_name text, started_at timestamptz); INSERT INTO public."_prisma_migrations" VALUES ($$synthetic_checksum$$,now(),NULL,$$synthetic_migration$$,now());' >/dev/null
ledger=$(harness_psql -AtF $'\t' --set=migration_name=synthetic_migration -f - <scripts/sql/pr827-ledger-query.sql); test "$ledger" = $'synthetic_checksum\tt'
echo 'ALL_PREVIEW_SQL_EXECUTED_ON_POSTGRESQL_16=PASS'
echo 'PREVIEW_WRITES=NONE'
echo 'PR827_PREVIEW_POSTGRES_RESULT=PASS'
assert_clean_worktree AFTER
primary_origin_main_after=ABSENT; if git -C "$ROOT" show-ref --verify --quiet refs/remotes/origin/main; then primary_origin_main_after=$(git -C "$ROOT" rev-parse refs/remotes/origin/main); fi
[[ $primary_origin_main_after == "$primary_origin_main_before" ]]
echo 'PRIMARY_CHECKOUT_REFS_MODIFIED=NO'
exit 0
