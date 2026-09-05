#!/usr/bin/env bash
set -eEuo pipefail
HARNESS_STEP=bootstrap
HARNESS_COMMAND="initialize tenancy expand harness"
HARNESS_REPORTED=0
harness_error(){ local rc=$?; trap - ERR; HARNESS_REPORTED=1; printf 'HARNESS_STEP=%s\nHARNESS_COMMAND=%s\nHARNESS_RESULT=FAIL\nEXIT_CODE=%s\n' "$HARNESS_STEP" "$HARNESS_COMMAND" "$rc" >&2; exit "$rc"; }
step(){ HARNESS_STEP=$1; HARNESS_COMMAND=$2; printf 'HARNESS_CHECKPOINT=%s\n' "$HARNESS_STEP" >&2; }
trap harness_error ERR
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
sha=$(git rev-parse HEAD); image=${API_IMAGE:-gest-o-api:$sha}
docker image inspect "$image" >/dev/null 2>&1 || { echo 'required pinned API tooling image unavailable' >&2; exit 1; }
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image") == "$sha" ]] || { echo 'API tooling image SHA mismatch' >&2; exit 1; }
[[ -z ${DATABASE_URL:-} && -z ${TEST_DATABASE_URL:-} ]] || { echo 'refusing inherited database URL' >&2; exit 1; }
step temporary_directory "create private temporary directory"
id="$$-$RANDOM"; pg="gesto-expand-pg-$id"; net="gesto-expand-net-$id"; tmp=$(mktemp -d)
cleanup(){ docker rm -f "$pg" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
finish(){ local rc=$?; cleanup; if (( rc != 0 && HARNESS_REPORTED == 0 )); then printf 'HARNESS_STEP=%s\nHARNESS_COMMAND=%s\nHARNESS_RESULT=FAIL\nEXIT_CODE=%s\n' "$HARNESS_STEP" "$HARNESS_COMMAND" "$rc" >&2; fi; return "$rc"; }
trap finish EXIT
step predecessor_resolution "resolve schema immediately before registered expand migration"
mapfile -t intro_commits < <(git log --all --format=%H --diff-filter=A -- apps/api/prisma/migrations/20260808120000_tenancy_expand_roots/migration.sql)
[[ ${#intro_commits[@]} == 1 ]]
predecessor_commit=$(git rev-parse "${intro_commits[0]}^")
git show "$predecessor_commit:apps/api/prisma/schema.prisma" > "$tmp/predecessor.prisma"
manual_intro_commit=$(git log --all --format=%H --diff-filter=A -- apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql)
[[ -n "$manual_intro_commit" && "$manual_intro_commit" != *$'\n'* ]]
git show "$manual_intro_commit:apps/api/prisma/schema.prisma" > "$tmp/tenancy-boundary.prisma"
step docker_network_setup "create internal Docker network"
docker network create --internal "$net" >/dev/null
step postgres_start "start disposable PostgreSQL 16"
docker run -d --rm --pull=never --name "$pg" --network "$net" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=expand postgres:16 >/dev/null
step postgres_readiness "wait for expand database SQL readiness"
HARNESS_RESULT=RUNNING
expand_ready=false
for readiness_attempt in {1..60}; do
  if docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d expand -qAt -c 'SELECT 1;' > "$tmp/readiness.out" 2> "$tmp/readiness.err"; then
    readiness_exit=0
  else
    readiness_exit=$?
  fi
  if [[ $readiness_exit -eq 0 && ! -s "$tmp/readiness.err" && $(wc -l < "$tmp/readiness.out") -eq 1 ]] && grep -Fqx '1' "$tmp/readiness.out"; then
    expand_ready=true
    break
  fi
  sleep 1
done
[[ "$expand_ready" == true ]]
HARNESS_COMMAND="validate final independent expand database SQL connection"
if docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d expand -qAt -c 'SELECT 1;' > "$tmp/readiness-final.out" 2> "$tmp/readiness-final.err"; then
  final_readiness_exit=0
else
  final_readiness_exit=$?
fi
[[ $final_readiness_exit -eq 0 ]]
[[ ! -s "$tmp/readiness-final.err" ]]
[[ $(wc -l < "$tmp/readiness-final.out") -eq 1 ]]
grep -Fqx '1' "$tmp/readiness-final.out"
HARNESS_RESULT=PASS
echo 'TENANCY_EXPAND_DATABASE_READINESS=PASS'
url="postgresql://postgres:test@$pg:5432/expand?schema=public"
run_tooling(){ docker run --rm --pull=never --network "$net" -v "$tmp:/work" -w /app -e DATABASE_URL="$url" "$image" "$@"; }
step predecessor_materialization "materialize predecessor schema"
run_tooling ./node_modules/.bin/prisma db push --schema /work/predecessor.prisma --skip-generate >/dev/null
step fixtures "create synthetic incident fixture before all fixture reads"
docker exec -i "$pg" psql -X -U postgres -d expand -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE TABLE public."incident_synthetic" (id integer PRIMARY KEY);
INSERT INTO public."incident_synthetic" (id) VALUES (1);
SQL
step fixture_validation "verify synthetic incident and business fixtures before baseline"
HARNESS_COMMAND="verify synthetic incident fixture"
test "$(docker exec "$pg" psql -X -U postgres -d expand -Atc "SELECT to_regclass('public.incident_synthetic') IS NOT NULL")" = t
test "$(docker exec "$pg" psql -X -U postgres -d expand -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='incident_synthetic' AND column_name='id' AND data_type='integer' AND is_nullable='NO'")" = 1
test "$(docker exec "$pg" psql -X -U postgres -d expand -Atc "SELECT count(*) FROM pg_constraint WHERE conrelid='public.incident_synthetic'::regclass AND contype='p'")" = 1
HARNESS_COMMAND="create remaining synthetic pre-expand fixtures"
docker exec -i "$pg" psql -X -U postgres -d expand -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO public."AppConfig" (id,key,value,"createdAt","updatedAt") VALUES ('cfg','synthetic-key','value',now(),now());
INSERT INTO public."Product" (id,"erpProductCode","erpProductClassCode",name,"isActive","isSuspended","createdAt","updatedAt") VALUES ('product','P1','C1','Synthetic',true,false,now(),now());
INSERT INTO public."ErpSyncRun" (id,scope,trigger,status,"authMode","startedAt","syncedCount","createdAt") VALUES ('run','products','manual','success','global',now(),1,now());
INSERT INTO public."ErpSyncLock" (scope,"runId","lockedUntil","createdAt","updatedAt") VALUES ('products','run',now()+interval '1 minute',now(),now());
SQL
roots=(KnowledgeDocument Client AgendaEvent Goal ActivityKPI Sale SellerTerritoryCity AppConfig Product ErpSyncRun ErpSyncLock)
for table in "${roots[@]}"; do docker exec "$pg" psql -X -U postgres -d expand -Atc "SELECT count(*) FROM public.\"$table\"" > "$tmp/$table.before"; done
incident_before=$(docker exec "$pg" psql -X -U postgres -d expand -Atc 'SELECT count(*) FROM public."incident_synthetic"')
test "$incident_before" = 1
step atomic_failure "prove an intermediate failure rolls the entire expansion back"
{ echo BEGIN; sed '1a SELECT 1/0;' apps/api/prisma/migrations/20260808120000_tenancy_expand_roots/migration.sql; echo COMMIT; } >"$tmp/failing.sql"
if docker exec -i "$pg" psql -X -U postgres -d expand -v ON_ERROR_STOP=1 <"$tmp/failing.sql" >/dev/null 2>&1; then echo 'injected migration failure unexpectedly succeeded' >&2; exit 1; fi
test "$(docker exec "$pg" psql -X -U postgres -d expand -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='tenantId' AND table_name IN ('KnowledgeDocument','Client','AgendaEvent','Goal','ActivityKPI','Sale','SellerTerritoryCity','AppConfig','Product','ErpSyncRun','ErpSyncLock')")" = 0
step migration_apply "apply tenancy expand and preserve applied ERP manual resolution exactly once"
docker exec -i "$pg" psql -U postgres -d expand -v ON_ERROR_STOP=1 < apps/api/prisma/migrations/20260808120000_tenancy_expand_roots/migration.sql >/dev/null
if docker exec -i "$pg" psql -U postgres -d expand -v ON_ERROR_STOP=1 < apps/api/prisma/migrations/20260808120000_tenancy_expand_roots/migration.sql >/dev/null 2>&1; then echo 'migration unexpectedly applied twice' >&2; exit 1; fi
docker exec -i "$pg" psql -U postgres -d expand -v ON_ERROR_STOP=1 < apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql >/dev/null
if docker exec -i "$pg" psql -U postgres -d expand -v ON_ERROR_STOP=1 < apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql >/dev/null 2>&1; then echo 'ERP manual resolution migration unexpectedly applied twice' >&2; exit 1; fi
step catalog_validation "validate nullable columns indexes foreign keys and row counts"
docker exec -i "$pg" psql -X -U postgres -d expand -qAtF $'\t' <scripts/tenancy-expand-roots-catalog.sql >"$tmp/expand-catalog.tsv"
# Sanitized structural evidence only: no row values, URLs, or credentials.
awk -F $'\t' '$1=="fk" && $2=="KnowledgeDocument_tenantId_fkey" {print "POSTGRES_FK_OBSERVED\t" $3}' "$tmp/expand-catalog.tsv"
node scripts/tenancy-expand-roots-catalog-validate.mjs "$tmp/expand-catalog.tsv"
for table in "${roots[@]}"; do
  test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='$table' AND column_name='tenantId'")" = YES
  test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM \"$table\" WHERE \"tenantId\" IS NOT NULL")" = 0
  test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM \"$table\"")" = "$(cat "$tmp/$table.before")"
  test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='${table}_tenantId_idx'")" = 1
  test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM pg_constraint WHERE conname='${table}_tenantId_fkey' AND confdeltype='a'")" = 1
done
test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ErpOrderManualResolution' AND column_name IN ('id','erpOrderSyncId','opportunityId','resolvedById','resolvedRole','category','terminalState','justification','originalPedidoIdImportacao','originalCorrelationId','statusCheckedAt','statusCheckCorrelationId','createdAt')")" = 13
test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM pg_constraint WHERE conrelid='public.\"ErpOrderManualResolution\"'::regclass AND contype='f' AND confdeltype='r' AND confupdtype='c'")" = 3
test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM pg_constraint WHERE conname='ErpOrderSync_supersedesErpOrderSyncId_fkey' AND confdeltype='r' AND confupdtype='c'")" = 1
test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN ('ErpOrderManualResolution_erpOrderSyncId_key','ErpOrderManualResolution_opportunityId_createdAt_idx','ErpOrderManualResolution_resolvedById_createdAt_idx','ErpOrderSync_supersedesErpOrderSyncId_idx')")" = 4
test "$(docker exec "$pg" psql -U postgres -d expand -Atc "SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=enumtypid WHERE typname='ErpOrderManualResolutionTerminalState'")" = manually_resolved_not_found
test "$(docker exec "$pg" psql -X -U postgres -d expand -Atc "SELECT to_regclass('public._prisma_migrations') IS NULL")" = t
test "$(docker exec "$pg" psql -X -U postgres -d expand -Atc "SELECT count(*) FROM \"Tenant\"")" = 0
test "${TENANCY_MODE:-disabled}" = disabled
HARNESS_COMMAND="verify synthetic incident preservation after migration"
test "$(docker exec "$pg" psql -X -U postgres -d expand -Atc "SELECT to_regclass('public.incident_synthetic') IS NOT NULL")" = t
test "$(docker exec "$pg" psql -X -U postgres -d expand -Atc 'SELECT count(*) FROM public."incident_synthetic"')" = "$incident_before"
test "$(docker exec "$pg" psql -X -U postgres -d expand -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='incident_synthetic' AND column_name='id' AND data_type='integer' AND is_nullable='NO'")" = 1
test "$(docker exec "$pg" psql -X -U postgres -d expand -Atc "SELECT count(*) FROM pg_constraint WHERE conrelid='public.incident_synthetic'::regclass AND contype='p'")" = 1
step fk_negative_test "prove valid ownership and reject unknown tenant foreign key"
# Old writes remain valid; valid ownership succeeds; unknown ownership is rejected.
docker exec "$pg" psql -U postgres -d expand -c "INSERT INTO \"AppConfig\" (id,key,value,\"createdAt\",\"updatedAt\") VALUES ('legacy','legacy-key','value',now(),now())" >/dev/null
docker exec "$pg" psql -U postgres -d expand -c "INSERT INTO \"Tenant\" (id,slug,\"legalName\",\"displayName\",status,\"createdAt\",\"updatedAt\") VALUES ('synthetic-tenant','synthetic','Synthetic','Synthetic','active',now(),now()); UPDATE \"Product\" SET \"tenantId\"='synthetic-tenant' WHERE id='product'" >/dev/null
if docker exec "$pg" psql -U postgres -d expand -c "UPDATE \"AppConfig\" SET \"tenantId\"='missing' WHERE id='cfg'" >/dev/null 2>&1; then echo 'unknown tenant accepted' >&2; exit 1; fi
if docker exec "$pg" psql -U postgres -d expand -c "INSERT INTO \"ErpOrderManualResolution\" (id,\"erpOrderSyncId\",\"opportunityId\",\"resolvedById\",\"resolvedRole\",category,\"terminalState\",justification,\"originalPedidoIdImportacao\",\"originalCorrelationId\",\"statusCheckedAt\",\"statusCheckCorrelationId\",\"createdAt\") VALUES ('invalid-resolution','missing-attempt','missing-opportunity','missing-user','diretor','manual_verified_not_found','manually_resolved_not_found','synthetic','synthetic-import','synthetic-correlation',now(),'synthetic-check',now())" >/dev/null 2>&1; then echo 'unknown ERP resolution ownership accepted' >&2; exit 1; fi
step unique_negative_test "prove existing global unique remains enforced"
# Existing global unique constraints still reject duplicates.
if docker exec "$pg" psql -U postgres -d expand -c "INSERT INTO \"AppConfig\" (id,key,value,\"createdAt\",\"updatedAt\") VALUES ('duplicate','synthetic-key','value',now(),now())" >/dev/null 2>&1; then echo 'global unique changed' >&2; exit 1; fi
docker exec -i "$pg" psql -U postgres -d expand -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "User" (id,name,email,"passwordHash",role,"isActive","createdAt") VALUES ('erp-user','Synthetic','synthetic@example.invalid','synthetic','diretor',true,now());
INSERT INTO "Client" (id,name,city,state,region,"ownerSellerId","createdAt") VALUES ('erp-client','Synthetic','Synthetic','ST','Synthetic','erp-user',now());
INSERT INTO "Opportunity" (id,title,value,stage,"proposalDate","followUpDate","expectedCloseDate","clientId","ownerSellerId","createdAt") VALUES ('erp-opportunity','Synthetic',1,'ganho',now(),now(),now(),'erp-client','erp-user',now());
INSERT INTO "ErpOrderSync" (id,"opportunityId","sellerId","pedidoIdImportacao",status,"payloadSent","createdAt","updatedAt") VALUES ('erp-attempt','erp-opportunity','erp-user','synthetic-import','error','{}',now(),now());
INSERT INTO "ErpOrderManualResolution" (id,"erpOrderSyncId","opportunityId","resolvedById","resolvedRole",category,"terminalState",justification,"originalPedidoIdImportacao","originalCorrelationId","statusCheckedAt","statusCheckCorrelationId","createdAt") VALUES ('erp-resolution','erp-attempt','erp-opportunity','erp-user','diretor','manual_verified_not_found','manually_resolved_not_found','synthetic','synthetic-import','synthetic-correlation',now(),'synthetic-check',now());
SQL
if docker exec "$pg" psql -U postgres -d expand -c "INSERT INTO \"ErpOrderManualResolution\" (id,\"erpOrderSyncId\",\"opportunityId\",\"resolvedById\",\"resolvedRole\",category,\"terminalState\",justification,\"originalPedidoIdImportacao\",\"originalCorrelationId\",\"statusCheckedAt\",\"statusCheckCorrelationId\",\"createdAt\") VALUES ('duplicate-resolution','erp-attempt','erp-opportunity','erp-user','diretor','manual_verified_not_found','manually_resolved_not_found','synthetic','synthetic-import','synthetic-correlation',now(),'synthetic-check-2',now())" >/dev/null 2>&1; then echo 'duplicate ERP manual resolution accepted' >&2; exit 1; fi
step post_diff "validate historical tenancy boundary schema diff"
run_tooling ./node_modules/.bin/prisma migrate diff --from-url "$url" --to-schema-datamodel /work/tenancy-boundary.prisma --script > "$tmp/post-diff.raw.sql"
# The sole raw diff is the deliberately unmanaged forensic fixture; stripping that exact block yields an empty managed diff.
sed '/-- DropTable/,/DROP TABLE "incident_synthetic";/d' "$tmp/post-diff.raw.sql" | sed '/^[[:space:]]*$/d' > "$tmp/post-diff.managed.sql"
test "$(grep -Fxc 'DROP TABLE "incident_synthetic";' "$tmp/post-diff.raw.sql")" = 1
if [[ -s "$tmp/post-diff.managed.sql" ]]; then
  printf '%s\n' 'POST_DIFF_STRUCTURAL_BEGIN' >&2
  cat "$tmp/post-diff.managed.sql" >&2
  printf '%s\n' 'POST_DIFF_STRUCTURAL_END' >&2
  exit 1
fi
echo 'TENANCY_EXPAND_POSTGRES=PASS'
