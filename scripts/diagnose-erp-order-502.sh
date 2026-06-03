#!/usr/bin/env bash
set -euo pipefail

SINCE="${SINCE:-2026-06-03T23:36:00Z}"
UNTIL="${UNTIL:-2026-06-03T23:46:00Z}"
CF_RAY="${CF_RAY:-a0628c3f28b9e033-GRU}"
OPPORTUNITY_ID="${OPPORTUNITY_ID:-cmpxbz8z60001b88y2apepoln}"
ENDPOINT_REGEX="${ENDPOINT_REGEX:-opportunities/${OPPORTUNITY_ID}/erp/orders}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

section() {
  printf '\n==== %s ====\n' "$1"
}

filter_endpoint() {
  rg -n --color never "${CF_RAY}|${ENDPOINT_REGEX}|erp order|ultrafv3|UltraFV3|/salesmen|/orders|origin_bad_gateway|502|timeout|restart|exited|OOM|Killed" || true
}

section "Docker containers"
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' | filter_endpoint

section "API container inspect/state"
API_CONTAINER="${API_CONTAINER:-$(docker compose -f "$COMPOSE_FILE" ps -q api 2>/dev/null || true)}"
if [[ -n "$API_CONTAINER" ]]; then
  docker inspect "$API_CONTAINER" --format 'name={{.Name}} status={{.State.Status}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} restarts={{.RestartCount}} oomKilled={{.State.OOMKilled}} exitCode={{.State.ExitCode}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}'
else
  echo "API container not found via docker compose -f $COMPOSE_FILE ps -q api"
fi

section "Docker events around incident"
docker events --since "$SINCE" --until "$UNTIL" --filter container="$API_CONTAINER" 2>/dev/null | filter_endpoint

section "API logs around incident"
if [[ -n "$API_CONTAINER" ]]; then
  docker logs --since "$SINCE" --until "$UNTIL" "$API_CONTAINER" 2>&1 | filter_endpoint
else
  docker compose -f "$COMPOSE_FILE" logs --since "$SINCE" --until "$UNTIL" api 2>&1 | filter_endpoint
fi

section "Nginx journal around incident"
if command -v journalctl >/dev/null 2>&1; then
  journalctl -u nginx --since "$SINCE" --until "$UNTIL" --no-pager 2>/dev/null | filter_endpoint
else
  echo "journalctl not available"
fi

section "Nginx access/error logs around incident"
for file in /var/log/nginx/access.log /var/log/nginx/error.log /var/log/nginx/*access*.log /var/log/nginx/*error*.log; do
  [[ -r "$file" ]] || continue
  echo "-- $file"
  rg -n --color never "${CF_RAY}|${ENDPOINT_REGEX}|502|upstream|timeout|connect\(\)|prematurely closed" "$file" || true
 done

section "Health after incident"
if [[ -n "$API_CONTAINER" ]]; then
  docker exec "$API_CONTAINER" node -e "require('http').get('http://127.0.0.1:4000/health',res=>{console.log('api health',res.statusCode);res.resume();}).on('error',err=>{console.error(err.message);process.exit(1)})" || true
fi
