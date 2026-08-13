#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${PRODUCTION_ENV_FILE:-/root/demetra-env/.env}"
EXPECTED_OWNER="${ERP_ENV_EXPECTED_OWNER:-root:root}"
EXPECTED_MODE="${ERP_ENV_EXPECTED_MODE:-600}"
COMPOSE_FILE="${ERP_PRODUCTION_COMPOSE_FILE:-docker-compose.production.yml}"
log(){ printf '[erp-env-preflight] %s\n' "$*"; }
die(){ log "FAIL: $*" >&2; exit 1; }

[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "protected env file is absent or is not a regular non-symlink file: $ENV_FILE"
owner="$(stat -c '%U:%G' "$ENV_FILE")"
mode="$(stat -c '%a' "$ENV_FILE")"
[[ "$owner" == "$EXPECTED_OWNER" ]] || die "protected env file owner is invalid (expected $EXPECTED_OWNER)"
[[ "$mode" == "$EXPECTED_MODE" ]] || die "protected env file mode is invalid (expected $EXPECTED_MODE)"

# The protected file is trusted operator input. Values are loaded only into this
# process and are never echoed, hashed, measured, or written to an artifact.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

require_nonempty(){ local name=$1; [[ -n "${!name:-}" ]] || die "$name is ABSENT_OR_EMPTY"; log "$name=PRESENT"; }
require_literal(){ local name=$1 expected=$2; [[ "${!name:-}" == "$expected" ]] || die "$name does not match the production policy"; log "$name=VALID"; }

for name in DATABASE_URL JWT_ACCESS_SECRET JWT_REFRESH_SECRET ULTRAFV3_BASE_URL ERP_CREDENTIAL_ENCRYPTION_KEY; do
  require_nonempty "$name"
done
# JWT_SECRET remains required by the production Compose contract even when the
# access/refresh pair is present.
require_nonempty JWT_SECRET
case "${ERP_ENV_SCHEDULER_POLICY:-enabled}" in
  enabled) require_literal ERP_SYNC_SCHEDULER_ENABLED true; scheduler_marker=ENABLED ;;
  disabled_build_only) require_literal ERP_SYNC_SCHEDULER_ENABLED false; scheduler_marker=DISABLED_BUILD_ONLY ;;
  *) die "scheduler validation policy is invalid" ;;
esac
require_literal TENANCY_MODE disabled
require_literal TENANT_READ_PILOT_ENABLED false
require_literal DATABASE_SCHEMA_MODE external
require_literal SEED_ON_BOOTSTRAP false
require_literal ENABLE_PREVIEW_SEED false
require_literal ENABLE_SMOKE_BOOTSTRAP false

if [[ -n "${ULTRAFV3_USERNAME:-}" || -n "${ULTRAFV3_PASSWORD:-}" ]]; then
  [[ -n "${ULTRAFV3_USERNAME:-}" && -n "${ULTRAFV3_PASSWORD:-}" ]] || die "global UltraFV3 credentials are only partially configured"
  log "ERP_GLOBAL_CREDENTIALS=PRESENT"
else
  log "ERP_GLOBAL_CREDENTIALS=ABSENT (seller_reference must be validated after startup)"
fi

[[ -f "$COMPOSE_FILE" ]] || die "production Compose file is absent"
command -v docker >/dev/null 2>&1 || die "docker is required"
# Never emit `docker compose config`: rendered output contains secrets.
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >"$rendered" || die "production Compose cannot be rendered"
for name in DATABASE_URL JWT_SECRET JWT_ACCESS_SECRET JWT_REFRESH_SECRET ULTRAFV3_BASE_URL ERP_CREDENTIAL_ENCRYPTION_KEY ERP_SYNC_SCHEDULER_ENABLED; do
  grep -Eq "^[[:space:]]+$name:" "$rendered" || die "rendered API service omits $name"
done
awk -F: -v expected="${ERP_SYNC_SCHEDULER_ENABLED}" '$1 ~ /^[[:space:]]*ERP_SYNC_SCHEDULER_ENABLED[[:space:]]*$/ { value=$2; gsub(/[[:space:]"\047]/, "", value); if (value == expected) ok=1 } END { exit !ok }' "$rendered" || die "rendered scheduler gate does not match policy"
rm -f "$rendered"; trap - EXIT
log "ERP_EXTERNAL_ENV=PRESENT"
log "ERP_SCHEDULER_ENV=$scheduler_marker"
log "PASS: protected production ERP environment contract is valid; values omitted"
