#!/bin/bash
set -euo pipefail

BACKUP_DIR="/root/backups"
LOG_FILE="$BACKUP_DIR/backup.log"
DB_NAME="salesforce_pro"
MIN_SIZE_BYTES=$((50 * 1024))
MAX_BACKUPS=48
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql"
COMPRESSED_FILE="${BACKUP_FILE}.gz"

log() {
  local level="$1"
  local message="$2"
  printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$message" | tee -a "$LOG_FILE"
}

# Execute SQL inside the database container and return only the numeric result.
query_count() {
  local table_name="$1"
  docker compose exec -T db psql -U postgres -d "$DB_NAME" -tA -c "SELECT COUNT(*) FROM \"${table_name}\";" | tr -d '[:space:]'
}

# Validate if the source database has minimum business content before creating a trusted backup.
# Rules:
# 1) User table cannot be empty.
# 2) Client + Opportunity + TimelineEvent cannot all be zero simultaneously.
validate_database_content() {
  local client_count opportunity_count timeline_event_count user_count

  client_count="$(query_count "Client")"
  opportunity_count="$(query_count "Opportunity")"
  timeline_event_count="$(query_count "TimelineEvent")"
  user_count="$(query_count "User")"

  log "INFO" "Validation counts | User=${user_count} | Client=${client_count} | Opportunity=${opportunity_count} | TimelineEvent=${timeline_event_count}"

  if [ -z "$user_count" ] || [ -z "$client_count" ] || [ -z "$opportunity_count" ] || [ -z "$timeline_event_count" ]; then
    log "ERROR" "Backup rejected: failed to obtain validation counts from database."
    return 1
  fi

  if ! [[ "$user_count" =~ ^[0-9]+$ && "$client_count" =~ ^[0-9]+$ && "$opportunity_count" =~ ^[0-9]+$ && "$timeline_event_count" =~ ^[0-9]+$ ]]; then
    log "ERROR" "Backup rejected: validation counts are not numeric."
    return 1
  fi

  if [ "$user_count" -eq 0 ]; then
    log "ERROR" "Backup rejected: table 'User' has zero records."
    return 1
  fi

  if [ "$client_count" -eq 0 ] && [ "$opportunity_count" -eq 0 ] && [ "$timeline_event_count" -eq 0 ]; then
    log "ERROR" "Backup rejected: tables 'Client', 'Opportunity' and 'TimelineEvent' are all zero simultaneously."
    return 1
  fi

  return 0
}

cleanup_rejected_backup() {
  local rejected_file="$1"
  rm -f "$rejected_file" "${rejected_file}.gz"
  log "ERROR" "Rejected backup file removed: ${rejected_file}"
}

rotate_backups() {
  # Rotation only runs after a valid backup is finalized.
  # This prevents recent good backups from being removed due to a failed run.
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

mkdir -p "$BACKUP_DIR"
cd /apps/gest-o

if ! validate_database_content; then
  cleanup_rejected_backup "$BACKUP_FILE"
  exit 1
fi

if ! docker compose exec -T db pg_dump -U postgres "$DB_NAME" > "$BACKUP_FILE"; then
  cleanup_rejected_backup "$BACKUP_FILE"
  log "ERROR" "Backup failed: pg_dump command failed for database '$DB_NAME'."
  exit 1
fi

file_size=$(stat -c%s "$BACKUP_FILE")
if [ "$file_size" -lt "$MIN_SIZE_BYTES" ]; then
  log "ERROR" "Backup rejected: dump too small (${file_size} bytes, expected >= ${MIN_SIZE_BYTES} bytes). File: ${BACKUP_FILE}"
  cleanup_rejected_backup "$BACKUP_FILE"
  exit 1
fi

if ! gzip -f "$BACKUP_FILE"; then
  cleanup_rejected_backup "$BACKUP_FILE"
  log "ERROR" "Backup failed: unable to compress dump file '${BACKUP_FILE}'."
  exit 1
fi

log "INFO" "Backup created successfully: $COMPRESSED_FILE (${file_size} bytes before compression)."
rotate_backups
