#!/usr/bin/env bash
set -euo pipefail

# Resolves only the authorized path. It never reads or emits env values.
MODE="${MODE:-build}"
CANONICAL_ENV_FILE="${PRODUCTION_CANONICAL_ENV_FILE:-/root/demetra-env/.env}"
LEGACY_ENV_FILE="${PRODUCTION_LEGACY_ENV_FILE:-/root/demetra-env/production.env}"
EXPECTED_OWNER="${ERP_ENV_EXPECTED_OWNER:-root:root}"
EXPECTED_MODE="${ERP_ENV_EXPECTED_MODE:-600}"
die(){ printf '[production-env-resolution] FAIL: %s\n' "$*" >&2; exit 1; }

[[ "$MODE" == build || "$MODE" == cutover ]] || die 'MODE must be build or cutover'
[[ "$CANONICAL_ENV_FILE" != "$LEGACY_ENV_FILE" ]] || die 'canonical and legacy paths are ambiguous'

validate(){
  local file=$1 label=$2
  [[ -f "$file" && ! -L "$file" ]] || die "$label source is not a regular non-symlink file"
  [[ "$(stat -c '%U:%G' "$file")" == "$EXPECTED_OWNER" ]] || die "$label source owner is invalid"
  [[ "$(stat -c '%a' "$file")" == "$EXPECTED_MODE" ]] || die "$label source mode is invalid"
}

# Any canonical directory entry is authoritative: an invalid canonical file
# fails closed and can never be bypassed with the legacy source.
if [[ -e "$CANONICAL_ENV_FILE" || -L "$CANONICAL_ENV_FILE" ]]; then
  validate "$CANONICAL_ENV_FILE" canonical
  printf 'ERP_PRODUCTION_ENV_SOURCE=canonical\n' >&2
  printf '%s\n' "$CANONICAL_ENV_FILE"
  exit 0
fi

[[ "$MODE" == build ]] || die 'canonical source is required for cutover'
[[ -e "$LEGACY_ENV_FILE" || -L "$LEGACY_ENV_FILE" ]] || die 'canonical and authorized build-only legacy sources are absent'
validate "$LEGACY_ENV_FILE" legacy_build_only
printf 'ERP_PRODUCTION_ENV_SOURCE=legacy_build_only\n' >&2
printf '%s\n' "$LEGACY_ENV_FILE"
