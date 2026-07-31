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
export API_IMAGE="gest-o-api:$APP_COMMIT"
export WEB_IMAGE="gest-o-web:$APP_COMMIT"

bash scripts/production-preflight.sh
actual_services="$("${COMPOSE[@]}" config --services | sort)"
expected_services="$(printf 'api\nweb\n' | sort)"
[[ "$actual_services" == "$expected_services" ]] || die "topologia contém serviços inesperados"
log "Build começa enquanto os containers atuais permanecem atendendo"
"${COMPOSE[@]}" build api web
docker run --rm --network none "gest-o-api:$APP_COMMIT" node -e "const b=require('./apps/api/dist/build-info.json');if(b.commit!=='$APP_COMMIT'||!b.builtAt)process.exit(1)"
log "Build e build-info validados para $APP_COMMIT; nenhum container foi parado"
[[ "${MODE:-build}" == cutover ]] || { log "Fase build/preflight concluída; cutover não executado"; exit 0; }
[[ "${CONFIRM:-}" == PRODUCTION_CUTOVER ]] || die "cutover exige CONFIRM=PRODUCTION_CUTOVER"

evidence="${DEPLOY_EVIDENCE_DIR:-/var/log/gest-o/deploy}/$APP_COMMIT"; mkdir -p "$evidence"
install -m 700 scripts/production-rollback.sh "$evidence/rollback.sh"
printf 'role\tcontainer\timage_id\trollback_tag\tport\tnetworks\trestart_policy\tprevious_commit\n' >"$evidence/previous-runtime.tsv"
: >"$evidence/rollback-images.env"
for spec in api:4000 web:5173; do
  role=${spec%%:*}; port=${spec##*:}
  name=$(docker ps --format '{{.Names}}|{{.Ports}}' | awk -F'|' -v p=":$port->" '$2~p{print $1;exit}')
  [[ -n "$name" ]] || die "nenhum container anterior encontrado na porta $port"
  docker inspect "$name" >"$evidence/$role.previous.inspect.json"
  image_id=$(docker inspect -f '{{.Image}}' "$name")
  previous_commit=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)
  [[ -n "$previous_commit" && "$previous_commit" != '<no value>' ]] || previous_commit=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" | sed -n 's/^APP_COMMIT=//p' | head -1)
  release=$(printf '%s' "${previous_commit:-${image_id#sha256:}}" | tr -cd '[:alnum:]._- ' | tr ' ' '-' | cut -c1-40)
  [[ -n "$release" ]] || die "não foi possível identificar release anterior de $role"
  tag="gest-o-${role}-rollback:$release"
  docker tag "$image_id" "$tag"
  networks=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}},{{end}}' "$name")
  restart_policy=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$name")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$role" "$name" "$image_id" "$tag" "$port" "$networks" "$restart_policy" "${previous_commit:-unknown}" >>"$evidence/previous-runtime.tsv"
  printf '%s_ROLLBACK_IMAGE=%q\n%s_ROLLBACK_IMAGE_ID=%q\n' "${role^^}" "$tag" "${role^^}" "$image_id" >>"$evidence/rollback-images.env"
  if [[ "$role" == api ]]; then
    previous_version=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image_id" 2>/dev/null || true)
    previous_built_at=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.created"}}' "$image_id" 2>/dev/null || true)
    printf 'ROLLBACK_APP_COMMIT=%q\nROLLBACK_APP_VERSION=%q\nROLLBACK_APP_BUILT_AT=%q\n' "${previous_commit:-unknown}" "${previous_version:-unknown}" "${previous_built_at:-unknown}" >>"$evidence/rollback-images.env"
  fi
done
rollback(){ trap - ERR; log "Falha: executando rollback persistido de API/WEB"; EVIDENCE_DIR="$evidence" APP_DIR="$APP_DIR" PRODUCTION_ENV_FILE="$ENV_FILE" bash "$evidence/rollback.sh"; }
trap rollback ERR
while IFS=$'\t' read -r role name _; do [[ "$role" == role ]] || docker stop "$name"; done <"$evidence/previous-runtime.tsv"
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
