#!/usr/bin/env bash

sanitize_orders_migration_log() {
  local input=$1 output=$2
  sed -E \
    -e "s#postgresql://[^[:space:]\"']+#postgresql://[REDACTED]#g" \
    -e 's/(password|token|secret)=?[^[:space:]]*/\1=[REDACTED]/Ig' \
    -e 's/(host|user(name)?)[=:][^[:space:]]+/\1=[REDACTED]/Ig' \
    "$input" >"$output"
}

report_orders_migration_failure() {
  local rc=$1 log=$2 step=$3 phase=$4 name=$5 kind=$6 sanitized=$7
  sanitize_orders_migration_log "$log" "$sanitized"
  chmod 600 "$sanitized"
  local code message
  # awk reads the complete file: no early-closing consumer can turn a useful
  # diagnostic into SIGPIPE under the caller's pipefail shell.
  code=$(awk 'match($0,/P[0-9]{4}|SQLSTATE[ =:]+[0-9A-Z]{5}|PostgreSQL error code: [0-9A-Z]+/){if(!found){print substr($0,RSTART,RLENGTH);found=1}}' "$sanitized")
  message=$(awk '/Error:|ERROR:|error:|relation |Migration /{lines[++n]=$0} END{start=n-4;if(start<1)start=1;for(i=start;i<=n;i++)printf "%s%s",lines[i],(i<n?" ":"")}' "$sanitized" | sed -E 's/[[:space:]]+/ /g')
  printf 'ORDERS_MIGRATION_STEP=%s\n' "$step" >&2
  printf 'ORDERS_MIGRATION_PHASE=%s\n' "$phase" >&2
  printf 'ORDERS_MIGRATION_NAME=%s\n' "$name" >&2
  printf 'ORDERS_MIGRATION_COMMAND_KIND=%s\n' "$kind" >&2
  printf 'ORDERS_MIGRATION_ERROR_CODE=%s\n' "${code:-EXIT_$rc}" >&2
  printf 'ORDERS_MIGRATION_ERROR_MESSAGE=%s\n' "${message:-command failed; sanitized diagnostic contained no recognized error line}" >&2
  printf 'ORDERS_MIGRATION_RESULT=FAIL\n' >&2
  tail -40 "$sanitized" >&2
  return "$rc"
}
