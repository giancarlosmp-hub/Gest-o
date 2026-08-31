#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
OWNER="$(id -un):$(id -gn)"
CANONICAL="$TMP/protected-canonical"; LEGACY="$TMP/protected-legacy"
SECRET='postgresql://secret-user:secret-password@protected.invalid/database'

resolve(){
  MODE=build ERP_ENV_EXPECTED_OWNER="$OWNER" PRODUCTION_CANONICAL_ENV_FILE="$CANONICAL" \
    PRODUCTION_LEGACY_ENV_FILE="$LEGACY" PRODUCTION_ENV_REQUIRE_EXACTLY_ONE=true \
    PRODUCTION_ENV_RESOLVER_OUTPUT=record bash "$ROOT/scripts/resolve-production-env.sh"
}
runner(){
  MODE="${1:-preview}" ERP_ENV_EXPECTED_OWNER="$OWNER" PRODUCTION_ENV_SOURCE="${2:-legacy_copy}" \
    ERP_PRODUCTION_ENV_SOURCE="${4:-legacy_build_only}" \
    PRODUCTION_ENV_FILE="$3" bash "$ROOT/scripts/pr827-schema-runner.sh"
}
expect_fail(){ if "$@" >"$TMP/out" 2>&1; then echo 'expected failure' >&2; exit 1; fi; }
assert_redacted(){
  ! grep -Fq "$TMP" "$TMP/out"
  ! grep -Fq 'secret-password' "$TMP/out"
  ! grep -Fq 'postgresql://' "$TMP/out"
}

# The real production compatibility source is selected as one immutable record.
printf 'DATABASE_URL=%s\n' "$SECRET" >"$LEGACY"; chmod 600 "$LEGACY"
record=$(resolve 2>"$TMP/resolve.err")
[[ "$record" == "legacy_copy"$'\t'"$LEGACY" ]]
before=$(sha256sum "$LEGACY")
expect_fail runner preview legacy_copy "$LEGACY"
grep -Fxq 'PR827_ENV_SOURCE=legacy_copy' "$TMP/out"
grep -Fxq 'ERP_PRODUCTION_ENV_SOURCE=legacy_build_only' "$TMP/out"
grep -Fxq 'PR827_ENV_SOURCE_CLASSIFICATION=VALID' "$TMP/out"
grep -Fxq 'PR827_ENV_METADATA=VALID' "$TMP/out"
grep -Fxq 'PR827_DATABASE_URL_CONTRACT=PASS' "$TMP/out"
grep -Fxq 'PR827_ENV_IMMUTABLE=PASS' "$TMP/out"
[[ $(sha256sum "$LEGACY") == "$before" ]]
assert_redacted

rm "$LEGACY"; expect_fail resolve; assert_redacted
printf 'DATABASE_URL=%s\n' "$SECRET" >"$CANONICAL"; chmod 600 "$CANONICAL"
ln -s "$CANONICAL" "$LEGACY"; expect_fail resolve; assert_redacted
rm "$LEGACY"; chmod 640 "$CANONICAL"; expect_fail resolve; assert_redacted
chmod 600 "$CANONICAL"
expect_fail env ERP_ENV_EXPECTED_OWNER=definitely-not-owner PRODUCTION_CANONICAL_ENV_FILE="$CANONICAL" \
  PRODUCTION_LEGACY_ENV_FILE="$LEGACY" MODE=build PRODUCTION_ENV_REQUIRE_EXACTLY_ONE=true bash "$ROOT/scripts/resolve-production-env.sh"
assert_redacted
printf 'DATABASE_URL=%s\n' "$SECRET" >"$LEGACY"; chmod 600 "$LEGACY"; expect_fail resolve; assert_redacted
rm "$CANONICAL"; printf 'NOT_DATABASE_URL=value\n' >"$LEGACY"; before=$(sha256sum "$LEGACY")
expect_fail runner preview legacy_copy "$LEGACY"; assert_redacted; [[ $(sha256sum "$LEGACY") == "$before" ]]
expect_fail runner apply legacy_copy "$LEGACY"; ! grep -Fq 'PR827_MIGRATION_APPLY=PASS' "$TMP/out"
[[ $(sha256sum "$LEGACY") == "$before" ]]
echo 'PR827 protected production environment safety passed'
