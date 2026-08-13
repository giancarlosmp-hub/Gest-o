#!/usr/bin/env bash

# Versioned, side-effect-free reconciliation primitive. Callers must create and
# protect the destination and remain responsible for removing it.
reconcile_production_env() {
  local policy=$1 source_file=$2 output_file=$3 scheduler gate replacement tmp
  case "$policy" in
    build_legacy) scheduler=false ;;
    recovery_legacy) scheduler=true ;;
    *) printf '%s\n' 'PRODUCTION_ENV_RECONCILE_FAILURE=POLICY_NOT_ALLOWED' >&2; return 1 ;;
  esac
  local gates=(
    ERP_SYNC_SCHEDULER_ENABLED TENANCY_MODE TENANT_READ_PILOT_ENABLED
    DATABASE_SCHEMA_MODE SEED_ON_BOOTSTRAP ENABLE_PREVIEW_SEED ENABLE_SMOKE_BOOTSTRAP
  )

  [[ -f "$source_file" && ! -L "$source_file" && -f "$output_file" && ! -L "$output_file" ]] || {
    printf '%s\n' 'PRODUCTION_ENV_RECONCILE_FAILURE=FILE_METADATA' >&2; return 1;
  }
  awk '
    /^[[:space:]]*($|#)/ { next }
    /^[A-Za-z_][A-Za-z0-9_]*=/ { next }
    { exit 1 }
  ' "$source_file" || { printf '%s\n' 'PRODUCTION_ENV_RECONCILE_FAILURE=MALFORMED_LINE' >&2; return 1; }
  for gate in "${gates[@]}"; do
    [[ "$(awk -F= -v key="$gate" '$1==key{n++} END{print n+0}' "$source_file")" -le 1 ]] || {
      printf 'PRODUCTION_ENV_RECONCILE_FAILURE=%s_DUPLICATE\n' "$gate" >&2; return 1;
    }
  done

  cp -- "$source_file" "$output_file"; chmod 600 "$output_file"
  for replacement in \
    "ERP_SYNC_SCHEDULER_ENABLED=$scheduler" \
    TENANCY_MODE=disabled TENANT_READ_PILOT_ENABLED=false DATABASE_SCHEMA_MODE=external \
    SEED_ON_BOOTSTRAP=false ENABLE_PREVIEW_SEED=false ENABLE_SMOKE_BOOTSTRAP=false; do
    gate=${replacement%%=*}; tmp=$(mktemp "${output_file}.reconcile.XXXXXX")
    chmod 600 "$tmp"
    awk -F= -v key="$gate" -v replacement="$replacement" '
      $1==key { if (!done) print replacement; done=1; next }
      { print }
      END { if (!done) print replacement }
    ' "$output_file" >"$tmp"
    mv -f -- "$tmp" "$output_file"; chmod 600 "$output_file"
  done
  printf 'PRODUCTION_ENV_RECONCILE_POLICY=%s\n' "$policy" >&2
  printf '%s\n' 'PRODUCTION_ENV_RECONCILE_GATE_COUNT=7' >&2
}
