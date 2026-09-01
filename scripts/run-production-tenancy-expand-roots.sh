#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="${APP_DIR:-/apps/gest-o}"
CANONICAL_ENV_FILE="${PRODUCTION_CANONICAL_ENV_FILE:-/root/demetra-env/.env}"
LEGACY_ENV_FILE="${PRODUCTION_LEGACY_ENV_FILE:-/root/demetra-env/production.env}"

cd "$APP_DIR"
env_record="$(MODE=cutover PRODUCTION_ENV_RESOLVER_OUTPUT=record \
  PRODUCTION_CANONICAL_ENV_FILE="$CANONICAL_ENV_FILE" \
  PRODUCTION_LEGACY_ENV_FILE="$LEGACY_ENV_FILE" \
  bash scripts/resolve-production-env.sh)"
IFS=$'\t' read -r env_source env_file env_extra <<<"$env_record"
[[ "$env_source" == canonical && -n "$env_file" && -z "$env_extra" ]]
unset env_record env_extra

# bash -n accepts the supported unquoted, single-quoted and double-quoted
# dotenv forms without evaluating the protected file or disclosing its values.
bash -n "$env_file" >/dev/null 2>&1
set -a
source "$env_file"
set +a
[[ ${DATABASE_URL+x} == x && -n "$DATABASE_URL" ]]

# DATABASE_URL exists only in this authorized remote process and its children.
exec bash scripts/tenancy-expand-roots-runner.sh
