#!/usr/bin/env bash
set -euo pipefail

failure_stage="initialization"
failure_command="initialize_harness"
failure_reported=false
set_failure_context() { failure_stage="$1"; failure_command="$2"; }
report_failure() {
  local code="$1"
  if [[ "$failure_reported" != true ]]; then
    failure_reported=true
    printf 'TENANT_PREVIEW_SEED_FAILURE_STAGE=%s\n' "$failure_stage" >&2
    printf 'TENANT_PREVIEW_SEED_FAILURE_COMMAND=%s\n' "$failure_command" >&2
    printf 'TENANT_PREVIEW_SEED_FAILURE_EXIT_CODE=%s\n' "$code" >&2
  fi
}
on_error() { local code=$?; report_failure "$code"; exit "$code"; }
trap on_error ERR

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker unavailable"
  exit 77
fi

name="gesto-preview-seed-${RANDOM}-$$"
network="${name}-net"
image="${API_IMAGE:-gest-o-preview-seed:local}"
tenant_id="tenant-default-v1"
db="gesto_preview_certification"
preview_seed_password=$(head -c 48 /dev/urandom | base64 | tr -d '\n')
cleanup() { preview_seed_password=; unset preview_seed_password; docker rm -f "$name" >/dev/null 2>&1 || :; docker network rm "$network" >/dev/null 2>&1 || :; }
trap cleanup EXIT
unset DATABASE_URL

if [[ -z "${API_IMAGE:-}" ]]; then
  set_failure_context image_build build_api_image
  docker build --build-arg APP_COMMIT="$(git rev-parse HEAD)" -t "$image" -f apps/api/Dockerfile . >/dev/null
fi
set_failure_context network_setup create_docker_network
docker network create "$network" >/dev/null
set_failure_context database_start start_postgres_16
docker run -d --name "$name" --network "$network" -e POSTGRES_PASSWORD=preview_ephemeral -e POSTGRES_DB="$db" postgres:16 >/dev/null
set_failure_context database_readiness wait_for_postgres
ready=false
for _ in {1..60}; do
  if docker exec "$name" pg_isready -U postgres -d "$db" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  report_failure 1
  exit 1
fi
set_failure_context database_readiness verify_postgres_ready
docker exec "$name" pg_isready -U postgres -d "$db" >/dev/null
url="postgresql://postgres:preview_ephemeral@${name}:5432/${db}?schema=public"
run_api() { docker run --rm --network "$network" -e DATABASE_URL="$url" -e NODE_ENV=test -e DEPLOYMENT_ENV=preview -e ENABLE_PREVIEW_SEED=true -e DEFAULT_TENANT_ID="$tenant_id" -e PREVIEW_SEED_PASSWORD="$preview_seed_password" --entrypoint sh "$image" -c "$1"; }

echo "checkpoint: schema"
set_failure_context schema apply_prisma_schema
run_api 'npx prisma db push --schema=apps/api/prisma/schema.prisma --skip-generate >/dev/null'
echo "checkpoint: seed"
set_failure_context initial_seed apply_preview_seed
run_api 'npm run seed:preview -w @salesforce-pro/api >/dev/null'
set_failure_context initial_snapshot read_preview_counts
before="$(docker exec -i "$name" psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 -At <<'SQL'
SET search_path TO public;
SELECT (SELECT count(*) FROM "Tenant") || ':' || (SELECT count(*) FROM "TenantMembership") || ':' || (SELECT count(*) FROM "Client");
SQL
)"
echo "checkpoint: validate"
set_failure_context dataset_validation validate_preview_dataset
run_api 'npx tsx apps/api/prisma/validatePreviewTenantReadPilot.ts'
echo "checkpoint: reapply"
set_failure_context seed_reapply reapply_preview_seed
run_api 'npm run seed:preview -w @salesforce-pro/api >/dev/null'
set_failure_context final_snapshot read_reapplied_counts
after="$(docker exec -i "$name" psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 -At <<'SQL'
SET search_path TO public;
SELECT (SELECT count(*) FROM "Tenant") || ':' || (SELECT count(*) FROM "TenantMembership") || ':' || (SELECT count(*) FROM "Client");
SQL
)"
set_failure_context idempotency compare_seed_counts
test "$before" = "$after"
set_failure_context ownership_assertions validate_tenant_ownership
docker exec -i "$name" psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 <<SQL >/dev/null
SET search_path TO public;
DO \$\$ BEGIN
 IF (SELECT count(*) FROM "Tenant" WHERE id = '$tenant_id' AND status = 'active') <> 1 THEN RAISE EXCEPTION 'tenant'; END IF;
 IF EXISTS (SELECT 1 FROM "Client" WHERE "tenantId" IS NULL OR "tenantId" <> '$tenant_id') THEN RAISE EXCEPTION 'client tenant'; END IF;
 IF EXISTS (SELECT 1 FROM "Client" c LEFT JOIN "TenantMembership" m ON m."userId"=c."ownerSellerId" AND m."tenantId"=c."tenantId" AND m.status='active' WHERE m.id IS NULL) THEN RAISE EXCEPTION 'ownership'; END IF;
END \$\$;
SQL
set_failure_context completed emit_success
echo "TENANT_READ_PREVIEW_SEED=PASS"
echo "TENANT_READ_PREVIEW_DATASET=PASS"
echo "PASS: tenant read pilot preview seed PostgreSQL 16"
