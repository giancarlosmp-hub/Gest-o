#!/usr/bin/env bash
set -Eeuo pipefail
exec 3>&2
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
pg="pr827-apply-pg16-${RANDOM}-$$"; net="$pg-net"; HARNESS_TEMP_ROOT=$(TMPDIR=/tmp mktemp -d)
case "$(realpath "$HARNESS_TEMP_ROOT")/" in "$(realpath "$ROOT")/"*) echo 'HARNESS_TEMP_ROOT_INSIDE_CHECKOUT=FAIL' >&2; exit 1;; esac
echo 'HARNESS_TEMP_ROOT=EXTERNAL_MKTEMP'; head=$(git rev-parse HEAD)
cleanup(){ rc=$?; if docker container inspect "$pg" >/dev/null 2>&1; then if ! docker rm -f "$pg" >/dev/null 2>&1; then rc=1; fi; fi; if docker network inspect "$net" >/dev/null 2>&1; then if ! docker network rm "$net" >/dev/null 2>&1; then rc=1; fi; fi; if docker image inspect "pr827-diff:$head" >/dev/null 2>&1; then if ! docker image rm "pr827-diff:$head" >/dev/null 2>&1; then rc=1; fi; fi; if ! rm -rf "$HARNESS_TEMP_ROOT"; then rc=1; fi; exit "$rc"; }; trap cleanup EXIT
docker network create --internal "$net" >/dev/null
docker run -d --pull=never --name "$pg" --network "$net" -e POSTGRES_PASSWORD=synthetic -e POSTGRES_DB=salesforce_pro postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$pg" pg_isready -U postgres -d salesforce_pro >/dev/null 2>&1 && break; sleep 1; done
docker exec "$pg" pg_isready -U postgres -d salesforce_pro >/dev/null
psql(){ docker exec -i "$pg" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d salesforce_pro "$@"; }
reset_db(){ psql -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public; CREATE TYPE public."Role" AS ENUM ('\''diretor'\''); CREATE TABLE public."ErpOrderSync" (id text PRIMARY KEY); CREATE TABLE public."Opportunity" (id text PRIMARY KEY); CREATE TABLE public."User" (id text PRIMARY KEY);' >/dev/null; }
assert_clean_worktree(){ local phase=$1 status line code path_class primary_status; primary_status=$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all); status=$(git -C "$HARNESS_EXECUTION_CHECKOUT" status --porcelain=v1 --untracked-files=all); [[ -z $primary_status ]] || status="${status}${status:+$'\n'}${primary_status}"; if [[ -n $status ]]; then printf 'HARNESS_WORKTREE_%s=FAIL\n' "$phase" >&3; while IFS= read -r line; do code=${line:0:2}; case "$code" in '??') path_class=UNTRACKED ;; ' M'|'M '|'MM') path_class=TRACKED_MODIFIED ;; ' A'|'A ') path_class=TRACKED_ADDED ;; ' D'|'D ') path_class=TRACKED_DELETED ;; *) path_class=TRACKED_OTHER ;; esac; printf 'HARNESS_DIRTY_PATH_CLASS=%s PATH=%s\n' "$path_class" "${line:3}" >&3; done <<<"$status"; return 1; fi; printf 'HARNESS_WORKTREE_%s=PASS\n' "$phase" >&3; }
expected_main_sha=$head; HARNESS_EXECUTION_CHECKOUT="$HARNESS_TEMP_ROOT/checkout"
primary_origin_main_before=ABSENT; if git -C "$ROOT" show-ref --verify --quiet refs/remotes/origin/main; then primary_origin_main_before=$(git -C "$ROOT" rev-parse refs/remotes/origin/main); fi
git clone --quiet --no-hardlinks "$ROOT" "$HARNESS_EXECUTION_CHECKOUT"
git -C "$HARNESS_EXECUTION_CHECKOUT" switch --detach "$head" >/dev/null
git -C "$HARNESS_EXECUTION_CHECKOUT" update-ref refs/remotes/origin/main "$expected_main_sha"
harness_head=$(git -C "$HARNESS_EXECUTION_CHECKOUT" rev-parse HEAD); harness_origin_main=$(git -C "$HARNESS_EXECUTION_CHECKOUT" rev-parse refs/remotes/origin/main)
[[ $harness_head == "$head" && $expected_main_sha == "$head" && $harness_origin_main == "$head" ]]
printf 'HARNESS_HEAD_SHA=%s\nHARNESS_EXPECTED_MAIN_SHA=%s\nHARNESS_ORIGIN_MAIN_SHA=%s\n' "$harness_head" "$expected_main_sha" "$harness_origin_main"
owner=$(id -un):$(id -gn); history="$HARNESS_TEMP_ROOT/history"; env_file="$HARNESS_TEMP_ROOT/env"; backup="$HARNESS_TEMP_ROOT/backup-result"
baseline_sha=$(git rev-list HEAD -- apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql | while read -r c; do [[ $(git show "$c:apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql" | sha256sum | cut -d' ' -f1) == 66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506 ]] && { echo "$c"; break; }; done)
mkdir -m 700 "$history"; printf 'DATABASE_URL=postgresql://redacted.invalid/salesforce_pro\n' >"$env_file"; printf 'PASS\n' >"$backup"; chmod 600 "$env_file" "$backup"
mkdir -p "$HARNESS_TEMP_ROOT/image/node_modules/.bin"; cat >"$HARNESS_TEMP_ROOT/image/node_modules/.bin/prisma" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$HARNESS_TEMP_ROOT/image/node_modules/.bin/prisma"; cat >"$HARNESS_TEMP_ROOT/image/Dockerfile" <<IMAGE
FROM postgres:16
LABEL org.opencontainers.image.revision=$head
COPY node_modules /node_modules
WORKDIR /
IMAGE
docker build --pull=false -q -t "pr827-diff:$head" "$HARNESS_TEMP_ROOT/image" >/dev/null
make_baseline(){
 rm -rf "$history"/*; mkdir -m 700 "$history/$baseline_sha"
 printf '%s  %s\n' 66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506 apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >"$history/$baseline_sha/migration.sha256"
 printf '2026-08-28T00:00:00Z\t%s\t%s\n' "$baseline_sha" apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql >"$history/$baseline_sha/applied.tsv"
 chmod 600 "$history/$baseline_sha/"*
}
run_apply(){
 local rc; assert_clean_worktree BEFORE
 if MODE=apply CONFIRM=APPLY_PR827_SCHEMA EXPECTED_SHA="$head" API_IMAGE="pr827-diff:$head" BACKUP_RESULT_FILE="$backup" \
  MIGRATION_ID_REQUESTED=20260827190000_add_erp_order_manual_resolution PRODUCTION_ENV_SOURCE=legacy_copy PRODUCTION_ENV_FILE="$env_file" \
  ERP_ENV_EXPECTED_OWNER="$owner" APPLIED_TSV_EXPECTED_OWNER="$owner" SCHEMA_EVIDENCE_DIR="$history" DATABASE_SCHEMA_MODE=external \
  PRODUCTION_DB_CONTAINER_EXPECTED="$pg" PRODUCTION_DB_NAME_EXPECTED=salesforce_pro bash "$HARNESS_EXECUTION_CHECKOUT/scripts/pr827-schema-runner.sh"; then rc=0; else rc=$?; fi
 assert_clean_worktree AFTER; return "$rc"
}
reset_db; make_baseline; run_apply >"$HARNESS_TEMP_ROOT/apply.out"; grep -Fxq PR827_MIGRATION_APPLY=PASS "$HARNESS_TEMP_ROOT/apply.out"; test -f "$history/$head/applied.tsv"; test "$(psql -Atc "SELECT to_regclass('public.\"ErpOrderManualResolution\"') IS NOT NULL")" = t
run_apply >"$HARNESS_TEMP_ROOT/idempotent.out"; grep -Fxq PR827_MIGRATION_IDEMPOTENCY=PASS "$HARNESS_TEMP_ROOT/idempotent.out"; echo 'REAL_RUNNER_APPLY_AND_IDEMPOTENCY=PASS'

reset_db; make_baseline; ( while [[ ! -d "$history/.pr827-$head.tmp" ]]; do sleep .01; done; : >"$history/$head" ) & racer=$!
if run_apply >"$HARNESS_TEMP_ROOT/register-fail" 2>&1; then exit 1; fi; wait "$racer"; test "$(psql -Atc "SELECT to_regclass('public.\"ErpOrderManualResolution\"') IS NULL")" = t; test ! -e "$history/$head/applied.tsv"; echo 'REGISTER_FAILURE_ROLLS_BACK_DDL=PASS'

reset_db; make_baseline; ( while [[ ! -d "$history/.pr827-$head.tmp" ]]; do sleep .01; done; psql -c 'CREATE TYPE public."ErpOrderManualResolutionCategory" AS ENUM ('\''manual_verified_not_found'\'')' >/dev/null ) & racer=$!
if run_apply >"$HARNESS_TEMP_ROOT/ddl-fail" 2>&1; then exit 1; fi; wait "$racer"; test ! -e "$history/$head/applied.tsv"; test "$(psql -Atc "SELECT to_regclass('public.\"ErpOrderManualResolution\"') IS NULL")" = t; echo 'DDL_FAILURE_WITHOUT_HISTORY=PASS'
echo 'PR827_APPLY_POSTGRES_RESULT=PASS'
assert_clean_worktree AFTER
primary_origin_main_after=ABSENT; if git -C "$ROOT" show-ref --verify --quiet refs/remotes/origin/main; then primary_origin_main_after=$(git -C "$ROOT" rev-parse refs/remotes/origin/main); fi
[[ $primary_origin_main_after == "$primary_origin_main_before" ]]
echo 'PRIMARY_CHECKOUT_REFS_MODIFIED=NO'
