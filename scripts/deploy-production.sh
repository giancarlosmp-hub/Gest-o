#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/apps/gest-o}"
MODE="${MODE:-build}"
printf 'DEPLOY_SCRIPT_ENTERED=PASS\n'
case "$MODE" in build|cutover) ;; *) printf 'DEPLOY_FAILURE_STAGE=deploy_mode\nDEPLOY_FAILURE_COMMAND=validate_deploy_mode\nDEPLOY_FAILURE_EXIT_CODE=1\n' >&2; exit 1 ;; esac
printf 'DEPLOY_MODE=%s\n' "$MODE"
if [[ ! "${EXPECTED_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'DEPLOY_FAILURE_STAGE=expected_sha_format\nDEPLOY_FAILURE_COMMAND=validate_expected_sha_format\nDEPLOY_FAILURE_EXIT_CODE=1\n' >&2
  exit 1
fi
printf 'DEPLOY_EXPECTED_SHA_FORMAT=PASS\n'
[[ -z "${PRODUCTION_ENV_FILE:-}" ]] || { printf '[deploy-production] ERRO: PRODUCTION_ENV_FILE override is prohibited; use the authorized resolver\n' >&2; exit 1; }
printf 'DEPLOY_ENV_RESOLUTION=STARTED\n'
if ENV_FILE="$(MODE="$MODE" bash scripts/resolve-production-env.sh)"; then
  :
else
  resolver_exit=$?
  printf 'DEPLOY_FAILURE_STAGE=environment_resolution\n' >&2
  printf 'DEPLOY_FAILURE_COMMAND=resolve_production_environment\n' >&2
  printf 'DEPLOY_FAILURE_EXIT_CODE=%s\n' "$resolver_exit" >&2
  exit "$resolver_exit"
fi
log(){ printf '[deploy-production] %s\n' "$*"; }
die(){ log "ERRO: $*" >&2; exit 1; }
cd "$APP_DIR"

LEGACY_SOURCE_FILE=""
LEGACY_SOURCE_SHA256=""
EFFECTIVE_ENV_FILE=""
cleanup_legacy_overlay(){
  local status=$?
  if [[ -n "$LEGACY_SOURCE_FILE" ]]; then
    if [[ "$(sha256sum "$LEGACY_SOURCE_FILE" | cut -d' ' -f1)" == "$LEGACY_SOURCE_SHA256" ]]; then
      printf 'ERP_LEGACY_SOURCE_IMMUTABLE=PASS\n'
    else
      printf 'ERP_LEGACY_SOURCE_IMMUTABLE=FAIL\n' >&2
      status=1
    fi
  fi
  [[ -z "$EFFECTIVE_ENV_FILE" ]] || rm -f -- "$EFFECTIVE_ENV_FILE"
  exit "$status"
}

if [[ "$ENV_FILE" == /root/demetra-env/production.env || ( -n "${PRODUCTION_LEGACY_ENV_FILE:-}" && "$ENV_FILE" == "$PRODUCTION_LEGACY_ENV_FILE" ) ]]; then
  [[ "$MODE" == build ]] || die "legacy build overlay is prohibited outside MODE=build"
  LEGACY_SOURCE_FILE=$ENV_FILE
  LEGACY_SOURCE_SHA256=$(sha256sum "$LEGACY_SOURCE_FILE" | cut -d' ' -f1)
  EFFECTIVE_ENV_FILE=$(mktemp "${TMPDIR:-/tmp}/gest-o-legacy-build-env.XXXXXX")
  trap cleanup_legacy_overlay EXIT
  # shellcheck source=scripts/legacy-build-env-overlay.sh
  source scripts/legacy-build-env-overlay.sh
  create_legacy_build_env_overlay "$LEGACY_SOURCE_FILE" "$EFFECTIVE_ENV_FILE" || exit 1
  ENV_FILE=$EFFECTIVE_ENV_FILE
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.production.yml)
set -a; source "$ENV_FILE"; set +a
export APP_COMMIT="${EXPECTED_SHA:-$(git rev-parse HEAD)}"
[[ "$APP_COMMIT" == "$(git rev-parse HEAD)" ]] || die "EXPECTED_SHA difere do HEAD"
export APP_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export APP_VERSION="${APP_VERSION:-$(node -p "require('./package.json').version")}"
export API_IMAGE="gest-o-api:$APP_COMMIT"
export WEB_IMAGE="gest-o-web:$APP_COMMIT"

if [[ -n "$LEGACY_SOURCE_FILE" ]]; then
  ERP_ENV_SCHEDULER_POLICY=disabled_build_only PRODUCTION_ENV_FILE="$ENV_FILE" bash scripts/erp-production-env-preflight.sh
else
  PRODUCTION_ENV_FILE="$ENV_FILE" bash scripts/erp-production-env-preflight.sh
fi
# This is intentionally the final operation after loading the selected env:
# production-preflight owns canonical backup rebinding so legacy hints cannot
# overwrite the authoritative pair between resolution and validation.
printf 'DEPLOY_PREFLIGHT_SCRIPT_SOURCE=CHECKOUT_MAIN\n'
PRODUCTION_PREFLIGHT_MODE="$MODE" bash "$APP_DIR/scripts/production-preflight.sh"
actual_services="$("${COMPOSE[@]}" config --services | sort)"
expected_services="$(printf 'api\nweb\n' | sort)"
[[ "$actual_services" == "$expected_services" ]] || die "topologia contém serviços inesperados"
log "Build começa enquanto os containers atuais permanecem atendendo"
"${COMPOSE[@]}" build api web
docker run --rm --network none "gest-o-api:$APP_COMMIT" node -e "const b=require('./apps/api/dist/build-info.json');if(b.commit!=='$APP_COMMIT'||!b.builtAt)process.exit(1)"
log "Build e build-info validados para $APP_COMMIT; nenhum container foi parado"
[[ "$MODE" == cutover ]] || { log "Fase build/preflight concluída; cutover não executado"; exit 0; }
[[ "${CONFIRM:-}" == PRODUCTION_CUTOVER || "${CONFIRM:-}" == PRODUCTION_CUTOVER_REAUTHORIZED ]] || die "cutover exige CONFIRM=PRODUCTION_CUTOVER ou CONFIRM=PRODUCTION_CUTOVER_REAUTHORIZED"

log "Validando imagens OCI alvo para cutover: $API_IMAGE e $WEB_IMAGE"
for target_img in "$API_IMAGE" "$WEB_IMAGE"; do
  docker image inspect "$target_img" >/dev/null 2>&1 || die "imagem OCI alvo $target_img ausente"
  target_rev=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$target_img" 2>/dev/null) || die "não foi possível ler rótulo de revisão de $target_img"
  [[ "$target_rev" == "$APP_COMMIT" ]] || die "imagem OCI alvo $target_img possui rótulo org.opencontainers.image.revision ($target_rev) divergente de $APP_COMMIT"
done

schema_evidence_root="${SCHEMA_EVIDENCE_DIR:-/var/log/gest-o/schema}"
# shellcheck source=scripts/schema-evidence-validation.sh
source scripts/schema-evidence-validation.sh
# shellcheck source=scripts/lib/production-rollback-image.sh
source scripts/lib/production-rollback-image.sh
# shellcheck source=scripts/lib/production-rebaseline-proof.sh
source scripts/lib/production-rebaseline-proof.sh

schema_evidence="$schema_evidence_root/$APP_COMMIT/applied.tsv"
tenancy_bundle="$schema_evidence_root/$APP_COMMIT/migrations/$TENANCY_EXPAND_ROOTS_ID"
if validate_tenancy_expand_roots_evidence "$tenancy_bundle" "$APP_COMMIT" "$schema_evidence_root"; then
  schema_evidence="$tenancy_bundle/result.tsv"
  log "bundle protegido tenancy expand roots validado para o SHA atual"
elif [[ -s "$schema_evidence" ]] && validate_schema_evidence "$schema_evidence" && [[ "$SCHEMA_EVIDENCE_COMMIT" == "$APP_COMMIT" ]]; then
  log "evidência de schema validada para o SHA atual"
else
  schema_evidence=""
  # A tenancy bundle is immutable evidence of database state, not a build
  # artifact.  The previous implementation only looked for a bundle under the
  # current application SHA, while the legacy applied.tsv path already had an
  # equivalence fallback. Reuse is safe only when the complete bundle validates
  # against its own commit and the shared, narrowly scoped Prisma equivalence
  # predicate accepts the application commit.
  for candidate in "$schema_evidence_root"/*/migrations/"$TENANCY_EXPAND_ROOTS_ID"; do
    if [[ -d "$candidate" && ! -L "$candidate" ]]; then
      candidate_commit=${candidate#"$schema_evidence_root"/}; candidate_commit=${candidate_commit%%/*}
      if validate_tenancy_expand_roots_evidence "$candidate" "$candidate_commit" "$schema_evidence_root" && \
         schema_prisma_trees_equivalent "$SCHEMA_EVIDENCE_COMMIT" "$APP_COMMIT"; then
        schema_evidence="$candidate/result.tsv"
        log "bundle protegido tenancy expand roots de SHA Prisma-equivalente validado"
        break
      fi
    fi
  done
  for candidate in "$schema_evidence_root"/*/applied.tsv; do
    [[ -z "$schema_evidence" ]] || break
    if [[ -f "$candidate" && ! -L "$candidate" ]] && validate_schema_evidence_for_commit "$candidate" "$APP_COMMIT"; then
      schema_evidence=$candidate
      log "evidência aplicada protegida de SHA Prisma-equivalente validada"
      break
    fi
  done
  [[ -n "$schema_evidence" ]] || die "cutover bloqueado: nenhuma evidência equivalente de schema foi validada"
fi

# Always revalidate the live database, including evidence for APP_COMMIT itself.
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

evidence_root="${DEPLOY_EVIDENCE_DIR:-/var/log/gest-o/deploy}"
evidence="$evidence_root/$APP_COMMIT"
if [[ -e "$evidence" ]]; then
  [[ -d "$evidence" ]] || die "caminho de evidência existente não é diretório"
  if [[ -e "$evidence/cutover-started" ]]; then
    if running_commit=$(curl -fsS --max-time 3 http://127.0.0.1:4000/health/version 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0)).commit' 2>/dev/null) && [[ "$running_commit" == "$APP_COMMIT" ]]; then
      log "Cutover já concluído anteriormente para $APP_COMMIT; runtime ativo já serve a versão esperada"
      exit 0
    fi

    if [[ "${CONFIRM:-}" != PRODUCTION_CUTOVER_REAUTHORIZED ]]; then
      die "evidência do SHA indica cutover iniciado; revisão manual obrigatória. Para reautorizar após revalidar o estado do runtime, execute com CONFIRM=PRODUCTION_CUTOVER_REAUTHORIZED"
    fi

    for spec in api:4000 web:5173; do
      role=${spec%%:*}; port=${spec##*:}
      owners=$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null | awk -F'|' -v p=":$port->" '$2~p{print $1}')
      if [[ "$(printf '%s\n' "$owners" | sed '/^$/d' | wc -l)" -ne 1 ]]; then
        die "reautorização bloqueada: porta $port não possui proprietário único ou container foi parado"
      fi
      container_id=$(docker inspect -f '{{.Id}}' "$owners" 2>/dev/null || true)
      if [[ -z "$container_id" || "$(docker inspect -f '{{.State.Running}}' "$container_id" 2>/dev/null)" != true ]]; then
        die "reautorização bloqueada: container anterior de $role não está em execução"
      fi
    done

    reauthorized="$evidence_root/$APP_COMMIT.reauthorized-$(date -u +%Y%m%dT%H%M%SZ)"
    [[ ! -e "$reauthorized" ]] || die "destino da evidência reautorizada já existe"
    mv "$evidence" "$reauthorized"
    log "cutover reautorizado manualmente para $APP_COMMIT; evidência anterior salva em $reauthorized"
  else
    aborted="$evidence_root/$APP_COMMIT.aborted-$(date -u +%Y%m%dT%H%M%SZ)"
    [[ ! -e "$aborted" ]] || die "destino da tentativa abortada já existe"
    mv "$evidence" "$aborted"
    log "evidência parcial anterior preservada em $aborted"
  fi
fi
install -d -m 700 "$evidence"
install -m 700 scripts/production-rollback.sh "$evidence/rollback.sh"
printf 'role\trollback_mode\tcontainer_name\tcontainer_id\truntime_identity\trollback_reference\tport\tnetworks\trestart_policy\tprevious_commit\tresolution_method\tartifact_id\n' >"$evidence/previous-runtime.tsv"
printf 'role\tcontainer_name\tcontainer_id\n' >"$evidence/rollback-containers.tsv"
: >"$evidence/rollback-images.env"
chmod 600 "$evidence/previous-runtime.tsv" "$evidence/rollback-containers.tsv" "$evidence/rollback-images.env"
for spec in api:4000 web:5173; do
  role=${spec%%:*}; port=${spec##*:}
  owners=$(docker ps --format '{{.Names}}|{{.Ports}}' | awk -F'|' -v p=":$port->" '$2~p{print $1}')
  [[ "$(printf '%s\n' "$owners" | sed '/^$/d' | wc -l)" -eq 1 ]] || die "porta $port não possui proprietário único"
  name=$owners
  [[ -n "$name" ]] || die "nenhum container anterior encontrado na porta $port"
  container_id=$(docker inspect -f '{{.Id}}' "$name")
  [[ "$(docker inspect -f '{{.State.Running}}' "$container_id")" == true ]] || die "container anterior de $role não está running"
  docker inspect "$container_id" >"$evidence/$role.previous.inspect.json"
  chmod 600 "$evidence/$role.previous.inspect.json"
  image_id=$(docker inspect -f '{{.Image}}' "$name")
  config_image=$(docker inspect -f '{{.Config.Image}}' "$name")
  networks=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}},{{end}}' "$container_id")
  [[ ",$networks" == *,gest-o_default,* ]] || die "container anterior de $role fora da rede esperada"
  restart_policy=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$container_id")
  case "$restart_policy" in no|on-failure|always|unless-stopped) ;; *) die "restart policy desconhecida para $role";; esac
  if previous_commit=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null); then :; else previous_commit=""; fi
  [[ -n "$previous_commit" && "$previous_commit" != '<no value>' ]] || previous_commit=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" | sed -n 's/^APP_COMMIT=//p' | head -1)
  rollback_mode=image; tag="-"
  if resolve_rollback_image "$role" "$image_id" "$config_image"; then
    release=$(printf '%s' "${previous_commit:-${image_id#sha256:}}" | tr -cd '[:alnum:]._ -' | tr ' ' '-' | cut -c1-40)
    [[ -n "$release" ]] || die "não foi possível identificar release anterior de $role"
    tag="gest-o-${role}-rollback:$release"
    docker tag "$ROLLBACK_ARTIFACT_ID" "$tag"
    pinned_id=$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null) || die "referência fixada de rollback inválida para $role"
    [[ "$pinned_id" == "$ROLLBACK_ARTIFACT_ID" ]] || die "referência fixada de rollback mudou para $role"
    printf '%s_ROLLBACK_IMAGE=%q\n%s_ROLLBACK_IMAGE_ID=%q\n' "${role^^}" "$ROLLBACK_ARTIFACT_ID" "${role^^}" "$ROLLBACK_ARTIFACT_ID" >>"$evidence/rollback-images.env"
    log "rollback_image role=$role method=$ROLLBACK_RESOLUTION_METHOD verified_identity=$ROLLBACK_VERIFIED_IDENTITY artifact_id=$ROLLBACK_ARTIFACT_ID pinned_reference=$ROLLBACK_ARTIFACT_ID"
  elif validate_rebaseline_evidence "$APP_COMMIT"; then
    eval "artifact_id=\$REBASELINE_VERIFIED_${role^^}_ID"
    eval "tar_path=\$REBASELINE_VERIFIED_${role^^}_TAR"
    ROLLBACK_RESOLUTION_METHOD="authorized-rebaseline"
    ROLLBACK_VERIFIED_IDENTITY="$image_id"
    ROLLBACK_ARTIFACT_ID="$artifact_id"

    if ! docker image inspect "$ROLLBACK_ARTIFACT_ID" >/dev/null 2>&1; then
      log "artefato OCI de rebaseline $ROLLBACK_ARTIFACT_ID não presente no Docker Engine para $role; restaurando a partir do backup OCI $tar_path"
      [[ -n "$tar_path" && -f "$tar_path" && ! -L "$tar_path" ]] || die "backup OCI $tar_path para $role ausente ou inválido"
      docker load -i "$tar_path" || die "falha ao restaurar backup OCI $tar_path para $role no Docker Engine"
      docker image inspect "$ROLLBACK_ARTIFACT_ID" >/dev/null 2>&1 || die "artefato OCI $ROLLBACK_ARTIFACT_ID não disponível no Docker Engine mesmo após carregar backup OCI"
    fi

    target_rev=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ROLLBACK_ARTIFACT_ID" 2>/dev/null) || die "não foi possível ler rótulo de revisão do artefato de rebaseline $ROLLBACK_ARTIFACT_ID de $role"
    [[ "$target_rev" == "$APP_COMMIT" ]] || die "artefato OCI de rebaseline $ROLLBACK_ARTIFACT_ID de $role possui rótulo org.opencontainers.image.revision ($target_rev) divergente de $APP_COMMIT"

    tag="gest-o-${role}-rebaseline:$APP_COMMIT"
    docker tag "$ROLLBACK_ARTIFACT_ID" "$tag"
    pinned_id=$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null) || die "referência fixada de rebaseline inválida para $role"
    [[ "$pinned_id" == "$ROLLBACK_ARTIFACT_ID" ]] || die "referência fixada de rebaseline mudou para $role"
    printf '%s_ROLLBACK_IMAGE=%q\n%s_ROLLBACK_IMAGE_ID=%q\n' "${role^^}" "$ROLLBACK_ARTIFACT_ID" "${role^^}" "$ROLLBACK_ARTIFACT_ID" >>"$evidence/rollback-images.env"
    log "rollback_image role=$role method=authorized-rebaseline rebaseline_commit=$APP_COMMIT verified_target_id=$ROLLBACK_ARTIFACT_ID (legacy running image $image_id unverified)"
  else
    log "rollback_image role=$role method=unresolved verified_identity=none block_reason=$ROLLBACK_BLOCK_REASON"
    die "$role sem imagem anterior verificável: $ROLLBACK_BLOCK_REASON; fallback por container proibido"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$role" "$rollback_mode" "$name" "$container_id" "$image_id" "$ROLLBACK_ARTIFACT_ID" "$port" "$networks" "$restart_policy" "${previous_commit:-unknown}" "$ROLLBACK_RESOLUTION_METHOD" "$ROLLBACK_ARTIFACT_ID" >>"$evidence/previous-runtime.tsv"
  if [[ "$role" == api && "$rollback_mode" == image ]]; then
    if previous_version=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image_id" 2>/dev/null); then :; else previous_version=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$ROLLBACK_ARTIFACT_ID" 2>/dev/null || echo ""); fi
    if previous_built_at=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.created"}}' "$image_id" 2>/dev/null); then :; else previous_built_at=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.created"}}' "$ROLLBACK_ARTIFACT_ID" 2>/dev/null || echo ""); fi
    printf 'ROLLBACK_APP_COMMIT=%q\nROLLBACK_APP_VERSION=%q\nROLLBACK_APP_BUILT_AT=%q\n' "${previous_commit:-unknown}" "${previous_version:-unknown}" "${previous_built_at:-unknown}" >>"$evidence/rollback-images.env"
  fi
done
# Último gate antes de qualquer parada: artefato executável/sintático, mecanismos,
# identidade/running/porta/rede dos runtimes e PostgreSQL/volume já validados.
bash -n "$evidence/rollback.sh"
for role in api web; do
  line=$(awk -F'\t' -v r="$role" '$1==r{print; n++} END{if(n!=1)exit 1}' "$evidence/previous-runtime.tsv") || die "evidência incompleta para $role"
  IFS=$'\t' read -r _ mode name container_id image_id tag port networks restart previous <<<"$line"
  case "$mode" in
    image) docker image inspect "$tag" >/dev/null 2>&1 || die "tag de rollback inválida para $role" ;;
    container) [[ "$(docker inspect -f '{{.Id}}|{{.State.Running}}' "$name")" == "$container_id|true" ]] || die "container histórico de $role mudou" ;;
    *) die "mecanismo de rollback inválido para $role" ;;
  esac
  [[ "$(docker ps --format '{{.ID}}|{{.Ports}}' | awk -F'|' -v p=":$port->" '$2~p{print $1}')" == "${container_id:0:12}" ]] || die "proprietário da porta $port mudou"
done
[[ "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")" == true ]] || die "PostgreSQL deixou de executar antes do cutover"
docker inspect -f '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" | awk -v v="$PRODUCTION_DB_VOLUME_EXPECTED" '$1==v && $2=="/var/lib/postgresql/data"{ok=1} END{exit !ok}' || die "volume PostgreSQL divergente antes do cutover"
rollback(){ trap - ERR; log "Falha: executando rollback persistido de API/WEB"; EVIDENCE_DIR="$evidence" APP_DIR="$APP_DIR" PRODUCTION_ENV_FILE="$ENV_FILE" bash "$evidence/rollback.sh"; }
trap rollback ERR
: >"$evidence/cutover-started"; chmod 600 "$evidence/cutover-started"
while IFS=$'\t' read -r role mode name container_id _; do [[ "$role" == role ]] || docker stop "$container_id"; done <"$evidence/previous-runtime.tsv"
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
