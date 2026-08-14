#!/bin/bash
set -euo pipefail

# shellcheck source=scripts/lib/production-backup-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/lib/production-backup-common.sh"

BACKUP_DIR="/root/backups"
LOG_FILE="$BACKUP_DIR/backup.log"
DB_NAME="salesforce_pro"
MIN_SIZE_BYTES=$((50 * 1024))
MAX_BACKUPS=48
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql"
COMPRESSED_FILE="${BACKUP_FILE}.gz"
CHECK_SCRIPT_PRIMARY="/apps/gest-o/scripts/check-prod-health.sh"
CHECK_SCRIPT_FALLBACK="./scripts/check-prod-health.sh"

log() {
  local level="$1"
  local message="$2"
  printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$message" | tee -a "$LOG_FILE"
}

cleanup_rejected_backup() {
  local rejected_file="$1"
  rm -f "$rejected_file" "${rejected_file}.gz"
}

rotate_backups() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}_*.sql.gz" -printf '%T@ %p\n' \
    | sort -rn \
    | tail -n +$((MAX_BACKUPS + 1)) \
    | cut -d' ' -f2- \
    | while IFS= read -r old_backup; do
        [ -n "$old_backup" ] || continue
        rm -f "$old_backup"
        log "INFO" "Removed old backup: $old_backup"
      done

  local current_count
  current_count=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}_*.sql.gz" | wc -l)
  log "INFO" "Backup rotation complete. Backups retained: ${current_count}."
}

resolve_check_script() {
  if [[ -x "$CHECK_SCRIPT_PRIMARY" ]]; then
    echo "$CHECK_SCRIPT_PRIMARY"
    return
  fi

  if [[ -x "$CHECK_SCRIPT_FALLBACK" ]]; then
    echo "$CHECK_SCRIPT_FALLBACK"
    return
  fi

  return 1
}

validate_database_health_or_reject() {
  if ! BACKUP_HEALTH_CHECK_PRIMARY="$CHECK_SCRIPT_PRIMARY" BACKUP_HEALTH_CHECK_FALLBACK="$CHECK_SCRIPT_FALLBACK" backup_validate_database_health; then
    log "CRITICAL" "Backup rejeitado: banco inconsistente"
    exit 1
  fi
  log "INFO" "Validation counts passed (values omitted)."
}

mkdir -p "$BACKUP_DIR"
cd /apps/gest-o

validate_database_health_or_reject

if ! docker compose exec -T db pg_dump -U postgres "$DB_NAME" > "$BACKUP_FILE"; then
  cleanup_rejected_backup "$BACKUP_FILE"
  log "ERROR" "Backup failed: pg_dump command failed for database '$DB_NAME'."
  exit 1
fi

validate_database_health_or_reject

file_size=$(stat -c%s "$BACKUP_FILE")
if ! PRODUCTION_BACKUP_MIN_SIZE_BYTES="$MIN_SIZE_BYTES" backup_validate_plain_dump "$BACKUP_FILE"; then
  log "ERROR" "Backup rejected: dump failed content or minimum-size validation."
  cleanup_rejected_backup "$BACKUP_FILE"
  exit 1
fi

if ! gzip -f "$BACKUP_FILE"; then
  cleanup_rejected_backup "$BACKUP_FILE"
  log "ERROR" "Backup failed: unable to compress dump file '${BACKUP_FILE}'."
  exit 1
fi

gzip -t "$COMPRESSED_FILE" || { cleanup_rejected_backup "$BACKUP_FILE"; exit 1; }
log "INFO" "Backup created and validated successfully."
rotate_backups
