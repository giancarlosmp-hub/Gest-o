#!/usr/bin/env bash
set -euo pipefail
EVIDENCE_DIR="${EVIDENCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
ENV_FILE="${PRODUCTION_ENV_FILE:-/root/demetra-env/production.env}"
APP_DIR="${APP_DIR:-/apps/gest-o}"
log_file="$EVIDENCE_DIR/rollback-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$log_file") 2>&1
log(){ printf '[production-rollback] %s\n' "$*"; }
die(){ log "ERRO: $*"; exit 1; }
[[ -f "$ENV_FILE" ]] || die "arquivo seguro ausente"
[[ -s "$EVIDENCE_DIR/old-containers.txt" ]] || die "inventário de containers anteriores ausente"
cd "$APP_DIR"; set -a; source "$ENV_FILE"; set +a
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_VOLUME_EXPECTED:?PRODUCTION_DB_VOLUME_EXPECTED is required}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.production.yml)
mapfile -t old < <(sed '/^[[:space:]]*$/d' "$EVIDENCE_DIR/old-containers.txt")
[[ ${#old[@]} -gt 0 ]] || die "nenhum container anterior registrado"

log "Parando somente API/WEB novos antes de restaurar os anteriores"
"${COMPOSE[@]}" stop api web
for port in 4000 5173; do
  for _ in {1..30}; do
    owner=$(docker ps --format '{{.Names}}|{{.Ports}}' | awk -F'|' -v p=":$port->" '$2~p{print $1;exit}')
    [[ -z "$owner" ]] && break
    printf '%s\n' "${old[@]}" | grep -Fxq "$owner" && break
    sleep 1
  done
  owner=$(docker ps --format '{{.Names}}|{{.Ports}}' | awk -F'|' -v p=":$port->" '$2~p{print $1;exit}')
  if [[ -n "$owner" ]] && ! printf '%s\n' "${old[@]}" | grep -Fxq "$owner"; then die "porta $port não foi liberada pelo container novo"; fi
done

log "Iniciando somente containers anteriores registrados"
for container in "${old[@]}"; do docker start "$container" >/dev/null; done
for _ in {1..60}; do curl -fsS http://127.0.0.1:4000/health >/dev/null && break; sleep 2; done
curl -fsS http://127.0.0.1:4000/health >/dev/null || die "API anterior sem health"
for _ in {1..30}; do curl -fsS http://127.0.0.1:5173/ >/dev/null && break; sleep 2; done
curl -fsS http://127.0.0.1:5173/ >/dev/null || die "WEB anterior sem resposta"

[[ "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")" == true ]] || die "PostgreSQL esperado deixou de executar"
docker inspect -f '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" |
  awk -v v="$PRODUCTION_DB_VOLUME_EXPECTED" '$1==v && $2=="/var/lib/postgresql/data"{ok=1} END{exit !ok}' || die "volume/mount PostgreSQL divergente"
log "Rollback concluído; PostgreSQL permaneceu running com o volume esperado"
