#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only inventory for the filesystem used by Prepare Production Recovery Backup.
# The optional argument is the effective PRODUCTION_MIN_DISK_KB reported by the run.
readonly BACKUP_DIR=/root/backups
readonly HISTORICAL_DIR=/var/backups/gest-o/automatic
readonly BUNDLE_ROOT=/var/log/gest-o/backup
readonly PREVIEW_DIR=/var/www/preview
readonly REQUIRED_KB="${1:-5242880}"

[[ "$REQUIRED_KB" =~ ^[0-9]+$ ]]
[[ -d "$BACKUP_DIR" ]]

read -r total_kb used_kb available_kb capacity filesystem < <(
  df -Pk -- "$BACKUP_DIR" | awk 'END{print $2, $3, $4, $5, $6}'
)
read -r total_inodes used_inodes available_inodes inode_capacity < <(
  df -Pi -- "$BACKUP_DIR" | awk 'END{print $2, $3, $4, $5}'
)
[[ "$total_kb" =~ ^[0-9]+$ && "$used_kb" =~ ^[0-9]+$ && "$available_kb" =~ ^[0-9]+$ ]]
[[ "$total_inodes" =~ ^[0-9]+$ && "$used_inodes" =~ ^[0-9]+$ && "$available_inodes" =~ ^[0-9]+$ ]]
deficit_kb=$(( REQUIRED_KB > available_kb ? REQUIRED_KB - available_kb : 0 ))

printf '%s\n' '== BACKUP FILESYSTEM =='
printf 'filesystem=%s total_kb=%s used_kb=%s available_kb=%s capacity=%s\n' \
  "$filesystem" "$total_kb" "$used_kb" "$available_kb" "$capacity"
printf 'total_inodes=%s used_inodes=%s available_inodes=%s inode_capacity=%s\n' \
  "$total_inodes" "$used_inodes" "$available_inodes" "$inode_capacity"
printf 'required_kb=%s deficit_kb=%s capacity_gate_pass=%s\n' \
  "$REQUIRED_KB" "$deficit_kb" "$(( available_kb >= REQUIRED_KB ))"

printf '%s\n' '== DIRECTORY USAGE (KiB; metadata only) =='
for directory in "$BACKUP_DIR" "$HISTORICAL_DIR" "$BUNDLE_ROOT" "$PREVIEW_DIR"; do
  if [[ -d "$directory" ]]; then
    printf '%s\n' "directory=$directory"
    du -x -k -d 2 -- "$directory" 2>/dev/null | sort -n
  else
    printf 'directory=%s state=absent\n' "$directory"
  fi
done

printf '%s\n' '== BACKUP DESTINATION FILESYSTEMS =='
for directory in "$BACKUP_DIR" "$HISTORICAL_DIR" "$BUNDLE_ROOT"; do
  if [[ ! -d "$directory" ]]; then
    printf 'directory=%s state=absent\n' "$directory"
    continue
  fi
  printf 'directory=%s\n' "$directory"
  findmnt -T "$directory" -o TARGET,SOURCE,FSTYPE,OPTIONS -n
  df -Pk -- "$directory" | awk 'END{printf "blocks_kb=%s used_kb=%s available_kb=%s capacity=%s filesystem=%s\n",$2,$3,$4,$5,$6}'
  df -Pi -- "$directory" | awk 'END{printf "inodes=%s used_inodes=%s available_inodes=%s inode_capacity=%s\n",$2,$3,$4,$5}'
done

printf '%s\n' '== BACKUP OBJECTS (metadata only; device+inode expose shared files) =='
for directory in "$BACKUP_DIR" "$HISTORICAL_DIR" "$BUNDLE_ROOT"; do
  [[ -d "$directory" ]] || continue
  find "$directory" -xdev -type f -printf 'path=%p\tbytes=%s\tmtime=%TY-%Tm-%TdT%TH:%TM:%TSZ\tdevice=%D\tinode=%i\tlinks=%n\n' 2>/dev/null | sort
done

printf '%s\n' '== PROTECTED LATEST REFERENCE =='
latest_result="$BUNDLE_ROOT/latest/result.tsv"
if [[ -L "$BUNDLE_ROOT/latest" || -L "$latest_result" ]]; then
  printf '%s\n' 'latest_state=symlink_rejected'
elif [[ -f "$latest_result" ]]; then
  stat -c 'latest_state=regular mode=%a owner=%U:%G bytes=%s mtime=%y device=%d inode=%i links=%h' -- "$latest_result"
  # Values are allowlisted: no paths, identities, credentials or dump contents.
  awk -F '\t' '$1=="FORMAT"||$1=="STATUS"||$1=="BUNDLE_ID"||$1=="CREATED_AT_EPOCH"||$1=="SHA" {print "latest_" tolower($1) "=" $2}' "$latest_result"
else
  printf '%s\n' 'latest_state=absent'
fi

printf '%s\n' '== SCHEDULERS (read-only; definitions may be inactive) =='
# Do not echo command lines: cron definitions can contain inline secrets.
crontab -l 2>/dev/null | awk 'BEGIN{IGNORECASE=1} /backup|gest-o/{print "root_crontab_backup_entry_line=" NR; found=1} END{if(!found) print "root_crontab_backup_entries=absent"}' \
  || printf '%s\n' 'root_crontab_backup_entries=unavailable'
systemctl list-timers --all --no-pager 2>/dev/null | sed -n '/backup\|gest-o/ip' || printf '%s\n' 'systemd_backup_timers=absent_or_unavailable'
find /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly -maxdepth 1 -type f \
  \( -iname '*backup*' -o -iname '*gest-o*' \) -printf 'scheduler_file=%p\n' 2>/dev/null | sort

printf '%s\n' '== PREVIEW OWNERSHIP LABELS =='
docker ps -a --filter label=com.gesto.preview=true \
  --format 'container={{.ID}} project={{.Label "com.docker.compose.project"}} pr={{.Label "com.gesto.preview.pr"}} run={{.Label "com.gesto.preview.run-id"}} status={{.Status}} image={{.Image}}'
docker volume ls --filter label=com.gesto.preview=true \
  --format 'volume={{.Name}} project={{.Label "com.docker.compose.project"}} pr={{.Label "com.gesto.preview.pr"}} run={{.Label "com.gesto.preview.run-id"}}'
docker network ls --filter label=com.gesto.preview=true \
  --format 'network={{.Name}} project={{.Label "com.docker.compose.project"}} pr={{.Label "com.gesto.preview.pr"}} run={{.Label "com.gesto.preview.run-id"}}'

printf '%s\n' '== DOCKER USAGE =='
docker system df
docker system df -v
printf '%s\n' 'NOTE: Docker image shared sizes are not additive; use only the reported reclaimable total.'

printf '%s\n' '== LARGE TOP-LEVEL DIRECTORIES ON THE SAME FILESYSTEM (bounded to 60s) =='
if ! timeout 60s nice -n 10 du -x -k -d 1 -- / 2>/dev/null | sort -n; then
  printf '%s\n' 'top_level_scan=timed_out_or_incomplete'
fi
