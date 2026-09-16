#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only and sanitized: report scheduler metadata, never command bodies,
# environment assignments, credentials, arguments or file contents.
echo 'PREVIEW_SCHEDULER_DIAGNOSTIC=START read_only=true'

if command -v systemctl >/dev/null 2>&1; then
  timers=$(systemctl list-timers --all --no-legend --no-pager 2>/dev/null || true)
  timer_count=$(printf '%s\n' "$timers" | awk 'NF{n++} END{print n+0}')
  relevant_count=$(printf '%s\n' "$timers" | awk 'BEGIN{IGNORECASE=1} /gest-o|gesto|preview|docker|cleanup/{n++} END{print n+0}')
  echo "SYSTEMD_TIMERS_TOTAL=${timer_count}"
  echo "SYSTEMD_TIMERS_RELEVANT_NAME_MATCHES=${relevant_count}"
else
  echo 'SYSTEMD_TIMERS=UNAVAILABLE'
fi

inspect_crontab() {
  local scope=$1
  shift
  local content rc
  set +e
  content=$("$@" 2>/dev/null)
  rc=$?
  set -e
  if (( rc != 0 )); then echo "CRONTAB_${scope}=UNAVAILABLE"; return; fi
  echo "CRONTAB_${scope}_ACTIVE_LINES=$(printf '%s\n' "$content" | awk '!/^[[:space:]]*(#|$)/{n++} END{print n+0}')"
  echo "CRONTAB_${scope}_RELEVANT_MATCHES=$(printf '%s\n' "$content" | awk 'BEGIN{IGNORECASE=1}!/^[[:space:]]*#/ && /gest-o|gesto|preview|docker|cleanup/{n++} END{print n+0}')"
  echo "CRONTAB_${scope}_SHA256=$(printf '%s' "$content" | sha256sum | awk '{print $1}')"
}
inspect_crontab CURRENT_USER crontab -l
if (( EUID == 0 )); then inspect_crontab ROOT crontab -u root -l; else echo 'CRONTAB_ROOT=NOT_OBSERVED_REQUIRES_ROOT'; fi

for directory in /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/systemd/system /usr/lib/systemd/system; do
  if [[ -d "$directory" && -r "$directory" ]]; then
    count=$(find "$directory" -maxdepth 1 -type f -printf '.\n' 2>/dev/null | wc -l)
    relevant=$(find "$directory" -maxdepth 1 -type f \( -iname '*gest*' -o -iname '*preview*' -o -iname '*docker*' -o -iname '*cleanup*' \) -printf '.\n' 2>/dev/null | wc -l)
    key=$(printf '%s' "$directory" | tr '/.' '__' | tr '[:lower:]' '[:upper:]')
    echo "SCHEDULER_DIR${key}_FILES=${count}"
    echo "SCHEDULER_DIR${key}_RELEVANT_NAME_MATCHES=${relevant}"
  else
    echo "SCHEDULER_DIR=$(printf '%s' "$directory" | tr -c '[:alnum:]_/-' '_') state=UNAVAILABLE"
  fi
done
echo 'PREVIEW_SCHEDULER_DIAGNOSTIC=PASS contents_disclosed=false'
