#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat >"$TMP/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
cat <<'YAML'
services:
  api:
    environment:
      DATABASE_URL: hidden
      JWT_SECRET: hidden
      JWT_ACCESS_SECRET: hidden
      JWT_REFRESH_SECRET: hidden
      ULTRAFV3_BASE_URL: hidden
      ERP_CREDENTIAL_ENCRYPTION_KEY: hidden
      ERP_SYNC_SCHEDULER_ENABLED: "true"
YAML
DOCKER
chmod +x "$TMP/bin/docker"

write_env() {
  cat >"$TMP/production.env" <<'ENV'
DATABASE_URL=secret-database
JWT_SECRET=secret-jwt
JWT_ACCESS_SECRET=secret-access
JWT_REFRESH_SECRET=secret-refresh
ULTRAFV3_BASE_URL=secret-base-url
ERP_CREDENTIAL_ENCRYPTION_KEY=secret-encryption-key
ERP_SYNC_SCHEDULER_ENABLED=true
TENANCY_MODE=disabled
TENANT_READ_PILOT_ENABLED=false
DATABASE_SCHEMA_MODE=external
SEED_ON_BOOTSTRAP=false
ENABLE_PREVIEW_SEED=false
ENABLE_SMOKE_BOOTSTRAP=false
ULTRAFV3_USERNAME=
ULTRAFV3_PASSWORD=
ENV
  chmod 600 "$TMP/production.env"
}
run_preflight() {
  PATH="$TMP/bin:$PATH" PRODUCTION_ENV_FILE="$TMP/production.env" \
    ERP_ENV_EXPECTED_OWNER="$(id -un):$(id -gn)" ERP_PRODUCTION_COMPOSE_FILE="$ROOT/docker-compose.production.yml" \
    bash "$ROOT/scripts/erp-production-env-preflight.sh"
}

write_env
output="$(run_preflight 2>&1)"
grep -q 'ERP_EXTERNAL_ENV=PRESENT' <<<"$output"
grep -q 'ERP_SCHEDULER_ENV=ENABLED' <<<"$output"
for secret in secret-database secret-jwt secret-access secret-refresh secret-base-url secret-encryption-key; do
  ! grep -Fq "$secret" <<<"$output"
done

rm "$TMP/production.env"
! run_preflight >"$TMP/missing.out" 2>&1
write_env
sed -i 's/ERP_SYNC_SCHEDULER_ENABLED=true/ERP_SYNC_SCHEDULER_ENABLED=false/' "$TMP/production.env"
! run_preflight >"$TMP/false.out" 2>&1
write_env
sed -i 's/JWT_REFRESH_SECRET=secret-refresh/JWT_REFRESH_SECRET=/' "$TMP/production.env"
! run_preflight >"$TMP/empty.out" 2>&1
! grep -Fq 'secret-' "$TMP/missing.out" "$TMP/false.out" "$TMP/empty.out"
printf '%s\n' 'erp production env preflight safety passed'
