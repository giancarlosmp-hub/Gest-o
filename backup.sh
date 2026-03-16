#!/bin/bash
set -euo pipefail

BACKUP_DIR="/root/backups"
LOG_FILE="$BACKUP_DIR/backup.log"
DB_NAME="salesforce_pro"
MIN_SIZE_BYTES=$((50 * 1024))
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql"
COMPRESSED_FILE="${BACKUP_FILE}.gz"

log() {
  local level="$1"
  local message="$2"
  printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$message" | tee -a "$LOG_FILE"
}

mkdir -p "$BACKUP_DIR"

cd /apps/gest-o

if ! docker compose exec -T db pg_dump -U postgres "$DB_NAME" > "$BACKUP_FILE"; then
  rm -f "$BACKUP_FILE"
  log "ERROR" "Backup failed: pg_dump command failed for database '$DB_NAME'."
  exit 1
fi

FILE_SIZE=$(stat -c%s "$BACKUP_FILE")
if [ "$FILE_SIZE" -lt "$MIN_SIZE_BYTES" ]; then
  rm -f "$BACKUP_FILE"
  log "ERROR" "Backup failed: file too small (${FILE_SIZE} bytes, expected >= ${MIN_SIZE_BYTES} bytes)."
  exit 1
fi

gzip -f "$BACKUP_FILE"
log "INFO" "Backup created successfully: $COMPRESSED_FILE (${FILE_SIZE} bytes before compression)."

# Keep only the 48 most recent compressed backups.
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}_*.sql.gz" -printf '%T@ %p\n' \
  | sort -rn \
  | tail -n +49 \
  | cut -d' ' -f2- \
  | while IFS= read -r old_backup; do
      [ -n "$old_backup" ] || continue
      rm -f "$old_backup"
      log "INFO" "Removed old backup: $old_backup"
    done

CURRENT_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}_*.sql.gz" | wc -l)
log "INFO" "Backup rotation complete. Backups retained: ${CURRENT_COUNT}."
