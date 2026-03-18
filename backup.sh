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

query_count() {
  local table_name="$1"
  docker compose exec -T db psql -U postgres -d "$DB_NAME" -tA -c "SELECT COUNT(*) FROM \"${table_name}\";" | tr -d '[:space:]'
}

cleanup_rejected_backup() {
  local rejected_file="$1"
  rm -f "$rejected_file" "${rejected_file}.gz"
  log "ERROR" "Backup rejeitado: banco inconsistente"
}

validate_database_after_dump() {
  local user_count client_count opportunity_count

  user_count="$(query_count "User")"
  client_count="$(query_count "Client")"
  opportunity_count="$(query_count "Opportunity")"

  log "INFO" "[SAFEGUARD] Pós-dump | User=${user_count} | Client=${client_count} | Opportunity=${opportunity_count}"

  if ! [[ "$user_count" =~ ^[0-9]+$ && "$client_count" =~ ^[0-9]+$ && "$opportunity_count" =~ ^[0-9]+$ ]]; then
    log "ERROR" "[CRITICAL] Contagens inválidas detectadas na validação pós-dump"
    return 1
  fi

  if [ "$user_count" -eq 0 ]; then
    log "ERROR" "[CRITICAL] User == 0 na validação pós-dump"
    return 1
  fi

  if [ "$client_count" -eq 0 ] && [ "$opportunity_count" -eq 0 ]; then
    log "ERROR" "[CRITICAL] Client == 0 e Opportunity == 0 na validação pós-dump"
    return 1
  fi

  return 0
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

mkdir -p "$BACKUP_DIR"
cd /apps/gest-o

if ! docker compose exec -T db pg_dump -U postgres "$DB_NAME" > "$BACKUP_FILE"; then
  cleanup_rejected_backup "$BACKUP_FILE"
  log "ERROR" "Backup failed: pg_dump command failed for database '$DB_NAME'."
  exit 1
fi

if ! validate_database_after_dump; then
  cleanup_rejected_backup "$BACKUP_FILE"
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
