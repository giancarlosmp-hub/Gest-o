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
schema_evidence_root="${SCHEMA_EVIDENCE_DIR:-/var/log/gest-o/schema}"
schema_migration="apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql"
validate_schema_evidence(){
  local applied=$1 evidence_dir=${1%/*} applied_at evidence_commit evidence_migration extra recorded_hash current_hash
  [[ "$(wc -l <"$applied")" -eq 1 ]] || return 1
  IFS=$'\t' read -r applied_at evidence_commit evidence_migration extra <"$applied" || return 1
  [[ -n "$applied_at" && "$evidence_commit" =~ ^[0-9a-f]{40}$ && -z "${extra:-}" ]] || return 1
  [[ "$evidence_migration" == "$schema_migration" ]] || return 1
  git cat-file -e "$evidence_commit^{commit}" 2>/dev/null || return 1
  [[ -s "$evidence_dir/migration.sha256" ]] || return 1
  [[ -f "$evidence_dir/post-apply-diff.sql" && ! -s "$evidence_dir/post-apply-diff.sql" ]] || return 1
  read -r recorded_hash _ <"$evidence_dir/migration.sha256" || return 1
  current_hash=$(sha256sum "$schema_migration"); current_hash=${current_hash%% *}
  [[ "$recorded_hash" == "$current_hash" ]] || return 1
  [[ "$(git show "$evidence_commit:$schema_migration" | sha256sum | cut -d' ' -f1)" == "$current_hash" ]] || return 1
  SCHEMA_EVIDENCE_COMMIT=$evidence_commit
}

schema_evidence="$schema_evidence_root/$APP_COMMIT/applied.tsv"
if [[ -s "$schema_evidence" ]] && validate_schema_evidence "$schema_evidence" && [[ "$SCHEMA_EVIDENCE_COMMIT" == "$APP_COMMIT" ]]; then
  log "evidência de schema validada para o SHA atual"
else
  schema_evidence=""
  while IFS= read -r candidate; do
    validate_schema_evidence "$candidate" || continue
    git diff --quiet "$SCHEMA_EVIDENCE_COMMIT" "$APP_COMMIT" -- apps/api/prisma || continue
    changed_paths=$(git diff --name-only "$SCHEMA_EVIDENCE_COMMIT" "$APP_COMMIT")
    [[ -n "$changed_paths" ]] || continue
    if printf '%s\n' "$changed_paths" | grep -Evq '^(scripts/(deploy-production\.sh|smoke/production-deploy-safety\.mjs)|docs/(DEPLOY_GUIDE|OPERACAO|STATUS_ATUAL)\.md)$'; then
      continue
    fi
    schema_evidence=$candidate
    break
  done < <(find "$schema_evidence_root" -mindepth 2 -maxdepth 2 -type f -name applied.tsv -print | sort)
  [[ -n "$schema_evidence" ]] || die "cutover bloqueado: nenhuma evidência equivalente de schema foi validada"

  schema_validation_tmp=$(mktemp -d)
  trap 'rm -rf "$schema_validation_tmp"' EXIT
  docker run --rm --pull=never --network gest-o_default -e DATABASE_URL \
    "gest-o-api:$APP_COMMIT" ./node_modules/.bin/prisma migrate diff \
    --from-schema-datasource apps/api/prisma/schema.prisma \
    --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$schema_validation_tmp/raw.sql"
  node scripts/schema-diff-filter.mjs "$schema_validation_tmp/raw.sql" "$schema_validation_tmp/managed.sql" post
  [[ ! -s "$schema_validation_tmp/managed.sql" ]] || die "cutover bloqueado: diff Prisma atual não está vazio"
  log "evidência de schema de $SCHEMA_EVIDENCE_COMMIT revalidada para SHA operacional $APP_COMMIT"
  rm -rf "$schema_validation_tmp"; trap - EXIT
fi

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
  release=$(printf '%s' "${previous_commit:-${image_id#sha256:}}" | tr -cd '[:alnum:]._ -' | tr ' ' '-' | cut -c1-40)
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
