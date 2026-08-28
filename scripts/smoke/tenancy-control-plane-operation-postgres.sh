#!/usr/bin/env bash
set -eEuo pipefail
umask 077
HARNESS_STEP=bootstrap
HARNESS_COMMAND="initialize harness"
HARNESS_REPORTED=0
harness_error(){
  local rc=$?
  trap - ERR
  HARNESS_REPORTED=1
  printf 'HARNESS_STEP=%s\nHARNESS_COMMAND=%s\nHARNESS_RESULT=FAIL\nEXIT_CODE=%s\n' "$HARNESS_STEP" "$HARNESS_COMMAND" "$rc" >&2
  exit "$rc"
}
step(){ HARNESS_STEP=$1; HARNESS_COMMAND=$2; }
trap harness_error ERR
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
sha=$(git rev-parse HEAD); image=${API_IMAGE:-gest-o-api:$sha}
docker image inspect "$image" >/dev/null 2>&1 || { echo "SKIP: pinned API image unavailable: $image" >&2; exit 77; }
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image") == "$sha" ]] || { echo 'image SHA mismatch' >&2; exit 1; }
[[ -z ${DATABASE_URL:-} && -z ${TEST_DATABASE_URL:-} ]] || { echo 'refusing inherited database URL' >&2; exit 1; }
HOST_UID="$(id -u)"; HOST_GID="$(id -g)"
printf 'HOST_IDENTITY\tuid=%s\tgid=%s\n' "$HOST_UID" "$HOST_GID" >&2
step temporary_directory "create private temporary directory"
id="$$-$RANDOM"; net="gesto-op-net-$id"; ref="gesto-op-ref-$id"; path="gesto-op-path-$id"; tmp=$(mktemp -d); catalog_file="$tmp/catalog.tsv"; control_schema="$tmp/control-plane.prisma"
postgres_diagnostics(){
  local c inspect_rc logs_rc
  for c in "$ref" "$path"; do
    printf '===== POSTGRES DIAGNOSTICS container=%s =====\n' "$c" >&2
    set +e
    docker inspect --format 'status={{.State.Status}} running={{.State.Running}} exit_code={{.State.ExitCode}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} network='"$net"' attached={{with index .NetworkSettings.Networks "'"$net"'"}}{{.NetworkID}}{{else}}missing{{end}} ports={{json .NetworkSettings.Ports}}' "$c" >&2
    inspect_rc=$?
    docker logs --timestamps "$c" >&2
    logs_rc=$?
    set -e
    printf 'POSTGRES_DIAGNOSTICS_RESULT container=%s inspect_exit=%s logs_exit=%s auth_probe=tcp-password database=gesto port=5432\n' "$c" "$inspect_rc" "$logs_rc" >&2
  done
}
cleanup(){
  local cleanup_rc=0 c
  set +e
  for c in "$ref" "$path"; do
    docker rm -f "$c" >/dev/null 2>&1
    (( $? == 0 )) || cleanup_rc=1
  done
  docker network rm "$net" >/dev/null 2>&1
  (( $? == 0 )) || cleanup_rc=1
  rm -rf "$tmp"
  (( $? == 0 )) || cleanup_rc=1
  set -e
  return "$cleanup_rc"
}
finish(){
  local rc=$?
  if (( rc != 0 )); then postgres_diagnostics; fi
  if ! cleanup; then
    printf 'HARNESS_CLEANUP=FAIL\n' >&2
    (( rc != 0 )) || rc=1
  fi
  if (( rc != 0 && HARNESS_REPORTED == 0 )); then
    printf 'HARNESS_STEP=%s\nHARNESS_COMMAND=%s\nHARNESS_RESULT=FAIL\nEXIT_CODE=%s\n' "$HARNESS_STEP" "$HARNESS_COMMAND" "$rc" >&2
  fi
  return "$rc"
}
trap finish EXIT
step docker_network "create internal Docker network"
docker network create --internal "$net" >/dev/null
step postgres_containers "start disposable PostgreSQL 16 containers"
for c in "$ref" "$path"; do docker run -d --pull=never --name "$c" --network "$net" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=gesto postgres:16 >/dev/null; done
step postgres_readiness "wait for authenticated disposable PostgreSQL SQL readiness"
for c in "$ref" "$path"; do
  ready=false
  for readiness_attempt in {1..60}; do
    if ! [[ $(docker inspect --format '{{.State.Running}}' "$c") == true ]]; then break; fi
    if docker exec -e PGPASSWORD=test "$c" psql -X -h 127.0.0.1 -p 5432 -U postgres -d gesto -v ON_ERROR_STOP=1 -qAt -c 'SELECT 1;' >"$tmp/$c.readiness.out" 2>"$tmp/$c.readiness.err" &&
      [[ ! -s "$tmp/$c.readiness.err" ]] && grep -Fqx '1' "$tmp/$c.readiness.out"; then
      ready=true
      break
    fi
    sleep 1
  done
  [[ "$ready" == true ]]
  HARNESS_COMMAND="validate final authenticated SQL connection for $c"
  docker exec -e PGPASSWORD=test "$c" psql -X -h 127.0.0.1 -p 5432 -U postgres -d gesto -v ON_ERROR_STOP=1 -qAt -c 'SELECT current_database(), current_user;' >"$tmp/$c.readiness-final.out" 2>"$tmp/$c.readiness-final.err"
  [[ ! -s "$tmp/$c.readiness-final.err" ]]
  grep -Fqx 'gesto|postgres' "$tmp/$c.readiness-final.out"
done
refurl="postgresql://postgres:test@$ref:5432/gesto?schema=public"; pathurl="postgresql://postgres:test@$path:5432/gesto?schema=public"
run_api(){ local url=$1; shift; docker run --rm --pull=never --network "$net" -e DATABASE_URL="$url" "$@"; }
# Both schemas are registry-validated historical snapshots. The current datamodel may contain later expands.
step predecessor_resolution "resolve registered predecessor and control-plane intro schemas"
node scripts/resolve-control-plane-predecessor.mjs --write-schema "$tmp/predecessor.prisma" --write-intro-schema "$control_schema" >"$tmp/predecessor.json"
step reference_materialization "materialize registered control-plane intro schema"
docker run --rm --pull=never --network "$net" -e DATABASE_URL="$refurl" -v "$control_schema:/tmp/schema.prisma:ro" "$image" ./node_modules/.bin/prisma db push --schema /tmp/schema.prisma --skip-generate >/dev/null
[[ $(sha256sum "$tmp/predecessor.prisma"|awk '{print $1}') == $(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).predecessorSchemaSha256)' "$tmp/predecessor.json") ]]
step predecessor_materialization "materialize registered predecessor schema"
docker run --rm --pull=never --network "$net" -e DATABASE_URL="$pathurl" -v "$tmp/predecessor.prisma:/tmp/schema.prisma:ro" "$image" ./node_modules/.bin/prisma db push --schema /tmp/schema.prisma --skip-generate >/dev/null
test "$(docker exec "$path" psql -U postgres -d gesto -Atc "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('Tenant','TenantMembership')")" = 0
incident_tables=(
  incident_20260718_client_enrichment_audit incident_20260718_client_map
  incident_20260718_june_client_source incident_20260718_recovery_audit
  incident_20260719_erp_code_enrichment_audit incident_20260719_erp_partner_client_map
  incident_20260719_orphan_productprice_audit incident_20260719_product_snapshot_map
)
for table in "${incident_tables[@]}"; do
  docker exec "$path" psql -X -U postgres -d gesto -v ON_ERROR_STOP=1 -c "CREATE TABLE \"$table\" (id integer)" >/dev/null
done
step control_plane_preview "diff predecessor against registered control-plane intro schema"
docker run --rm --pull=never --network "$net" -e DATABASE_URL="$pathurl" -v "$control_schema:/tmp/control-plane.prisma:ro" "$image" ./node_modules/.bin/prisma migrate diff --from-url "$pathurl" --to-schema-datamodel /tmp/control-plane.prisma --script >"$tmp/pre-apply-diff.raw.sql"
node scripts/schema-diff-filter.mjs "$tmp/pre-apply-diff.raw.sql" "$tmp/pre-apply-diff.sql" pre
for table in "${incident_tables[@]}"; do
  grep -Fq "DROP TABLE \"$table\";" "$tmp/pre-apply-diff.raw.sql"
done
! grep -Fq 'incident_' "$tmp/pre-apply-diff.sql"
grep -Eq 'CREATE (TYPE|TABLE)' "$tmp/pre-apply-diff.sql"
test "$(docker exec "$path" psql -U postgres -d gesto -Atc "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname = ANY (ARRAY['Tenant','TenantMembership'])")" = 0
test "$(docker exec "$path" psql -U postgres -d gesto -Atc "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'incident\\_%' ESCAPE '\\'")" = 8
printf 'CONTROL_PLANE_PREVIEW_STATE=ABSENT_COMPATIBLE\n' >&2
docker exec -i "$path" psql -X -U postgres -d gesto -v ON_ERROR_STOP=1 -1 <apps/api/prisma/migrations/20260802120000_tenancy_control_plane/migration.sql >/dev/null
if ! docker exec -i "$path" psql \
  -X \
  -U postgres \
  -d gesto \
  -v ON_ERROR_STOP=1 \
  --no-align \
  --tuples-only \
  --field-separator=$'\t' \
  --pset=pager=off \
  <scripts/control-plane-catalog.sql >"$catalog_file"; then
  printf '%s\n' '===== CATALOG QUERY FAILED =====' >&2
  exit 1
fi
detail_sql_type=$(awk -F '\t' '$1=="meta" && $2=="detail_sql_type" { print $4 }' "$catalog_file")
printf 'CATALOG_DETAIL_SQL_TYPE=%s\n' "$detail_sql_type" >&2
if [[ "$detail_sql_type" != text ]]; then
  printf 'CATALOG_DETAIL_TYPE_MISMATCH:%s\n' "${detail_sql_type:-missing}" >&2
  exit 1
fi
if ! awk -F '\t' '
  BEGIN {
    expected["TenantMembership_tenantId_fkey"] = "source_schema=public;source=TenantMembership;source_columns=tenantId;target_schema=public;target=Tenant;target_columns=id;delete=RESTRICT;update=CASCADE;validated=true"
    expected["TenantMembership_userId_fkey"] = "source_schema=public;source=TenantMembership;source_columns=userId;target_schema=public;target=User;target_columns=id;delete=RESTRICT;update=CASCADE;validated=true"
  }
  $1 == "fk" {
    seen[$2] = 1
    printf "FK_TSV_META\tname=%s\tfields=%d\ttotal_bytes=%d\tdetail_bytes=%d\n", $2, NF, length($0), length($4) > "/dev/stderr"
    if (!($2 in expected) || NF != 4 || $4 != expected[$2]) {
      failed = 1
      printf "CATALOG_FK_DETAIL_INCOMPLETE:%s\n", $2 > "/dev/stderr"
      printf "FK_DETAIL[%s]=%s\n", $2, $4 > "/dev/stderr"
    }
  }
  END {
    for (name in expected) if (!(name in seen)) {
      failed = 1
      printf "CATALOG_FK_DETAIL_INCOMPLETE:%s\n", name > "/dev/stderr"
      printf "FK_DETAIL[%s]=MISSING\n", name > "/dev/stderr"
    }
    exit failed
  }
' "$catalog_file"; then
  awk -F '\t' '$1=="fk" { print "===== FK ROW HEX " $2 " ====="; print $0 | "od -An -tx1c >&2"; close("od -An -tx1c >&2") }' "$catalog_file" >&2
  exit 1
fi
if ! node scripts/control-plane-catalog-validate.mjs "$catalog_file" >/dev/null; then
  printf '%s\n' '===== ACTUAL FK CATALOG ROWS =====' >&2
  awk -F '\t' '$1=="fk" && ($2=="TenantMembership_tenantId_fkey" || $2=="TenantMembership_userId_fkey")' "$catalog_file" >&2
  exit 1
fi
step post_apply_diff "diff applied control plane against registered intro schema"
docker run --rm --pull=never --network "$net" -e DATABASE_URL="$pathurl" -v "$control_schema:/tmp/control-plane.prisma:ro" "$image" ./node_modules/.bin/prisma migrate diff --from-url "$pathurl" --to-schema-datamodel /tmp/control-plane.prisma --script >"$tmp/post.raw.sql"
node scripts/schema-diff-filter.mjs "$tmp/post.raw.sql" "$tmp/post.sql" post
test -z "$(sed '/^[[:space:]]*--/d;/^[[:space:]]*$/d' "$tmp/post.sql")"
test "$(docker exec "$path" psql -U postgres -d gesto -Atc "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'incident\\_%' ESCAPE '\\'")" = 8
if docker exec -i "$path" psql -X -U postgres -d gesto -v ON_ERROR_STOP=1 -1 <apps/api/prisma/migrations/20260802120000_tenancy_control_plane/migration.sql >/dev/null 2>&1; then echo 'literal reapply succeeded' >&2; exit 1; fi
docker exec "$path" psql -U postgres -d gesto -v ON_ERROR_STOP=1 -c 'CREATE ROLE runtime_test LOGIN; GRANT USAGE ON SCHEMA public TO runtime_test' >/dev/null
if docker exec "$path" psql -U runtime_test -d gesto -c 'CREATE TABLE permission_probe(id int)' >/dev/null 2>&1; then echo 'runtime CREATE succeeded' >&2; exit 1; fi
# Catalog mutations exercise partial/divergent enum, table, column/type/default/nullability, index, FK and CHECK.
for pattern in '^enum\tTenantStatus' '^table\tTenant' '^column\tTenant.id' '^index\tTenant_slug_key' '^fk\tTenantMembership_tenantId_fkey' '^check\tTenantMembership_version_positive'; do
  awk -v p="$pattern" '$0 !~ p' "$catalog_file" >"$tmp/bad.tsv"
  if node scripts/control-plane-catalog-validate.mjs "$tmp/bad.tsv" >/dev/null 2>&1; then echo "catalog mutation accepted: $pattern" >&2; exit 1; fi
done
sed '0,/active/{s/active/divergent/}' "$catalog_file" >"$tmp/bad.tsv"; ! node scripts/control-plane-catalog-validate.mjs "$tmp/bad.tsv" >/dev/null 2>&1
sed '0,/text|text|NO|/{s/text|text|NO|/integer|int4|YES|0/}' "$catalog_file" >"$tmp/bad.tsv"; ! node scripts/control-plane-catalog-validate.mjs "$tmp/bad.tsv" >/dev/null 2>&1
fail(){ HARNESS_COMMAND="assertion failed: $1"; return 1; }
checkpoint(){ printf 'HARNESS_CHECKPOINT\t%s\n' "$1" >&2; }
docker exec -i "$path" psql \
  -X \
  -U postgres \
  -d gesto \
  -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "User" (id,name,email,"passwordHash",role,"isActive","createdAt") VALUES
('op-d','Synthetic','d@example.invalid','x','diretor',true,now()),('op-g','Synthetic','g@example.invalid','x','gerente',true,now()),('op-v','Synthetic','v@example.invalid','x','vendedor',false,now());
SQL
synthetic_user_count=$(docker exec "$path" psql -X -U postgres -d gesto -Atc 'SELECT count(*) FROM "User"') || fail SYNTHETIC_FIXTURE_COUNT_QUERY_FAILED
printf 'SYNTHETIC_USER_COUNT_BEFORE_DRY_RUN=%s\n' "$synthetic_user_count" >&2
[[ "$synthetic_user_count" == 3 ]] || fail "SYNTHETIC_FIXTURE_SETUP_FAILED:$synthetic_user_count"
read -r synthetic_diretor_count synthetic_gerente_count synthetic_vendedor_count < <(docker exec "$path" psql -X -U postgres -d gesto -AtF ' ' -c 'SELECT count(*) FILTER (WHERE role=$$diretor$$), count(*) FILTER (WHERE role=$$gerente$$), count(*) FILTER (WHERE role=$$vendedor$$) FROM "User"') || fail SYNTHETIC_ROLE_COUNTS_QUERY_FAILED
printf 'SYNTHETIC_ROLE_COUNTS diretor=%s gerente=%s vendedor=%s\n' "$synthetic_diretor_count" "$synthetic_gerente_count" "$synthetic_vendedor_count" >&2
[[ "$synthetic_diretor_count" == 1 && "$synthetic_gerente_count" == 1 && "$synthetic_vendedor_count" == 1 ]] || fail "SYNTHETIC_ROLE_COUNTS_MISMATCH:$synthetic_diretor_count:$synthetic_gerente_count:$synthetic_vendedor_count"
checkpoint synthetic_fixture_ready
attempt_one_files=(metadata.tsv dry-run-result.tsv result.tsv apply.tsv reconciliation.tsv)
attempt_two_files=(metadata.tsv result.tsv apply.tsv reconciliation.tsv)
validate_evidence_file(){
  local evidence_dir=$1 evidence_file=$2 owner_uid owner_gid mode size
  [[ -f "$evidence_dir/$evidence_file" ]] || fail "EVIDENCE_FILE_MISSING:$evidence_file"
  read -r owner_uid owner_gid mode size < <(stat -c '%u %g %a %s' "$evidence_dir/$evidence_file")
  printf 'EVIDENCE_STAT\tname=%s\tuid=%s\tgid=%s\tmode=%s\tsize=%s\n' "$evidence_file" "$owner_uid" "$owner_gid" "$mode" "$size" >&2
  [[ "$owner_uid" == "$HOST_UID" && "$owner_gid" == "$HOST_GID" ]] || fail "EVIDENCE_OWNER_MISMATCH:$evidence_file"
  (( (8#$mode & 8#007) == 0 )) || fail "EVIDENCE_MODE_UNSAFE:$evidence_file"
}
evidence="$tmp/evidence-attempt-1"; mkdir -m 700 "$evidence"
printf 'EVIDENCE_DIRECTORY\t' >&2; stat -c '%u:%g %a %n' "$evidence" >&2
docker image inspect --format 'IMAGE_CONFIG_USER\t{{json .Config.User}}' "$image" >&2
docker run --rm --pull=never "$image" id >&2
runner(){ run_api "$pathurl" --user "$HOST_UID:$HOST_GID" -e APP_COMMIT="$sha" -e EXPECTED_SHA="$sha" -e TENANCY_MODE=default-only -e EVIDENCE_DIR=/evidence -v "$evidence:/evidence" ${CONFIRM:+-e CONFIRM} ${EXPECTED_AGGREGATE_HASH:+-e EXPECTED_AGGREGATE_HASH} "$image" node apps/api/dist/scripts/prepareDefaultTenant.js "$@"; }
runner --dry-run >/dev/null
checkpoint dry_run_completed
[[ -f "$evidence/dry-run-result.tsv" ]] || fail EVIDENCE_FILE_MISSING:dry-run-result.tsv
printf 'DRY_RUN_RESULT\t' >&2; stat -c '%u:%g %a %n' "$evidence/dry-run-result.tsv" >&2 || fail EVIDENCE_STAT_FAILED:dry-run-result.tsv
for evidence_file in metadata.tsv dry-run-result.tsv; do validate_evidence_file "$evidence" "$evidence_file"; done
[[ $(stat -c '%u:%g %a' "$evidence") == "$HOST_UID:$HOST_GID 700" ]] || fail EVIDENCE_DIRECTORY_OWNER_OR_MODE_MISMATCH
checkpoint evidence_permissions_pass
tenant_count_after_dry_run=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "Tenant"') || fail TENANT_COUNT_AFTER_DRY_RUN_QUERY_FAILED
printf 'TENANT_COUNT_AFTER_DRY_RUN=%s\n' "$tenant_count_after_dry_run" >&2
[[ "$tenant_count_after_dry_run" == 0 ]] || fail "TENANT_CREATED_DURING_DRY_RUN:$tenant_count_after_dry_run"
EXPECTED_AGGREGATE_HASH=$(awk -F '\t' 'NR==1{for(i=1;i<=NF;i++)h[$i]=i} NR==2&&h["expectedAggregateHash"]{print $h["expectedAggregateHash"]}' "$evidence/dry-run-result.tsv") || fail DRY_RUN_HASH_PARSE_FAILED
[[ -n "$EXPECTED_AGGREGATE_HASH" ]] || fail DRY_RUN_HASH_MISSING
printf 'EXPECTED_AGGREGATE_HASH_LENGTH=%s\n' "${#EXPECTED_AGGREGATE_HASH}" >&2
[[ "$EXPECTED_AGGREGATE_HASH" =~ ^[0-9a-f]{64}$ ]] || fail DRY_RUN_HASH_INVALID
printf 'EXPECTED_AGGREGATE_HASH_FORMAT=PASS\n' >&2
checkpoint dry_run_hash_pass
export EXPECTED_AGGREGATE_HASH CONFIRM=PREPARE_DEFAULT_TENANT
checkpoint apply_start
set +e
runner --apply >/dev/null
apply_rc=$?
set -e
(( apply_rc == 0 )) || fail "APPLY_RUNNER_FAILED:$apply_rc"
checkpoint apply_completed
for evidence_file in "${attempt_one_files[@]}"; do validate_evidence_file "$evidence" "$evidence_file"; done
checkpoint apply_evidence_permissions_pass
tenant_count_after_apply=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "Tenant"') || fail TENANT_COUNT_AFTER_APPLY_QUERY_FAILED
membership_count_after_apply=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "TenantMembership"') || fail MEMBERSHIP_COUNT_AFTER_APPLY_QUERY_FAILED
user_count_after_apply=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "User"') || fail USER_COUNT_AFTER_APPLY_QUERY_FAILED
printf 'TENANT_COUNT_AFTER_APPLY=%s\nMEMBERSHIP_COUNT_AFTER_APPLY=%s\nUSER_COUNT_AFTER_APPLY=%s\n' "$tenant_count_after_apply" "$membership_count_after_apply" "$user_count_after_apply" >&2
[[ "$tenant_count_after_apply" == 1 ]] || fail "TENANT_COUNT_MISMATCH:$tenant_count_after_apply"
[[ "$membership_count_after_apply" == "$user_count_after_apply" ]] || fail "MEMBERSHIP_USER_COUNT_MISMATCH:$membership_count_after_apply:$user_count_after_apply"
[[ "$user_count_after_apply" == 3 && "$membership_count_after_apply" == 3 ]] || fail "SYNTHETIC_FIXTURE_COUNT_MISMATCH:$user_count_after_apply:$membership_count_after_apply"
default_identity_count=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "Tenant" WHERE id=$$tenant-default-v1$$ AND slug=$$default-v1$$ AND status=$$active$$') || fail DEFAULT_TENANT_IDENTITY_QUERY_FAILED
unexpected_tenant_count=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "Tenant" WHERE id<>$$tenant-default-v1$$') || fail UNEXPECTED_TENANT_QUERY_FAILED
printf 'DEFAULT_TENANT_IDENTITY_COUNT=%s\nUNEXPECTED_TENANT_COUNT=%s\n' "$default_identity_count" "$unexpected_tenant_count" >&2
[[ "$default_identity_count" == 1 ]] || fail DEFAULT_TENANT_IDENTITY_MISMATCH
[[ "$unexpected_tenant_count" == 0 ]] || fail "UNEXPECTED_TENANT_COUNT:$unexpected_tenant_count"
checkpoint apply_reconciliation_pass
first_aggregate_hash=$(awk -F '\t' 'NR==1{for(i=1;i<=NF;i++)h[$i]=i} NR==2&&h["aggregateHash"]{print $h["aggregateHash"]}' "$evidence/result.tsv") || fail FIRST_RESULT_HASH_PARSE_FAILED
[[ "$first_aggregate_hash" =~ ^[0-9a-f]{64}$ ]] || fail FIRST_RESULT_HASH_INVALID
checkpoint idempotent_reapply_start
first_evidence="$evidence"
for evidence_file in "${attempt_one_files[@]}"; do validate_evidence_file "$first_evidence" "$evidence_file"; done
first_result_sha256=$(sha256sum "$first_evidence/result.tsv" | awk '{print $1}') || fail FIRST_RESULT_CHECKSUM_FAILED
evidence="$tmp/evidence-attempt-2"; mkdir -m 700 "$evidence"
set +e
runner --apply >/dev/null
reapply_rc=$?
set -e
(( reapply_rc == 0 )) || fail "IDEMPOTENT_REAPPLY_RUNNER_FAILED:$reapply_rc"
checkpoint idempotent_reapply_completed
for evidence_file in "${attempt_two_files[@]}"; do validate_evidence_file "$evidence" "$evidence_file"; done
for evidence_file in "${attempt_one_files[@]}"; do validate_evidence_file "$first_evidence" "$evidence_file"; done
first_result_sha256_after=$(sha256sum "$first_evidence/result.tsv" | awk '{print $1}') || fail FIRST_RESULT_CHECKSUM_REVALIDATION_FAILED
[[ "$first_result_sha256_after" == "$first_result_sha256" ]] || fail FIRST_PASS_EVIDENCE_CHANGED
second_aggregate_hash=$(awk -F '\t' 'NR==1{for(i=1;i<=NF;i++)h[$i]=i} NR==2&&h["aggregateHash"]{print $h["aggregateHash"]}' "$evidence/result.tsv") || fail SECOND_RESULT_HASH_PARSE_FAILED
[[ "$second_aggregate_hash" == "$first_aggregate_hash" ]] || fail IDEMPOTENT_AGGREGATE_HASH_MISMATCH
printf 'IDEMPOTENT_AGGREGATE_HASH_MATCH=PASS\n' >&2
second_tenant_count=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "Tenant"') || fail SECOND_TENANT_COUNT_QUERY_FAILED
second_membership_count=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "TenantMembership"') || fail SECOND_MEMBERSHIP_COUNT_QUERY_FAILED
second_user_count=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "User"') || fail SECOND_USER_COUNT_QUERY_FAILED
printf 'SECOND_TENANT_COUNT=%s\nSECOND_MEMBERSHIP_COUNT=%s\nSECOND_USER_COUNT=%s\n' "$second_tenant_count" "$second_membership_count" "$second_user_count" >&2
[[ "$second_tenant_count" == 1 ]] || fail "IDEMPOTENT_TENANT_COUNT_MISMATCH:$second_tenant_count"
[[ "$second_membership_count" == 3 ]] || fail "IDEMPOTENT_MEMBERSHIP_COUNT_MISMATCH:$second_membership_count"
[[ "$second_user_count" == 3 ]] || fail "IDEMPOTENT_USER_COUNT_MISMATCH:$second_user_count"
second_default_identity_count=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "Tenant" WHERE id=$$tenant-default-v1$$ AND slug=$$default-v1$$ AND status=$$active$$') || fail SECOND_DEFAULT_TENANT_IDENTITY_QUERY_FAILED
second_unexpected_tenant_count=$(docker exec "$path" psql -U postgres -d gesto -Atc 'SELECT count(*) FROM "Tenant" WHERE id<>$$tenant-default-v1$$') || fail SECOND_UNEXPECTED_TENANT_QUERY_FAILED
[[ "$second_default_identity_count" == 1 ]] || fail SECOND_DEFAULT_TENANT_IDENTITY_MISMATCH
[[ "$second_unexpected_tenant_count" == 0 ]] || fail "SECOND_UNEXPECTED_TENANT_COUNT:$second_unexpected_tenant_count"
checkpoint idempotency_pass
printf 'TENANCY_CONTROL_PLANE_OPERATION_POSTGRES=PASS\n'
