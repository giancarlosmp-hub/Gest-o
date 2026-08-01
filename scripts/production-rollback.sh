#!/usr/bin/env bash
set -euo pipefail
EVIDENCE_DIR="${EVIDENCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
ENV_FILE="${PRODUCTION_ENV_FILE:-/root/demetra-env/production.env}"
APP_DIR="${APP_DIR:-/apps/gest-o}"
umask 077
log_file="$EVIDENCE_DIR/rollback-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$log_file") 2>&1
log(){ printf '[production-rollback] %s\n' "$*"; }
die(){ log "ERRO: $*"; exit 1; }
[[ -f "$ENV_FILE" ]] || die "arquivo seguro ausente"
[[ -s "$EVIDENCE_DIR/previous-runtime.tsv" ]] || die "inventário anterior ausente"
[[ -f "$EVIDENCE_DIR/rollback-images.env" ]] || die "inventário de imagens ausente"
[[ -s "$EVIDENCE_DIR/rollback-containers.tsv" ]] || die "inventário de containers ausente"
cd "$APP_DIR"; set -a; source "$ENV_FILE"; source "$EVIDENCE_DIR/rollback-images.env"; set +a
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_VOLUME_EXPECTED:?PRODUCTION_DB_VOLUME_EXPECTED is required}"
api_previous=$(awk -F'\t' '$1=="api"{print $10}' "$EVIDENCE_DIR/previous-runtime.tsv")
export API_IMAGE="${API_ROLLBACK_IMAGE:-rollback-placeholder-api}" WEB_IMAGE="${WEB_ROLLBACK_IMAGE:-rollback-placeholder-web}"
export APP_COMMIT="${ROLLBACK_APP_COMMIT:-${api_previous:-unknown}}" APP_VERSION="${ROLLBACK_APP_VERSION:-unknown}" APP_BUILT_AT="${ROLLBACK_APP_BUILT_AT:-unknown}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.production.yml)

# Valida integralmente a evidência antes de alterar o runtime novo.
for role in api web; do
  line=$(awk -F'\t' -v r="$role" '$1==r{print; n++} END{if(n!=1)exit 1}' "$EVIDENCE_DIR/previous-runtime.tsv") || die "evidência incompleta para $role"
  IFS=$'\t' read -r _ mode name container_id image_id tag port networks restart previous <<<"$line"
  case "$mode" in
    image) [[ -n "$tag" ]] && docker image inspect "$tag" >/dev/null 2>&1 || die "imagem rollback de $role ausente" ;;
    container)
      recorded=$(awk -F'\t' -v r="$role" '$1==r{print $2"|"$3; n++} END{if(n!=1)exit 1}' "$EVIDENCE_DIR/rollback-containers.tsv") || die "registro de container de $role ausente"
      [[ "$recorded" == "$name|$container_id" ]] || die "identidade histórica de $role divergente"
      [[ "$(docker inspect -f '{{.Id}}' "$name" 2>/dev/null)" == "$container_id" ]] || die "container histórico de $role não existe com o ID registrado" ;;
    *) die "rollback_mode inválido para $role" ;;
  esac
done

log "Removendo somente containers API/WEB novos"
# Nunca usa down, toca no serviço db ou remove volumes.
"${COMPOSE[@]}" stop api web
"${COMPOSE[@]}" rm -f api web
for port in 4000 5173; do
  for _ in {1..30}; do docker ps --format '{{.Ports}}' | grep -q ":$port->" || break; sleep 1; done
  docker ps --format '{{.Ports}}' | grep -q ":$port->" && die "porta $port não foi liberada"
done

for role in api web; do
  IFS=$'\t' read -r _ mode name container_id image_id tag port networks restart previous < <(awk -F'\t' -v r="$role" '$1==r' "$EVIDENCE_DIR/previous-runtime.tsv")
  if [[ "$mode" == container ]]; then
    docker start "$container_id" >/dev/null
  else
    "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate "$role"
  fi
done

for _ in {1..60}; do curl -fsS http://127.0.0.1:4000/health >/dev/null && break; sleep 2; done
curl -fsS http://127.0.0.1:4000/health >/dev/null || die "API de rollback sem health"
for _ in {1..30}; do curl -fsS http://127.0.0.1:5173/ >/dev/null && break; sleep 2; done
curl -fsS http://127.0.0.1:5173/ >/dev/null || die "WEB de rollback sem resposta"

for role in api web; do
  IFS=$'\t' read -r _ mode name container_id image_id tag port networks restart previous < <(awk -F'\t' -v r="$role" '$1==r' "$EVIDENCE_DIR/previous-runtime.tsv")
  if [[ "$mode" == container ]]; then
    [[ "$(docker inspect -f '{{.Id}}|{{.State.Running}}' "$name")" == "$container_id|true" ]] || die "$role histórico não voltou com o ID exato"
  else
    id=$("${COMPOSE[@]}" ps -q "$role")
    [[ "$(docker inspect -f '{{.Image}}' "$id")" == "$image_id" ]] || die "$role restaurado não usa o image ID anterior"
  fi
  docker inspect "${id:-$container_id}" >"$EVIDENCE_DIR/$role.rollback.inspect.json"
  unset id
done
[[ "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")" == true ]] || die "PostgreSQL esperado deixou de executar"
docker inspect -f '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" |
  awk -v v="$PRODUCTION_DB_VOLUME_EXPECTED" '$1==v && $2=="/var/lib/postgresql/data"{ok=1} END{exit !ok}' || die "volume/mount PostgreSQL divergente"
log "Rollback híbrido concluído; PostgreSQL permaneceu running com o volume esperado"
