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
# Inside the stop/start window (CUTOVER_WINDOW=yes) every rejection rolls back:
# `exit` does not fire the ERR trap, so die has to do it itself.
CUTOVER_WINDOW=no
die(){ log "ERRO: $*" >&2; [[ "$CUTOVER_WINDOW" != yes ]] || rollback; exit 1; }
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
# shellcheck source=scripts/lib/production-rollback-image.sh
source scripts/lib/production-rollback-image.sh
# shellcheck source=scripts/lib/production-build-evidence.sh
source scripts/lib/production-build-evidence.sh
# shellcheck source=scripts/lib/production-release-artifact.sh
source scripts/lib/production-release-artifact.sh
BUILD_EVIDENCE_ROOT="${BUILD_EVIDENCE_DIR:-/var/log/gest-o/deploy-builds}"
if [[ "$MODE" == build ]]; then
  APP_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  APP_VERSION="${APP_VERSION:-$(node -p "require('./package.json').version")}"
  API_IMAGE="gest-o-api:$APP_COMMIT"
  WEB_IMAGE="gest-o-web:$APP_COMMIT"
else
  # The cutover never rebuilds: it starts exactly the images phase=build
  # produced and verified for this SHA, identified by image ID.
  if ! build_evidence_load "$BUILD_EVIDENCE_ROOT" "$APP_COMMIT"; then
    printf 'DEPLOY_FAILURE_STAGE=build_evidence\nDEPLOY_FAILURE_COMMAND=load_build_evidence\nDEPLOY_FAILURE_EXIT_CODE=1\n' >&2
    die "evidência de build ausente ou inválida para $APP_COMMIT ($BUILD_EVIDENCE_ERROR); rode phase=build para este SHA"
  fi
  APP_BUILT_AT=$BUILD_EVIDENCE_BUILT_AT
  APP_VERSION=$BUILD_EVIDENCE_APP_VERSION
  API_IMAGE=$BUILD_EVIDENCE_API_IMAGE_ID
  WEB_IMAGE=$BUILD_EVIDENCE_WEB_IMAGE_ID
  printf 'DEPLOY_BUILD_EVIDENCE=LOADED path=%s api_image_id=%s web_image_id=%s built_at=%s\n' "$BUILD_EVIDENCE_FILE" "$API_IMAGE" "$WEB_IMAGE" "$APP_BUILT_AT"
fi
export APP_BUILT_AT APP_VERSION API_IMAGE WEB_IMAGE

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

# Rebuilding a SHA that production already runs would move gest-o-<role>:<sha>
# away from the running image; with the containerd image store that image
# then stops being inspectable (Sept/2026 incident), so it is refused.
refuse_build_if_in_production(){
  local spec role port owners identity revision running_commit cids cid img in_use='' tag_id reason=''
  running_commit=$(curl -fsS --max-time 3 http://127.0.0.1:4000/health/version 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0)).commit' 2>/dev/null) || running_commit=''
  [[ "$running_commit" != "$APP_COMMIT" ]] || reason="/health/version já serve $APP_COMMIT"
  cids=$(docker ps -aq) || die "não foi possível listar containers para validar o build"
  for cid in $cids; do
    # A container removed between `ps` and `inspect` (e.g. a preview) uses nothing.
    if img=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null); then in_use+="$img"$'\n'; fi
  done
  for spec in api:4000 web:5173; do
    role=${spec%%:*}; port=${spec##*:}
    owners=$(docker ps --format '{{.Names}}|{{.Ports}}' | awk -F'|' -v p=":$port->" '$2~p{print $1}')
    revision=''
    if [[ "$(printf '%s\n' "$owners" | sed '/^$/d' | wc -l)" -eq 1 ]] && identity=$(docker inspect -f '{{.Image}}' "$owners" 2>/dev/null); then
      revision=$(build_image_label "$identity" org.opencontainers.image.revision 2>/dev/null) || revision=''
    fi
    [[ "$revision" != "$APP_COMMIT" ]] || reason="container $owners ($role) já executa $APP_COMMIT"
  done
  for role in api web; do
    tag_id=$(docker image inspect -f '{{.Id}}' "gest-o-$role:$APP_COMMIT" 2>/dev/null) || tag_id=''
    if [[ -n "$tag_id" ]] && grep -Fxq "$tag_id" <<<"$in_use"; then reason="gest-o-$role:$APP_COMMIT aponta para $tag_id, em uso por um container"; fi
    if [[ -n "$tag_id" ]] && release_find_for_identity "$role" "$tag_id"; then reason="gest-o-$role:$APP_COMMIT aponta para $tag_id, que já possui artefato de release"; fi
  done
  if [[ -n "$reason" ]]; then
    printf 'DEPLOY_FAILURE_STAGE=build_sha_in_production\nDEPLOY_FAILURE_COMMAND=refuse_build_if_in_production\nDEPLOY_FAILURE_EXIT_CODE=1\n' >&2
    die "build recusado: $reason; refazer o build moveria a tag de uma imagem de produção"
  fi
  printf 'DEPLOY_BUILD_REFUSAL_CHECK=PASS\n'
}

# Records which images this build produced, after checking identity, labels and
# build-info, and pins them under immutable release tags until the cutover.
record_build_evidence(){
  local role id ids=()
  for role in api web; do
    id=$(docker image inspect -f '{{.Id}}' "gest-o-$role:$APP_COMMIT") || die "imagem gest-o-$role:$APP_COMMIT ausente após o build"
    build_image_validate "$role" "$id" "$APP_COMMIT" "$APP_BUILT_AT" || die "imagem $role recém-construída inválida: $BUILD_EVIDENCE_ERROR"
    release_pin "$role" "$id" || die "não foi possível fixar a tag de release de $role: $RELEASE_ERROR"
    ids+=("$id")
  done
  build_evidence_write "$BUILD_EVIDENCE_ROOT" "$APP_COMMIT" "$APP_BUILT_AT" "$APP_VERSION" "${ids[0]}" "${ids[1]}" "$APP_COMMIT" "$APP_COMMIT" ||
    die "evidência de build não gravada: $BUILD_EVIDENCE_ERROR"
  printf 'DEPLOY_BUILD_EVIDENCE=PASS path=%s api_image_id=%s web_image_id=%s built_at=%s\n' "$BUILD_EVIDENCE_FILE" "${ids[0]}" "${ids[1]}" "$APP_BUILT_AT"
}

if [[ "$MODE" == build ]]; then
  refuse_build_if_in_production
  log "Build começa enquanto os containers atuais permanecem atendendo"
  "${COMPOSE[@]}" build api web
  record_build_evidence
  log "Build, rótulos e build-info validados para $APP_COMMIT; nenhum container foi parado"
  # Pins and saves the runtime that is serving now, while nothing is stopped.
  # Both calls only report (RELEASE_ARTIFACT_BOOTSTRAP=..., RELEASE_RETENTION...)
  # and return 0 in build mode; the cutover re-checks before stopping anything.
  # They run as `if` conditions on purpose: there `set -e` does not apply inside
  # the functions, so an internal command failure is reported, never fatal.
  if ensure_runtime_release_artifact build; then :; fi
  if release_retention_report; then :; fi
  log "Fase build/preflight concluída; cutover não executado"
  exit 0
fi
[[ "${CONFIRM:-}" == PRODUCTION_CUTOVER || "${CONFIRM:-}" == PRODUCTION_CUTOVER_REAUTHORIZED ]] || die "cutover exige CONFIRM=PRODUCTION_CUTOVER ou CONFIRM=PRODUCTION_CUTOVER_REAUTHORIZED"

log "Validando imagens OCI alvo para cutover: $API_IMAGE e $WEB_IMAGE"
for target_spec in "api:$API_IMAGE" "web:$WEB_IMAGE"; do
  target_role=${target_spec%%:*}; target_img=${target_spec#*:}
  docker image inspect "$target_img" >/dev/null 2>&1 || die "imagem OCI alvo $target_img ausente; rode phase=build para este SHA"
  build_image_validate "$target_role" "$target_img" "$APP_COMMIT" "$APP_BUILT_AT" ||
    die "imagem OCI alvo $target_img ($target_role) diverge da evidência de build: $BUILD_EVIDENCE_ERROR"
  release_pin "$target_role" "$target_img" || die "tag de release da imagem alvo de $target_role inválida: $RELEASE_ERROR"
done

schema_evidence_root="${SCHEMA_EVIDENCE_DIR:-/var/log/gest-o/schema}"
# shellcheck source=scripts/schema-evidence-validation.sh
source scripts/schema-evidence-validation.sh
# shellcheck source=scripts/lib/production-rebaseline-proof.sh
source scripts/lib/production-rebaseline-proof.sh
rollback_artifact_label(){
  local value
  value=$(docker image inspect -f "{{index .Config.Labels \"$1\"}}" "$ROLLBACK_ARTIFACT_ID" 2>/dev/null) || value=""
  [[ "$value" != '<no value>' ]] || value=""
  printf '%s' "$value"
}

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
  "$API_IMAGE" ./node_modules/.bin/prisma migrate diff \
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
# Pins the runtime about to be stopped and makes sure it has a verified release
# artifact (idempotent: normally phase=build already created it).  It does not
# decide by itself: the rollback inventory below still requires a verifiable
# image (identity, release artifact or authorized rebaseline) before any stop.
if ! ensure_runtime_release_artifact cutover; then
  log "AVISO: runtime atual sem artefato de release e sem imagem inspecionável; o inventário de rollback decide"
fi
install -d -m 700 "$evidence"
install -m 700 scripts/production-rollback.sh "$evidence/rollback.sh"
install -m 600 scripts/lib/production-release-artifact.sh "$evidence/production-release-artifact.sh"
printf 'role\trollback_mode\tcontainer_name\tcontainer_id\truntime_identity\trollback_reference\tport\tnetworks\trestart_policy\tprevious_commit\tresolution_method\tartifact_id\n' >"$evidence/previous-runtime.tsv"
printf 'role\tcontainer_name\tcontainer_id\n' >"$evidence/rollback-containers.tsv"
printf 'role\timage_id\trelease_tag\ttar\ttar_sha256\n' >"$evidence/rollback-artifacts.tsv"
: >"$evidence/rollback-images.env"
chmod 600 "$evidence/previous-runtime.tsv" "$evidence/rollback-containers.tsv" "$evidence/rollback-artifacts.tsv" "$evidence/rollback-images.env"
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
  rollback_mode=image; tag="-"; rollback_resolved=no
  if resolve_rollback_image "$role" "$image_id" "$config_image"; then
    rollback_resolved=yes
  elif release_restore "$role" "$image_id"; then
    # The engine lost the running image but a verified release artifact holds
    # it: the tar digest was checked before loading, and the same cryptographic
    # predicate must accept the loaded image.  The artifact is never the proof.
    resolve_rollback_image "$role" "$image_id" "$config_image" ||
      die "artefato de release de $role carregado, mas a identidade $image_id não foi comprovada: $ROLLBACK_BLOCK_REASON"
    ROLLBACK_RESOLUTION_METHOD="release-artifact-load"
    rollback_resolved=yes
  fi
  if [[ "$rollback_resolved" == yes ]]; then
    # Commit, version and build time describe the image that rollback actually
    # starts, so they are read from the resolved artifact, never the runtime.
    previous_commit=$(rollback_artifact_label org.opencontainers.image.revision)
    [[ -n "$previous_commit" ]] || die "artefato de rollback $ROLLBACK_ARTIFACT_ID de $role sem rótulo org.opencontainers.image.revision"
    release=$(printf '%s' "$previous_commit" | tr -cd '[:alnum:]._ -' | tr ' ' '-' | cut -c1-40)
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
    previous_commit=$target_rev

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
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$role" "$rollback_mode" "$name" "$container_id" "$image_id" "$ROLLBACK_ARTIFACT_ID" "$port" "$networks" "$restart_policy" "$previous_commit" "$ROLLBACK_RESOLUTION_METHOD" "$ROLLBACK_ARTIFACT_ID" >>"$evidence/previous-runtime.tsv"
  # Lets rollback.sh reload the image if the engine loses it after this point.
  if release_find_for_identity "$role" "$ROLLBACK_ARTIFACT_ID"; then
    printf '%s\t%s\t%s\t%s\t%s\n' "$role" "$RELEASE_FOUND_IMAGE_ID" "$RELEASE_FOUND_TAG" "$RELEASE_FOUND_TAR" "$RELEASE_FOUND_TAR_SHA256" >>"$evidence/rollback-artifacts.tsv"
  fi
  if [[ "$role" == api && "$rollback_mode" == image ]]; then
    previous_version=$(rollback_artifact_label org.opencontainers.image.version)
    previous_built_at=$(rollback_artifact_label org.opencontainers.image.created)
    printf 'ROLLBACK_APP_COMMIT=%q\nROLLBACK_APP_VERSION=%q\nROLLBACK_APP_BUILT_AT=%q\n' "$previous_commit" "${previous_version:-unknown}" "${previous_built_at:-unknown}" >>"$evidence/rollback-images.env"
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
rollback(){ trap - ERR; CUTOVER_WINDOW=no; log "Falha: executando rollback persistido de API/WEB"; EVIDENCE_DIR="$evidence" APP_DIR="$APP_DIR" PRODUCTION_ENV_FILE="$ENV_FILE" bash "$evidence/rollback.sh"; }
trap rollback ERR
CUTOVER_WINDOW=yes
: >"$evidence/cutover-started"; chmod 600 "$evidence/cutover-started"
while IFS=$'\t' read -r role mode name container_id _; do [[ "$role" == role ]] || docker stop "$container_id"; done <"$evidence/previous-runtime.tsv"
"${COMPOSE[@]}" up -d --no-build --no-deps --pull never api web
for service in api web; do
  id=$("${COMPOSE[@]}" ps -q "$service"); for _ in {1..36}; do [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" == healthy ]] && break; sleep 5; done
  [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" == healthy ]] || die "$service não ficou healthy"
done
for target_spec in "api:$API_IMAGE" "web:$WEB_IMAGE"; do
  service=${target_spec%%:*}; id=$("${COMPOSE[@]}" ps -q "$service")
  [[ "$(docker inspect -f '{{.Image}}' "$id")" == "${target_spec#*:}" ]] || die "$service não executa a imagem da evidência de build (${target_spec#*:})"
done
version_json=$(curl -fsS http://127.0.0.1:4000/health/version)
actual=$(node -pe 'JSON.parse(require("fs").readFileSync(0)).commit' <<<"$version_json")
[[ "$actual" == "$APP_COMMIT" ]] || die "commit local divergente"
actual_built_at=$(node -pe 'JSON.parse(require("fs").readFileSync(0)).builtAt' <<<"$version_json")
[[ "$actual_built_at" == "$APP_BUILT_AT" ]] || die "builtAt local ($actual_built_at) divergente da evidência de build ($APP_BUILT_AT)"
curl -fsS http://127.0.0.1:5173/ >"$evidence/index.local.html"
log "Cutover concluído localmente; validações públicas/read-only manuais continuam obrigatórias"
trap - ERR
CUTOVER_WINDOW=no

# The new runtime is healthy from here on: a release artifact problem is
# reported (exit 3) but never rolls it back.
release_failed=no
for target_spec in "api:$API_IMAGE" "web:$WEB_IMAGE"; do
  role=${target_spec%%:*}; id=${target_spec#*:}
  if release_find_for_identity "$role" "$id" || release_save "$role" "$id" "$APP_COMMIT" "$APP_BUILT_AT" "$id"; then
    printf 'DEPLOY_RELEASE_ARTIFACT=PASS role=%s id=%s\n' "$role" "$id"
  else
    printf 'DEPLOY_RELEASE_ARTIFACT=FAIL role=%s id=%s reason=%s\n' "$role" "$id" "$RELEASE_ERROR" >&2
    release_failed=yes
  fi
done
# Report only (always returns 0); run as a condition so `set -e` cannot make a
# report problem fatal after a healthy cutover.
if release_retention_report; then :; fi
if [[ "$release_failed" == yes ]]; then
  log "Runtime $APP_COMMIT saudável, mas o artefato de release não foi concluído. NÃO execute rollback: o próximo phase=build recria o artefato."
  exit 3
fi
