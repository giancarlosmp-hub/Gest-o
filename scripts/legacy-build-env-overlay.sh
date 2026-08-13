#!/usr/bin/env bash

# Sourced by deploy-production.sh. The caller owns the EXIT trap so the
# effective environment remains available for the complete image build only.
create_legacy_build_env_overlay() {
  local source_file=$1 output_file=$2
  local gates gate count line tmp
  gates='ERP_SYNC_SCHEDULER_ENABLED=false
TENANCY_MODE=disabled
TENANT_READ_PILOT_ENABLED=false
DATABASE_SCHEMA_MODE=external
SEED_ON_BOOTSTRAP=false
ENABLE_PREVIEW_SEED=false
ENABLE_SMOKE_BOOTSTRAP=false'

  printf 'ERP_LEGACY_BUILD_OVERLAY=STARTED\n' >&2
  chmod 600 "$output_file"
  cp -- "$source_file" "$output_file"
  chmod 600 "$output_file"

  awk '
    /^[[:space:]]*($|#)/ { next }
    /^[A-Za-z_][A-Za-z0-9_]*=/ { next }
    { invalid=1 }
    END { exit invalid }
  ' "$source_file" || {
    printf '[legacy-build-overlay] FAIL: malformed environment line\n' >&2
    return 1
  }

  while IFS='=' read -r gate _; do
    count=$(awk -v key="$gate" '
      $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { found++ }
      $0 ~ "^[[:space:]]*" key && $0 !~ "^[[:space:]]*" key "[[:space:]]*=" { malformed=1 }
      END { if (malformed) exit 2; print found + 0 }
    ' "$source_file") || {
      printf '[legacy-build-overlay] FAIL: malformed protected gate line\n' >&2
      return 1
    }
    [[ "$count" -le 1 ]] || {
      printf '[legacy-build-overlay] FAIL: duplicated protected gate\n' >&2
      return 1
    }
  done <<<"$gates"

  while IFS= read -r line; do
    gate=${line%%=*}
    tmp=$(mktemp "${output_file}.reconcile.XXXXXX")
    chmod 600 "$tmp"
    awk -v key="$gate" -v replacement="$line" '
      BEGIN { replaced=0 }
      $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { if (!replaced) print replacement; replaced=1; next }
      { print }
      END { if (!replaced) print replacement }
    ' "$output_file" >"$tmp"
    mv -f -- "$tmp" "$output_file"
    chmod 600 "$output_file"
  done <<<"$gates"

  printf 'ERP_LEGACY_BUILD_OVERLAY_GATE_COUNT=7\n' >&2
  printf 'ERP_LEGACY_BUILD_OVERLAY=PASS\n' >&2
  printf 'ERP_SCHEDULER_ENV=DISABLED_BUILD_ONLY\n' >&2
  printf 'ERP_TENANCY_MODE=DISABLED_BUILD_ONLY\n' >&2
  printf 'ERP_DATABASE_SCHEMA_MODE=EXTERNAL_BUILD_ONLY\n' >&2
  printf 'ERP_SEED_GATES=DISABLED_BUILD_ONLY\n' >&2
}
