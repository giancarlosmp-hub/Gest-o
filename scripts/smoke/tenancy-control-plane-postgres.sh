#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
docker image inspect node:20 >/dev/null 2>&1 || { echo 'SKIP: node:20 unavailable locally' >&2; exit 77; }
[[ -z ${DATABASE_URL:-} && -z ${TEST_DATABASE_URL:-} ]] || { echo 'refusing inherited database URL' >&2; exit 1; }
id="$$-$RANDOM"; pg="gesto-tenancy-pg-$id"; net="gesto-tenancy-net-$id"; tmp=$(mktemp -d)
cleanup(){ docker rm -f "$pg" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
docker network create --internal "$net" >/dev/null
docker run -d --rm --pull=never --name "$pg" --network "$net" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tenancy postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$pg" pg_isready -U postgres -d tenancy >/dev/null 2>&1 && break; sleep 1; done
docker exec "$pg" pg_isready -U postgres -d tenancy >/dev/null
url="postgresql://postgres:test@$pg:5432/tenancy?schema=public"
run_node(){ docker run --rm --pull=never --network "$net" -v "$root:/repo:ro" -v "$tmp:/evidence" -w /repo -e DATABASE_URL="$url" -e TENANCY_MODE="${TENANCY_MODE:-disabled}" -e EVIDENCE_DIR=/evidence ${CONFIRM:+-e CONFIRM="$CONFIRM"} ${EXPECTED_SHA:+-e EXPECTED_SHA="$EXPECTED_SHA"} node:20 "$@"; }
# Disposable-only schema materialization; production bootstrap remains external-authority.
run_node ./node_modules/.bin/prisma db push --schema apps/api/prisma/schema.prisma --skip-generate >/dev/null
docker exec "$pg" psql -U postgres -d tenancy -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "User" (id,name,email,"passwordHash",role,"isActive","createdAt") VALUES
('synthetic-director','Synthetic','director@example.invalid','synthetic','diretor',true,now()),
('synthetic-manager','Synthetic','manager@example.invalid','synthetic','gerente',true,now()),
('synthetic-seller','Synthetic','seller@example.invalid','synthetic','vendedor',false,now());
SQL
run_node ./node_modules/.bin/tsx apps/api/src/scripts/prepareDefaultTenant.ts --dry-run >/dev/null
test "$(docker exec "$pg" psql -U postgres -d tenancy -Atc 'SELECT count(*) FROM "Tenant"')" = 0
if run_node ./node_modules/.bin/tsx apps/api/src/scripts/prepareDefaultTenant.ts --apply >/dev/null 2>&1; then echo 'apply without confirmation succeeded' >&2; exit 1; fi
export CONFIRM=PREPARE_DEFAULT_TENANT EXPECTED_SHA
EXPECTED_SHA=$(git rev-parse HEAD); export TENANCY_MODE=default-only
run_node ./node_modules/.bin/tsx apps/api/src/scripts/prepareDefaultTenant.ts --apply >/dev/null
test "$(docker exec "$pg" psql -U postgres -d tenancy -Atc 'SELECT count(*) FROM "Tenant"')" = 1
test "$(docker exec "$pg" psql -U postgres -d tenancy -Atc 'SELECT count(*) FROM "TenantMembership" WHERE status='"'"'active'"'"' AND version=1')" = 3
run_node ./node_modules/.bin/tsx apps/api/src/scripts/prepareDefaultTenant.ts --apply >/dev/null
test "$(docker exec "$pg" psql -U postgres -d tenancy -Atc 'SELECT count(*) FROM "TenantMembership"')" = 3
run_node ./node_modules/.bin/prisma migrate diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --exit-code >/dev/null
# PostgreSQL enum is deliberately extended only in this disposable DB to prove unknown-role fail-closed.
docker exec "$pg" psql -U postgres -d tenancy -c 'ALTER TYPE "Role" ADD VALUE '\''unknown_test'\''' >/dev/null
docker exec "$pg" psql -U postgres -d tenancy -c "INSERT INTO \"User\" (id,name,email,\"passwordHash\",role,\"isActive\",\"createdAt\") VALUES ('synthetic-unknown','Synthetic','unknown@example.invalid','synthetic','unknown_test',true,now())" >/dev/null
if run_node ./node_modules/.bin/tsx apps/api/src/scripts/prepareDefaultTenant.ts --dry-run >/dev/null 2>&1; then echo 'unknown role accepted' >&2; exit 1; fi
docker exec "$pg" psql -U postgres -d tenancy -c "DELETE FROM \"User\" WHERE id='synthetic-unknown'; INSERT INTO \"Tenant\" (id,slug,\"legalName\",\"displayName\",status,\"updatedAt\") VALUES ('unexpected','unexpected','Unexpected','Unexpected','active',now())" >/dev/null
if run_node ./node_modules/.bin/tsx apps/api/src/scripts/prepareDefaultTenant.ts --dry-run >/dev/null 2>&1; then echo 'unexpected tenant accepted' >&2; exit 1; fi
echo 'tenancy control-plane disposable PostgreSQL test passed'
