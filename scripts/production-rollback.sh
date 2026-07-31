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
[[ -s "$EVIDENCE_DIR/rollback-images.env" ]] || die "tags de rollback ausentes"
[[ -s "$EVIDENCE_DIR/previous-runtime.tsv" ]] || die "inventário anterior ausente"
cd "$APP_DIR"; set -a; source "$ENV_FILE"; source "$EVIDENCE_DIR/rollback-images.env"; set +a
: "${API_ROLLBACK_IMAGE:?API_ROLLBACK_IMAGE is required}"
: "${WEB_ROLLBACK_IMAGE:?WEB_ROLLBACK_IMAGE is required}"
: "${API_ROLLBACK_IMAGE_ID:?API_ROLLBACK_IMAGE_ID is required}"
: "${WEB_ROLLBACK_IMAGE_ID:?WEB_ROLLBACK_IMAGE_ID is required}"
: "${ROLLBACK_APP_COMMIT:?ROLLBACK_APP_COMMIT is required}"
: "${ROLLBACK_APP_VERSION:?ROLLBACK_APP_VERSION is required}"
: "${ROLLBACK_APP_BUILT_AT:?ROLLBACK_APP_BUILT_AT is required}"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_VOLUME_EXPECTED:?PRODUCTION_DB_VOLUME_EXPECTED is required}"
export API_IMAGE="$API_ROLLBACK_IMAGE" WEB_IMAGE="$WEB_ROLLBACK_IMAGE"
export APP_COMMIT="$ROLLBACK_APP_COMMIT" APP_VERSION="$ROLLBACK_APP_VERSION" APP_BUILT_AT="$ROLLBACK_APP_BUILT_AT"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.production.yml)
docker image inspect "$API_IMAGE" >/dev/null || die "imagem rollback API ausente"
docker image inspect "$WEB_IMAGE" >/dev/null || die "imagem rollback WEB ausente"

log "Removendo somente containers API/WEB novos e recriando pelas imagens versionadas"
"${COMPOSE[@]}" stop api web
"${COMPOSE[@]}" rm -f api web
for port in 4000 5173; do
  for _ in {1..30}; do docker ps --format '{{.Ports}}' | grep -q ":$port->" || break; sleep 1; done
  docker ps --format '{{.Ports}}' | grep -q ":$port->" && die "porta $port não foi liberada"
done
"${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate api web

for _ in {1..60}; do curl -fsS http://127.0.0.1:4000/health >/dev/null && break; sleep 2; done
curl -fsS http://127.0.0.1:4000/health >/dev/null || die "API de rollback sem health"
for _ in {1..30}; do curl -fsS http://127.0.0.1:5173/ >/dev/null && break; sleep 2; done
curl -fsS http://127.0.0.1:5173/ >/dev/null || die "WEB de rollback sem resposta"

api_id=$("${COMPOSE[@]}" ps -q api); web_id=$("${COMPOSE[@]}" ps -q web)
[[ "$(docker inspect -f '{{.Image}}' "$api_id")" == "$API_ROLLBACK_IMAGE_ID" ]] || die "API restaurada não usa o image ID anterior"
[[ "$(docker inspect -f '{{.Image}}' "$web_id")" == "$WEB_ROLLBACK_IMAGE_ID" ]] || die "WEB restaurada não usa o image ID anterior"
docker inspect "$api_id" >"$EVIDENCE_DIR/api.rollback.inspect.json"
docker inspect "$web_id" >"$EVIDENCE_DIR/web.rollback.inspect.json"
[[ "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")" == true ]] || die "PostgreSQL esperado deixou de executar"
docker inspect -f '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" |
  awk -v v="$PRODUCTION_DB_VOLUME_EXPECTED" '$1==v && $2=="/var/lib/postgresql/data"{ok=1} END{exit !ok}' || die "volume/mount PostgreSQL divergente"
log "Rollback por imagens concluído; PostgreSQL permaneceu running com o volume esperado"
