#!/usr/bin/env bash

# Sourced by deploy-production.sh. The caller owns the EXIT trap so the
# effective environment remains available for the complete image build only.
create_legacy_build_env_overlay() {
  local source_file=$1 output_file=$2 root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf 'ERP_LEGACY_BUILD_OVERLAY=STARTED\n' >&2
  chmod 600 "$output_file"
  # shellcheck source=scripts/production-env-reconcile.sh
  source "$root/production-env-reconcile.sh"
  reconcile_production_env build_legacy "$source_file" "$output_file"

  printf 'ERP_LEGACY_BUILD_OVERLAY_GATE_COUNT=7\n' >&2
  printf 'ERP_LEGACY_BUILD_OVERLAY=PASS\n' >&2
  printf 'ERP_SCHEDULER_ENV=DISABLED_BUILD_ONLY\n' >&2
  printf 'ERP_TENANCY_MODE=DISABLED_BUILD_ONLY\n' >&2
  printf 'ERP_DATABASE_SCHEMA_MODE=EXTERNAL_BUILD_ONLY\n' >&2
  printf 'ERP_SEED_GATES=DISABLED_BUILD_ONLY\n' >&2
}
