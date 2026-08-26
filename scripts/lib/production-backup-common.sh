#!/usr/bin/env bash

# Shared, side-effect-free validation primitives used by the historical backup
# job and by the protected recovery-backup preparation procedure.
PRODUCTION_BACKUP_MIN_SIZE_BYTES="${PRODUCTION_BACKUP_MIN_SIZE_BYTES:-51200}"

# Single promoted-backup contract.  The directory is the authority; path values
# loaded from an old environment file are assertions, never selectors.
backup_bind_canonical_pair() {
  local directory=${PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY:-${PRODUCTION_BACKUP_AUTHORIZED_DIR:-/root/backups}}
  [[ "$directory" == /* && "$directory" != / && -d "$directory" && ! -L "$directory" ]] || return 1
  [[ "$(readlink -m -- "$directory")" == "$directory" ]] || return 1
  PRODUCTION_BACKUP_CANONICAL_DIRECTORY=$directory
  PRODUCTION_BACKUP_CANONICAL_FILE="$directory/production.sql.gz"
  PRODUCTION_BACKUP_CANONICAL_SHA256_FILE="$directory/production.sql.gz.sha256"
}

backup_validate_canonical_pair_and_freshness() {
  local supplied_file=$1 supplied_manifest=$2 max_age=$3
  local before after timestamp now age expected
  backup_bind_canonical_pair || return 1
  [[ "$supplied_file" == "$PRODUCTION_BACKUP_CANONICAL_FILE" &&
     "$supplied_manifest" == "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" ]] || return 2
  [[ "$max_age" =~ ^[0-9]+$ && "$max_age" -gt 0 ]] || return 3
  [[ -f "$supplied_file" && ! -L "$supplied_file" && -f "$supplied_manifest" && ! -L "$supplied_manifest" ]] || return 4
  expected=$(basename -- "$supplied_file")
  awk -v expected="$expected" 'NF != 2 || length($1) != 64 || $1 !~ /^[0-9a-f]+$/ || $2 != expected {exit 1} {n++} END{exit n == 1 ? 0 : 1}' "$supplied_manifest" || return 5
  before=$(stat -c '%d:%i:%s:%Y' -- "$supplied_file") || return 6
  (cd "$PRODUCTION_BACKUP_CANONICAL_DIRECTORY" && sha256sum -c "$(basename -- "$supplied_manifest")" >/dev/null) || return 7
  after=$(stat -c '%d:%i:%s:%Y' -- "$supplied_file") || return 8
  [[ "$before" == "$after" ]] || return 9
  timestamp=${after##*:}; now=$(date +%s)
  [[ "$timestamp" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || return 10
  age=$((now - timestamp))
  (( age >= 0 )) || return 11
  printf 'PRODUCTION_BACKUP_CANONICAL_PAIR=VALIDATED\n'
  printf 'PRODUCTION_BACKUP_TIMESTAMP_SOURCE=VALIDATED\n'
  printf 'PRODUCTION_BACKUP_AGE_SECONDS=%s\n' "$age"
  printf 'PRODUCTION_BACKUP_MAX_AGE_SECONDS=%s\n' "$max_age"
  (( age <= max_age )) || return 12
  printf 'PRODUCTION_BACKUP_FRESHNESS=PASS\n'
}

backup_resolve_health_check() {
  local primary="${BACKUP_HEALTH_CHECK_PRIMARY:-/apps/gest-o/scripts/check-prod-health.sh}"
  local fallback="${BACKUP_HEALTH_CHECK_FALLBACK:-./scripts/check-prod-health.sh}"
  [[ -x "$primary" ]] && { printf '%s\n' "$primary"; return; }
  [[ -x "$fallback" ]] && { printf '%s\n' "$fallback"; return; }
  return 1
}

backup_validate_database_health() {
  local check snapshot rc
  check="$(backup_resolve_health_check)" || return 1
  if [[ -n "${BACKUP_POSTGRES_ERROR_FILE:-}" ]]; then
    if snapshot="$(bash "$check" --format shell --strict 2>"$BACKUP_POSTGRES_ERROR_FILE")"; then
      :
    else
      rc=$?
      return "$rc"
    fi
  else
    snapshot="$(bash "$check" --format shell --strict)" || return $?
  fi
  # check-prod-health emits only integer assignments from a closed contract.
  eval "$snapshot"
  [[ "${USER_COUNT:-0}" -gt 0 ]] || return 1
  (( ${CLIENT_COUNT:-0} + ${OPPORTUNITY_COUNT:-0} + ${TIMELINE_EVENT_COUNT:-0} > 0 ))
}

# Recovery preparation must never inherit the historical Compose-db strategy.
# Its caller supplies the exact, already validated container name; the health
# reader uses docker exec directly and keeps the historical backup behavior
# unchanged when backup_validate_database_health is called without this wrapper.
backup_validate_database_health_in_validated_container() {
  local validated_container=$1
  [[ "$validated_container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || return 1
  DB_VALIDATED_CONTAINER="$validated_container" backup_validate_database_health
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
