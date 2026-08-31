#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only UltraFV3 reachability probe. It never authenticates and never calls
# order-write endpoint. Keep the URL in the environment so it cannot leak through argv.
: "${ULTRAFV3_BASE_URL:?ULTRAFV3_BASE_URL is required}"
timeout_seconds=${ULTRAFV3_REACHABILITY_TIMEOUT_SECONDS:-5}
state_file=${ULTRAFV3_REACHABILITY_STATE_FILE:-/var/run/gest-o/ultrafv3-reachability.json}
[[ $timeout_seconds =~ ^[1-9]$|^10$ ]] || { echo 'ERP_REACHABILITY_CONFIGURATION=INVALID' >&2; exit 2; }
correlation_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
started=$(date +%s%3N)
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
status=unavailable; reason=connect
http=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --connect-timeout "$timeout_seconds" --max-time "$timeout_seconds" \
  --request GET --header "X-Correlation-Id: $correlation_id" \
  "${ULTRAFV3_BASE_URL%/}/salesmen" 2>"$tmp") && curl_rc=0 || curl_rc=$?
case "$curl_rc:$http" in
  0:2??|0:401|0:403) status=available; reason=$([[ $http == 401 || $http == 403 ]] && echo auth || echo ok) ;;
  28:*) reason=timeout ;;
  0:5??) reason=5xx ;;
  *) reason=connect ;;
esac
duration=$(($(date +%s%3N)-started))
mkdir -p "$(dirname "$state_file")"
printf '{"contractVersion":"1.0","status":"%s","reason":"%s","endpointClass":"ultrafv3_read_only","durationMs":%d,"correlationId":"%s","checkedAt":"%s"}\n' \
  "$status" "$reason" "$duration" "$correlation_id" "$(date -u +%FT%TZ)" >"$tmp.state"
chmod 600 "$tmp.state"; mv "$tmp.state" "$state_file"
printf 'ERP_REACHABILITY correlationId=%s endpointClass=ultrafv3_read_only status=%s reason=%s durationMs=%d\n' "$correlation_id" "$status" "$reason" "$duration"
[[ $status == available ]]
