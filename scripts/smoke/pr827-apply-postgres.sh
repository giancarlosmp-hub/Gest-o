#!/usr/bin/env bash
set -Eeuo pipefail
exec 3>&2
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
pg="pr827-apply-pg16-${RANDOM}-$$"; net="$pg-net"; HARNESS_TEMP_ROOT=$(TMPDIR=/tmp mktemp -d)
case "$(realpath "$HARNESS_TEMP_ROOT")/" in "$(realpath "$ROOT")/"*) echo 'HARNESS_TEMP_ROOT_INSIDE_CHECKOUT=FAIL' >&2; exit 1;; esac
echo 'HARNESS_TEMP_ROOT=EXTERNAL_MKTEMP'; head=$(git rev-parse HEAD)
cleanup(){
 local operation_rc=$? cleanup_rc=0 final_rc
 trap - EXIT
 if docker container inspect "$pg" >/dev/null 2>&1; then if ! docker rm -f "$pg" >/dev/null 2>&1; then cleanup_rc=1; fi; fi
 if docker network inspect "$net" >/dev/null 2>&1; then if ! docker network rm "$net" >/dev/null 2>&1; then cleanup_rc=1; fi; fi
 if docker image inspect "pr827-diff:$head" >/dev/null 2>&1; then if ! docker image rm "pr827-diff:$head" >/dev/null 2>&1; then cleanup_rc=1; fi; fi
 if ! rm -rf "$HARNESS_TEMP_ROOT"; then cleanup_rc=1; fi
 final_rc=$operation_rc; (( cleanup_rc == 0 )) || final_rc=$cleanup_rc
 printf 'APPLY_HARNESS_OPERATION_RC=%s\nAPPLY_HARNESS_CLEANUP_RC=%s\nAPPLY_HARNESS_FINAL_RC=%s\n' "$operation_rc" "$cleanup_rc" "$final_rc" >&3
 exit "$final_rc"
}; trap cleanup EXIT
emit_stage(){ local stage=$1 rc=$2 result=PASS; (( rc == 0 )) || result=FAIL; printf 'APPLY_STAGE=%s\nAPPLY_STAGE_RC=%s\nAPPLY_STAGE_RESULT=%s\n' "$stage" "$rc" "$result" >&3; }
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
owner=$(id -un):$(id -gn); fixture_expected_owner=$owner; history="$HARNESS_TEMP_ROOT/history"; env_file="$HARNESS_TEMP_ROOT/env"; backup_root="$HARNESS_TEMP_ROOT/backup"; backup="$backup_root/latest/result.tsv"
baseline_sha=$(git rev-list HEAD -- apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql | while read -r c; do [[ $(git show "$c:apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql" | sha256sum | cut -d' ' -f1) == 66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506 ]] && { echo "$c"; break; }; done)
mkdir -m 700 "$history"; printf 'DATABASE_URL=postgresql://redacted.invalid/salesforce_pro\n' >"$env_file"; chmod 600 "$env_file"
source "$HARNESS_EXECUTION_CHECKOUT/scripts/lib/pr827-backup-proof.sh"
export PR827_BACKUP_PROOF_ROOT="$backup_root" PR827_BACKUP_PROOF_EXPECTED_OWNER="$owner"
printf '%s\nCREATE TABLE synthetic_backup_fixture(id integer);\n' 'PostgreSQL database dump' >"$HARNESS_TEMP_ROOT/synthetic-backup.sql"
gzip -c "$HARNESS_TEMP_ROOT/synthetic-backup.sql" >"$HARNESS_TEMP_ROOT/synthetic-backup.sql.gz"
fixture_generation=0
publish_backup_fixture(){
 fixture_generation=$((fixture_generation + 1))
 printf '%s\nCREATE TABLE synthetic_backup_fixture(id integer);\n-- fixture generation %s\n' 'PostgreSQL database dump' "$fixture_generation" >"$HARNESS_TEMP_ROOT/synthetic-backup.sql" || return $?
 gzip -c "$HARNESS_TEMP_ROOT/synthetic-backup.sql" >"$HARNESS_TEMP_ROOT/synthetic-backup.sql.gz" || return $?
 pr827_backup_proof_publish "$HARNESS_TEMP_ROOT/synthetic-backup.sql.gz" "$head" "$backup" 3600 || return $?
 pr827_backup_proof_validate "$backup" "$head" 3600 || return $?
}
run_fixture_operation(){
 local stage=$1 command=$2 rc; shift 2
 printf 'BACKUP_FIXTURE_OPERATION_STAGE=%s\nBACKUP_FIXTURE_OPERATION_COMMAND=%s\nBACKUP_FIXTURE_OPERATION_STATUS=STARTED\n' "$stage" "$command" >&3
 set +e
 "$@"
 rc=$?
 set -e
 if (( rc != 0 )); then
  printf 'BACKUP_FIXTURE_OPERATION_STAGE=%s\nBACKUP_FIXTURE_OPERATION_COMMAND=%s\nBACKUP_FIXTURE_OPERATION_STATUS=FAIL\nBACKUP_FIXTURE_OPERATION_RC=%s\n' "$stage" "$command" "$rc" >&3
  return "$rc"
 fi
 printf 'BACKUP_FIXTURE_OPERATION_STAGE=%s\nBACKUP_FIXTURE_OPERATION_COMMAND=%s\nBACKUP_FIXTURE_OPERATION_STATUS=PASS\nBACKUP_FIXTURE_OPERATION_RC=0\n' "$stage" "$command" >&3
}
resolve_backup_fixture_paths(){
 pr827_backup_proof_validate "$backup" "$head" 3600
 fixture_dump=$PR827_BACKUP_RESOLVED_DUMP
 fixture_manifest=$PR827_BACKUP_RESOLVED_MANIFEST
 fixture_bundle=$PR827_BACKUP_RESOLVED_BUNDLE_ID
 [[ -e "$fixture_dump" && -f "$fixture_dump" && ! -L "$fixture_dump" ]]
 fixture_dump_real=$(realpath "$fixture_dump")
 fixture_bundle_root=$(realpath "$backup_root/bundles/$fixture_bundle")
 case "$fixture_dump_real" in "$HARNESS_TEMP_ROOT"/*) ;; *) return 1;; esac
 [[ "$fixture_dump_real" == "$fixture_bundle_root/dump.sql.gz" ]]
 [[ "$fixture_manifest" == "$fixture_bundle_root/dump.sql.gz.sha256" ]]
}
if pr827_backup_proof_publish "$HARNESS_TEMP_ROOT/synthetic-backup.sql.gz" "$head" "$backup" 3600; then actual_rc=0; else actual_rc=$?; fi
emit_stage BACKUP_FIXTURE_PUBLISH "$actual_rc"; (( actual_rc == 0 ))
echo BACKUP_FIXTURE_CONTRACT=PASS
if pr827_backup_proof_validate "$backup" "$head" 3600; then actual_rc=0; else actual_rc=$?; fi
emit_stage BACKUP_FIXTURE_VALIDATE "$actual_rc"; (( actual_rc == 0 ))
echo BACKUP_FIXTURE_FINAL_VALIDATION=PASS
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
  PR827_BACKUP_FIXTURE_ROOT="$HARNESS_TEMP_ROOT" PR827_BACKUP_FIXTURE_EXPECTED_OWNER="$fixture_expected_owner" \
  MIGRATION_ID_REQUESTED=20260827190000_add_erp_order_manual_resolution PRODUCTION_ENV_SOURCE=legacy_copy PRODUCTION_ENV_FILE="$env_file" \
  ERP_ENV_EXPECTED_OWNER="$owner" APPLIED_TSV_EXPECTED_OWNER="$owner" SCHEMA_EVIDENCE_DIR="$history" DATABASE_SCHEMA_MODE=external \
 PRODUCTION_DB_CONTAINER_EXPECTED="$pg" PRODUCTION_DB_NAME_EXPECTED=salesforce_pro ERP_PRODUCTION_ENV_SOURCE=legacy_build_only bash "$HARNESS_EXECUTION_CHECKOUT/scripts/pr827-schema-runner.sh"; then rc=0; else rc=$?; fi
 assert_clean_worktree AFTER; return "$rc"
}
printf 'BACKUP_OVERRIDE_REQUESTED=YES\n'
fixture_real=$(realpath "$HARNESS_TEMP_ROOT"); checkout_real=$(realpath "$HARNESS_EXECUTION_CHECKOUT"); result_parent_real=$(realpath "$backup_root/latest")
if [[ "$fixture_real" == /tmp/* ]]; then override_root_rc=0; echo BACKUP_OVERRIDE_HARNESS_ROOT_CLASS=EXTERNAL_TMP; else override_root_rc=1; echo BACKUP_OVERRIDE_HARNESS_ROOT_CLASS=REJECTED; fi
if [[ "$checkout_real" == "$fixture_real/checkout" ]]; then override_checkout_rc=0; echo BACKUP_OVERRIDE_CHECKOUT_CLASS=EXPECTED_DISPOSABLE_CHECKOUT; else override_checkout_rc=1; echo BACKUP_OVERRIDE_CHECKOUT_CLASS=REJECTED; fi
if [[ "$result_parent_real/result.tsv" == "$fixture_real/backup/latest/result.tsv" ]]; then override_result_rc=0; echo BACKUP_OVERRIDE_RESULT_CLASS=EXPECTED_DISPOSABLE_BACKUP_RESULT; else override_result_rc=1; echo BACKUP_OVERRIDE_RESULT_CLASS=REJECTED; fi
override_rc=$((override_root_rc | override_checkout_rc | override_result_rc)); emit_stage RUNNER_OVERRIDE_AUTHORIZATION "$override_rc"
if (( override_rc == 0 )); then echo BACKUP_OVERRIDE_AUTHORIZATION=PASS; else echo BACKUP_OVERRIDE_AUTHORIZATION=FAIL; exit "$override_rc"; fi
assert_backup_rejected(){
 local label=$1 rc stage="BACKUP_NEGATIVE_${1^^}"
 set +e
 run_apply >"$HARNESS_TEMP_ROOT/backup-negative-$label.out" 2>&1
 rc=$?
 set -e
 if (( rc == 0 )); then emit_stage "$stage" 1; echo APPLY_EXPECTED_ERROR_ABSENT=protected_backup_proof_required >&3; return 1; fi
 if grep -Fq '[pr827-schema] ERROR protected backup proof required' "$HARNESS_TEMP_ROOT/backup-negative-$label.out"; then
  emit_stage "$stage" 0
 else
  emit_stage "$stage" 1
  awk '/^(\[pr827-schema\] ERROR|BACKUP_|PR827_|OVERRIDE_|TRANSACTION_|CATALOG_|POST_DIFF_)/' "$HARNESS_TEMP_ROOT/backup-negative-$label.out" >&3
  echo APPLY_EXPECTED_ERROR_ABSENT=protected_backup_proof_required >&3
  return 1
 fi
 run_fixture_operation "RESTORE_${label^^}" publish_backup_fixture publish_backup_fixture
}
# Backup-negative runner calls must start from the same valid baseline as the
# real apply. Previously they failed at legacy-history validation before ever
# reaching the deliberately damaged backup proof.
reset_db; make_baseline
rm "$backup"; assert_backup_rejected absent
resolve_backup_fixture_paths; rm "$fixture_dump"; assert_backup_rejected dump_absent
resolve_backup_fixture_paths; printf 'tampered\n' >>"$fixture_dump"; assert_backup_rejected checksum_divergent
resolve_backup_fixture_paths; rm "$fixture_manifest"; assert_backup_rejected manifest_absent
resolve_backup_fixture_paths; printf 'invalid manifest\n' >"$fixture_manifest"; assert_backup_rejected manifest_invalid
run_fixture_operation PREPARE_TIMESTAMP_EXPIRED sed_created_at sed -i "s/^CREATED_AT_EPOCH.*/CREATED_AT_EPOCH\t$(( $(date +%s) - 7200 ))/" "$backup"; assert_backup_rejected timestamp_expired
run_fixture_operation PREPARE_SHA_MISMATCH sed_sha sed -i 's/^SHA.*/SHA\t0000000000000000000000000000000000000000/' "$backup"; assert_backup_rejected sha_mismatch
run_fixture_operation PREPARE_DATABASE_MISMATCH sed_database sed -i 's/^DATABASE.*/DATABASE\tother_database/' "$backup"; assert_backup_rejected database_mismatch
run_fixture_operation PREPARE_MODE_INVALID chmod_result chmod 644 "$backup"; assert_backup_rejected mode_invalid
select_invalid_owner(){ if [[ $owner == root:root ]]; then fixture_expected_owner=nobody:nogroup; else fixture_expected_owner=root:root; fi; }
run_fixture_operation PREPARE_OWNER_INVALID select_invalid_owner select_invalid_owner
assert_backup_rejected owner_invalid
restore_expected_owner(){ fixture_expected_owner=$owner; }
run_fixture_operation RESTORE_EXPECTED_OWNER restore_expected_owner restore_expected_owner
prepare_result_symlink(){ mv "$backup" "$HARNESS_TEMP_ROOT/real-result.tsv" && ln -s "$HARNESS_TEMP_ROOT/real-result.tsv" "$backup"; }
run_fixture_operation PREPARE_SYMLINK prepare_result_symlink prepare_result_symlink; assert_backup_rejected symlink
echo BACKUP_NEGATIVE_CASES=PASS
reset_db; make_baseline
if run_apply >"$HARNESS_TEMP_ROOT/apply.out" 2>&1; then actual_rc=0; else actual_rc=$?; fi
emit_stage RUNNER_INITIAL_APPLY "$actual_rc"
if (( actual_rc != 0 )); then awk '/^(\[pr827-schema\] ERROR|BACKUP_|PR827_|OVERRIDE_|TRANSACTION_|CATALOG_|POST_DIFF_)/' "$HARNESS_TEMP_ROOT/apply.out" >&3; echo APPLY_EXPECTED_MARKER_ABSENT=PR827_MIGRATION_APPLY_PASS >&3; exit "$actual_rc"; fi
grep -Fxq PR827_MIGRATION_APPLY=PASS "$HARNESS_TEMP_ROOT/apply.out"; test -f "$history/$head/applied.tsv"; test "$(psql -Atc "SELECT to_regclass('public.\"ErpOrderManualResolution\"') IS NOT NULL")" = t; emit_stage CATALOG_VALIDATION 0
if run_apply >"$HARNESS_TEMP_ROOT/idempotent.out" 2>&1; then actual_rc=0; else actual_rc=$?; fi
emit_stage IDEMPOTENT_APPLY "$actual_rc"; (( actual_rc == 0 )); grep -Fxq PR827_MIGRATION_IDEMPOTENCY=PASS "$HARNESS_TEMP_ROOT/idempotent.out"; echo 'REAL_RUNNER_APPLY_AND_IDEMPOTENCY=PASS'; echo APPLY_IDEMPOTENCY=PASS

reset_db; make_baseline; ( while [[ ! -d "$history/.pr827-$head.tmp" ]]; do sleep .01; done; : >"$history/$head" ) & racer=$!
if run_apply >"$HARNESS_TEMP_ROOT/register-fail" 2>&1; then actual_rc=0; else actual_rc=$?; fi; (( actual_rc != 0 )); wait "$racer"; test "$(psql -Atc "SELECT to_regclass('public.\"ErpOrderManualResolution\"') IS NULL")" = t; test ! -e "$history/$head/applied.tsv"; echo 'REGISTER_FAILURE_ROLLS_BACK_DDL=PASS'; emit_stage ROLLBACK_PUBLICATION_FAILURE 0

reset_db; make_baseline; ( while [[ ! -d "$history/.pr827-$head.tmp" ]]; do sleep .01; done; psql -c 'CREATE TYPE public."ErpOrderManualResolutionCategory" AS ENUM ('\''manual_verified_not_found'\'')' >/dev/null ) & racer=$!
if run_apply >"$HARNESS_TEMP_ROOT/ddl-fail" 2>&1; then actual_rc=0; else actual_rc=$?; fi; (( actual_rc != 0 )); wait "$racer"; test ! -e "$history/$head/applied.tsv"; test "$(psql -Atc "SELECT to_regclass('public.\"ErpOrderManualResolution\"') IS NULL")" = t; echo 'DDL_FAILURE_WITHOUT_HISTORY=PASS'; emit_stage DDL_FAILURE_WITHOUT_HISTORY 0
echo APPLY_ROLLBACK_CASES=PASS
test "$(psql -Atc "SELECT to_regclass('public.\"_prisma_migrations\"') IS NULL")" = t; echo PRISMA_LEDGER_CREATED=NO
echo 'PR827_APPLY_POSTGRES_RESULT=PASS'
assert_clean_worktree AFTER
primary_origin_main_after=ABSENT; if git -C "$ROOT" show-ref --verify --quiet refs/remotes/origin/main; then primary_origin_main_after=$(git -C "$ROOT" rev-parse refs/remotes/origin/main); fi
[[ $primary_origin_main_after == "$primary_origin_main_before" ]]
echo 'PRIMARY_CHECKOUT_REFS_MODIFIED=NO'
