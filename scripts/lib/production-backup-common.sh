#!/usr/bin/env bash

# Shared, side-effect-free validation primitives used by the historical backup
# job and by the protected recovery-backup preparation procedure.
PRODUCTION_BACKUP_MIN_SIZE_BYTES="${PRODUCTION_BACKUP_MIN_SIZE_BYTES:-51200}"

backup_resolve_health_check() {
  local primary="${BACKUP_HEALTH_CHECK_PRIMARY:-/apps/gest-o/scripts/check-prod-health.sh}"
  local fallback="${BACKUP_HEALTH_CHECK_FALLBACK:-./scripts/check-prod-health.sh}"
  [[ -x "$primary" ]] && { printf '%s\n' "$primary"; return; }
  [[ -x "$fallback" ]] && { printf '%s\n' "$fallback"; return; }
  return 1
}

backup_validate_database_health() {
  local check snapshot
  check="$(backup_resolve_health_check)" || return 1
  snapshot="$(bash "$check" --format shell --strict)" || return 1
  # check-prod-health emits only integer assignments from a closed contract.
  eval "$snapshot"
  [[ "${USER_COUNT:-0}" -gt 0 ]] || return 1
  (( ${CLIENT_COUNT:-0} + ${OPPORTUNITY_COUNT:-0} + ${TIMELINE_EVENT_COUNT:-0} > 0 ))
}

backup_validate_plain_dump() {
  local file=$1 size
  [[ -f "$file" && ! -L "$file" ]] || return 1
  size="$(stat -c %s "$file")"
  (( size >= PRODUCTION_BACKUP_MIN_SIZE_BYTES )) || return 1
  grep -aFq 'PostgreSQL database dump' "$file" || return 1
  grep -aEq '^(CREATE TABLE|COPY |INSERT INTO )' "$file"
}

backup_validate_gzip_dump() {
  local file=$1
  [[ -f "$file" && ! -L "$file" ]] || return 1
  gzip -t "$file" || return 1
  # awk consumes the complete stream, avoiding grep -q/SIGPIPE false failures
  # under pipefail while checking both the header and useful catalog/data SQL.
  gzip -cd "$file" | awk '
    index($0,"PostgreSQL database dump"){header=1}
    /^(CREATE TABLE|COPY |INSERT INTO )/{content=1}
    END{exit !(header && content)}'
}
