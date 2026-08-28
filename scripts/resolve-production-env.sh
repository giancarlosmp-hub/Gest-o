#!/usr/bin/env bash
set -euo pipefail

# Resolves only the authorized path. It never reads or emits env values.
MODE="${MODE:-build}"
CANONICAL_ENV_FILE="${PRODUCTION_CANONICAL_ENV_FILE:-/root/demetra-env/.env}"
LEGACY_ENV_FILE="${PRODUCTION_LEGACY_ENV_FILE:-/root/demetra-env/production.env}"
EXPECTED_OWNER="${ERP_ENV_EXPECTED_OWNER:-root:root}"
EXPECTED_MODE="${ERP_ENV_EXPECTED_MODE:-600}"
OUTPUT_FORMAT="${PRODUCTION_ENV_RESOLVER_OUTPUT:-path}"
STRICT_CARDINALITY="${PRODUCTION_ENV_REQUIRE_EXACTLY_ONE:-false}"
die(){ printf '[production-env-resolution] FAIL: %s\n' "$*" >&2; exit 1; }

[[ "$MODE" == build || "$MODE" == cutover ]] || die 'MODE must be build or cutover'
[[ "$OUTPUT_FORMAT" == path || "$OUTPUT_FORMAT" == record ]] || die 'unsupported output format'
[[ "$STRICT_CARDINALITY" == true || "$STRICT_CARDINALITY" == false ]] || die 'invalid cardinality policy'
[[ "$CANONICAL_ENV_FILE" != "$LEGACY_ENV_FILE" ]] || die 'canonical and legacy paths are ambiguous'

emit(){
  local file=$1 source=$2 legacy_marker=$3
  case "$legacy_marker" in
    canonical) printf 'ERP_PRODUCTION_ENV_SOURCE=canonical\n' >&2 ;;
    legacy_build_only) printf 'ERP_PRODUCTION_ENV_SOURCE=legacy_build_only\n' >&2 ;;
    *) die 'internal source classification is invalid' ;;
  esac
  if [[ "$OUTPUT_FORMAT" == record ]]; then
    printf '%s\t%s\n' "$source" "$file"
  else
    printf '%s\n' "$file"
  fi
}

validate(){
  local file=$1 label=$2
  [[ -f "$file" && ! -L "$file" ]] || die "$label source is not a regular non-symlink file"
  [[ "$(stat -c '%U:%G' "$file")" == "$EXPECTED_OWNER" ]] || die "$label source owner is invalid"
  [[ "$(stat -c '%a' "$file")" == "$EXPECTED_MODE" ]] || die "$label source mode is invalid"
}

# Any canonical directory entry is authoritative: an invalid canonical file
# fails closed and can never be bypassed with the legacy source.
canonical_present=false; legacy_present=false
[[ -e "$CANONICAL_ENV_FILE" || -L "$CANONICAL_ENV_FILE" ]] && canonical_present=true
[[ -e "$LEGACY_ENV_FILE" || -L "$LEGACY_ENV_FILE" ]] && legacy_present=true
if [[ "$STRICT_CARDINALITY" == true && "$canonical_present" == true && "$legacy_present" == true ]]; then
  die 'more than one authorized environment source is present'
fi

if [[ "$canonical_present" == true ]]; then
  validate "$CANONICAL_ENV_FILE" canonical
  emit "$CANONICAL_ENV_FILE" canonical canonical
  exit 0
fi

[[ "$MODE" == build ]] || die 'canonical source is required for cutover'
[[ "$legacy_present" == true ]] || die 'canonical and authorized build-only legacy sources are absent'
validate "$LEGACY_ENV_FILE" legacy_build_only
emit "$LEGACY_ENV_FILE" legacy_copy legacy_build_only
