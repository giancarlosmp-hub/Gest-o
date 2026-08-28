#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
pg="pr827-apply-pg16-${RANDOM}-$$"; net="$pg-net"; tmp=$(mktemp -d)
original_origin=$(git rev-parse refs/remotes/origin/main 2>/dev/null || :); head=$(git rev-parse HEAD)
cleanup(){ rc=$?; docker rm -f "$pg" >/dev/null 2>&1 || :; docker network rm "$net" >/dev/null 2>&1 || :; docker image rm "pr827-diff:$head" >/dev/null 2>&1 || :; if [[ -n $original_origin ]]; then git update-ref refs/remotes/origin/main "$original_origin"; else git update-ref -d refs/remotes/origin/main || :; fi; rm -rf "$tmp"; exit "$rc"; }; trap cleanup EXIT
docker network create --internal "$net" >/dev/null
docker run -d --pull=never --name "$pg" --network "$net" -e POSTGRES_PASSWORD=synthetic -e POSTGRES_DB=salesforce_pro postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$pg" pg_isready -U postgres -d salesforce_pro >/dev/null 2>&1 && break; sleep 1; done
docker exec "$pg" pg_isready -U postgres -d salesforce_pro >/dev/null
psql(){ docker exec -i "$pg" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d salesforce_pro "$@"; }
reset_db(){ psql -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public; CREATE TYPE public."Role" AS ENUM ('\''diretor'\''); CREATE TABLE public."ErpOrderSync" (id text PRIMARY KEY); CREATE TABLE public."Opportunity" (id text PRIMARY KEY); CREATE TABLE public."User" (id text PRIMARY KEY);' >/dev/null; }
git update-ref refs/remotes/origin/main "$head"
owner=$(id -un):$(id -gn); history="$tmp/history"; env_file="$tmp/env"; backup="$tmp/backup-result"
baseline_sha=$(git rev-list HEAD -- apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql | while read -r c; do [[ $(git show "$c:apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql" | sha256sum | cut -d' ' -f1) == 66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506 ]] && { echo "$c"; break; }; done)
mkdir -m 700 "$history"; printf 'DATABASE_URL=postgresql://redacted.invalid/salesforce_pro\n' >"$env_file"; printf 'PASS\n' >"$backup"; chmod 600 "$env_file" "$backup"
mkdir -p "$tmp/image/node_modules/.bin"; cat >"$tmp/image/node_modules/.bin/prisma" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$tmp/image/node_modules/.bin/prisma"; cat >"$tmp/image/Dockerfile" <<IMAGE
FROM postgres:16
LABEL org.opencontainers.image.revision=$head
COPY node_modules /node_modules
WORKDIR /
IMAGE
docker build --pull=false -q -t "pr827-diff:$head" "$tmp/image" >/dev/null
make_baseline(){
 rm -rf "$history"/*; mkdir -m 700 "$history/$baseline_sha"
 printf '%s  %s\n' 66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506 apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >"$history/$baseline_sha/migration.sha256"
 printf '2026-08-28T00:00:00Z\t%s\t%s\n' "$baseline_sha" apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >"$history/$baseline_sha/applied.tsv"
 chmod 600 "$history/$baseline_sha/"*
}
run_apply(){
 MODE=apply CONFIRM=APPLY_PR827_SCHEMA EXPECTED_SHA="$head" API_IMAGE="pr827-diff:$head" BACKUP_RESULT_FILE="$backup" \
 MIGRATION_ID_REQUESTED=20260827190000_add_erp_order_manual_resolution PRODUCTION_ENV_SOURCE=legacy_copy PRODUCTION_ENV_FILE="$env_file" \
 ERP_ENV_EXPECTED_OWNER="$owner" APPLIED_TSV_EXPECTED_OWNER="$owner" SCHEMA_EVIDENCE_DIR="$history" DATABASE_SCHEMA_MODE=external \
 PRODUCTION_DB_CONTAINER_EXPECTED="$pg" PRODUCTION_DB_NAME_EXPECTED=salesforce_pro bash scripts/pr827-schema-runner.sh
}
reset_db; make_baseline; run_apply >"$tmp/apply.out"; grep -Fxq PR827_MIGRATION_APPLY=PASS "$tmp/apply.out"; test -f "$history/$head/applied.tsv"; test "$(psql -Atc "SELECT to_regclass('public.\"ErpOrderManualResolution\"') IS NOT NULL")" = t
run_apply >"$tmp/idempotent.out"; grep -Fxq PR827_MIGRATION_IDEMPOTENCY=PASS "$tmp/idempotent.out"; echo 'REAL_RUNNER_APPLY_AND_IDEMPOTENCY=PASS'

reset_db; make_baseline; ( while [[ ! -d "$history/.pr827-$head.tmp" ]]; do sleep .01; done; : >"$history/$head" ) & racer=$!
if run_apply >"$tmp/register-fail" 2>&1; then exit 1; fi; wait "$racer"; test "$(psql -Atc "SELECT to_regclass('public.\"ErpOrderManualResolution\"') IS NULL")" = t; test ! -e "$history/$head/applied.tsv"; echo 'REGISTER_FAILURE_ROLLS_BACK_DDL=PASS'

reset_db; make_baseline; ( while [[ ! -d "$history/.pr827-$head.tmp" ]]; do sleep .01; done; psql -c 'CREATE TYPE public."ErpOrderManualResolutionCategory" AS ENUM ('\''manual_verified_not_found'\'')' >/dev/null ) & racer=$!
if run_apply >"$tmp/ddl-fail" 2>&1; then exit 1; fi; wait "$racer"; test ! -e "$history/$head/applied.tsv"; test "$(psql -Atc "SELECT to_regclass('public.\"ErpOrderManualResolution\"') IS NULL")" = t; echo 'DDL_FAILURE_WITHOUT_HISTORY=PASS'
echo 'PR827_APPLY_POSTGRES_RESULT=PASS'
