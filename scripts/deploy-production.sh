#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/apps/gest-o}"
ENV_FILE="${PRODUCTION_ENV_FILE:-/root/demetra-env/production.env}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.production.yml)
log(){ printf '[deploy-production] %s\n' "$*"; }
die(){ log "ERRO: $*" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || die "arquivo seguro de ambiente ausente: $ENV_FILE"
cd "$APP_DIR"; set -a; source "$ENV_FILE"; set +a
export APP_COMMIT="${EXPECTED_SHA:-$(git rev-parse HEAD)}"
[[ "$APP_COMMIT" == "$(git rev-parse HEAD)" ]] || die "EXPECTED_SHA difere do HEAD"
export APP_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export APP_VERSION="${APP_VERSION:-$(node -p "require('./package.json').version")}"

bash scripts/production-preflight.sh
"${COMPOSE[@]}" config --services | diff -u <(printf 'api\nweb\n') - >/dev/null || die "topologia contém serviços inesperados"
log "Build começa enquanto os containers atuais permanecem atendendo"
"${COMPOSE[@]}" build api web
docker run --rm --network none "gest-o-api:$APP_COMMIT" node -e "const b=require('./apps/api/dist/build-info.json');if(b.commit!=='$APP_COMMIT'||!b.builtAt)process.exit(1)"
log "Build e build-info validados para $APP_COMMIT; nenhum container foi parado"
[[ "${MODE:-build}" == cutover ]] || { log "Fase build/preflight concluída; cutover não executado"; exit 0; }
[[ "${CONFIRM:-}" == PRODUCTION_CUTOVER ]] || die "cutover exige CONFIRM=PRODUCTION_CUTOVER"

evidence="${DEPLOY_EVIDENCE_DIR:-/var/log/gest-o/deploy}/$APP_COMMIT"; mkdir -p "$evidence"
: >"$evidence/rollback.sh"; chmod 700 "$evidence/rollback.sh"
old=()
for port in 4000 5173; do
  name=$(docker ps --format '{{.Names}}|{{.Ports}}' | awk -F'|' -v p=":$port->" '$2~p{print $1;exit}')
  [[ -n "$name" ]] || continue; old+=("$name")
  docker inspect "$name" >"$evidence/$name.inspect.json"
  image=$(docker inspect -f '{{.Image}}' "$name"); tag="gest-o-rollback-${port}:$APP_COMMIT"; docker tag "$image" "$tag"
  printf 'docker start %q\n' "$name" >>"$evidence/rollback.sh"
done
printf '%s\n' "${old[@]}" >"$evidence/old-containers.txt"
rollback(){ log "Falha: restaurando somente API/WEB anteriores"; "${COMPOSE[@]}" stop api web >/dev/null 2>&1 || true; [[ ${#old[@]} -eq 0 ]] || docker start "${old[@]}"; }
trap rollback ERR
[[ ${#old[@]} -eq 0 ]] || docker stop "${old[@]}"
"${COMPOSE[@]}" up -d --no-build --no-deps api web
for service in api web; do
  id=$("${COMPOSE[@]}" ps -q "$service"); for _ in {1..36}; do [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" == healthy ]] && break; sleep 5; done
  [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" == healthy ]] || die "$service não ficou healthy"
done
actual=$(curl -fsS http://127.0.0.1:4000/health/version | node -pe 'JSON.parse(require("fs").readFileSync(0)).commit')
[[ "$actual" == "$APP_COMMIT" ]] || die "commit local divergente"
curl -fsS http://127.0.0.1:5173/ >"$evidence/index.local.html"
log "Cutover concluído localmente; validações públicas/read-only manuais continuam obrigatórias"
trap - ERR
