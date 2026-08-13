#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
secret='legacy-overlay-secret-must-not-leak'
base="$TMP/production.env"
overlay="$TMP/effective.env"

write_base(){
  printf 'DATABASE_URL=postgres://example\nJWT_SECRET=j\nJWT_ACCESS_SECRET=a\nJWT_REFRESH_SECRET=r\nULTRAFV3_BASE_URL=https://example.invalid\nERP_CREDENTIAL_ENCRYPTION_KEY=%s\n%s' "$secret" "$1" >"$base"
  chmod 600 "$base"
}
run_overlay(){
  : >"$overlay"; chmod 600 "$overlay"
  # shellcheck source=scripts/legacy-build-env-overlay.sh
  source "$ROOT/scripts/legacy-build-env-overlay.sh"
  create_legacy_build_env_overlay "$base" "$overlay"
}
assert_gates(){
  for expected in ERP_SYNC_SCHEDULER_ENABLED=false TENANCY_MODE=disabled TENANT_READ_PILOT_ENABLED=false DATABASE_SCHEMA_MODE=external SEED_ON_BOOTSTRAP=false ENABLE_PREVIEW_SEED=false ENABLE_SMOKE_BOOTSTRAP=false; do
    [[ "$(grep -Fxc "$expected" "$overlay")" -eq 1 ]]
  done
}

# A: missing modern gates are added only to the effective file.
write_base $'ERP_SYNC_SCHEDULER_ENABLED=false\n'
before=$(sha256sum "$base"); run_overlay >"$TMP/a.out" 2>"$TMP/a.err"; assert_gates
[[ "$(sha256sum "$base")" == "$before" ]]
# B: already-safe gates remain singular and deterministic.
cp "$overlay" "$base"; before=$(sha256sum "$base"); run_overlay >"$TMP/b.out" 2>"$TMP/b.err"; assert_gates
cmp -s "$base" "$overlay"; [[ "$(sha256sum "$base")" == "$before" ]]
# C: divergent historical values are normalized only in the overlay.
write_base $'ERP_SYNC_SCHEDULER_ENABLED=true\nTENANCY_MODE=legacy\nTENANT_READ_PILOT_ENABLED=true\nDATABASE_SCHEMA_MODE=ephemeral-push\nSEED_ON_BOOTSTRAP=true\nENABLE_PREVIEW_SEED=true\nENABLE_SMOKE_BOOTSTRAP=true\n'
before=$(sha256sum "$base"); run_overlay >"$TMP/c.out" 2>"$TMP/c.err"; assert_gates
[[ "$(sha256sum "$base")" == "$before" ]]
# D/E: duplicates and malformed protected lines fail closed without mutation.
write_base $'TENANCY_MODE=disabled\nTENANCY_MODE=legacy\n'; before=$(sha256sum "$base")
! run_overlay >"$TMP/d.out" 2>"$TMP/d.err"; [[ "$(sha256sum "$base")" == "$before" ]]
write_base $'TENANCY_MODE disabled\n'; before=$(sha256sum "$base")
! run_overlay >"$TMP/e.out" 2>"$TMP/e.err"; [[ "$(sha256sum "$base")" == "$before" ]]
# K: no secret or rendered Compose data is emitted.
! grep -FRq "$secret" "$TMP"/*.out "$TMP"/*.err
! grep -FRq 'DATABASE_URL:' "$TMP"/*.out "$TMP"/*.err
# J/L/M: deploy owns cleanup; overlay precedes preflight/build and cannot operate cutover.
deploy=$(cat "$ROOT/scripts/deploy-production.sh")
grep -Fq 'trap cleanup_legacy_overlay EXIT' <<<"$deploy"
grep -Fq 'rm -f -- "$EFFECTIVE_ENV_FILE"' <<<"$deploy"
[[ $(grep -n 'create_legacy_build_env_overlay' <<<"$deploy" | cut -d: -f1) -lt $(grep -n 'erp-production-env-preflight.sh' <<<"$deploy" | head -1 | cut -d: -f1) ]]
[[ $(grep -n 'erp-production-env-preflight.sh' <<<"$deploy" | head -1 | cut -d: -f1) -lt $(grep -n '"${COMPOSE\[@\]}" build api web' <<<"$deploy" | cut -d: -f1) ]]
grep -Fq '[[ "$MODE" == build ]] || die "legacy build overlay is prohibited outside MODE=build"' <<<"$deploy"
for forbidden in 'docker compose up' 'docker stop' 'docker rm' ' down' 'prune' ' pull' 'migrations' 'schema apply' 'seed' 'backfill'; do
  ! grep -Fiq "$forbidden" "$ROOT/scripts/legacy-build-env-overlay.sh"
done
printf '%s\n' 'legacy build env overlay safety passed (A-E,K)'

# The same closed primitive has an explicit recovery policy, while the build
# wrapper can never select it.
write_base $'ERP_SYNC_SCHEDULER_ENABLED=false\n'
recovery="$TMP/recovery.env"; : >"$recovery"; chmod 600 "$recovery"
source "$ROOT/scripts/production-env-reconcile.sh"
reconcile_production_env recovery_legacy "$base" "$recovery" >"$TMP/r.out" 2>"$TMP/r.err"
[[ "$(grep -Fxc 'ERP_SYNC_SCHEDULER_ENABLED=true' "$recovery")" -eq 1 ]]
! grep -Fq recovery_legacy "$ROOT/scripts/legacy-build-env-overlay.sh"
