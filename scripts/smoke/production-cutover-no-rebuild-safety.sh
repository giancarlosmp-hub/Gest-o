#!/usr/bin/env bash
# phase=build records and pins what it built; phase=cutover starts exactly those
# image IDs (no rebuild), proves them after start, rolls back on any rejection
# and saves release artifacts without ever rolling back a healthy runtime.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP:?}"' EXIT
# shellcheck source=scripts/smoke/lib/production-deploy-harness.sh
source "$ROOT/scripts/smoke/lib/production-deploy-harness.sh"
harness_init
# shellcheck source=scripts/lib/production-rollback-image.sh
source "$ROOT/scripts/lib/production-rollback-image.sh"
# shellcheck source=scripts/lib/production-release-artifact.sh
source "$ROOT/scripts/lib/production-release-artifact.sh"
OLD_SHA=$(printf '6%.0s' {1..40})
fail(){ printf 'FALHA: %s\n' "$*" >&2; exit 1; }
evidence_field(){ awk -F'\t' -v k="$1" '$1==k{print $2}' "$BUILD_EVIDENCE_DIR/$SHA/build.tsv"; }
fresh_build(){ runtime_reset "$OLD_SHA"; expect_deploy_ok build build; : >"$COMMAND_LOG"; NEW_API=$(evidence_field api_image_id); NEW_WEB=$(evidence_field web_image_id); }
rolled_back(){
  grep -q 'Falha: executando rollback persistido de API/WEB' "$TMP/$1.out" || fail "rollback não executado em $1"
  [[ "$(container_image gest-o-production-api-1)" == "$OLD_API" && "$(container_image gest-o-production-web-1)" == "$OLD_WEB" ]] || fail "runtime não voltou ao anterior em $1"
}

# A. Build: evidence, release pins, runtime artifact bootstrap and retention report; runtime untouched.
runtime_reset "$OLD_SHA"
expect_deploy_ok build build
out="$TMP/build.out"
grep -qx 'DEPLOY_BUILD_REFUSAL_CHECK=PASS' "$out"
[[ "$(grep -c '^docker compose .* build api web$' "$COMMAND_LOG")" -eq 1 ]]
NEW_API=$(evidence_field api_image_id); NEW_WEB=$(evidence_field web_image_id); BUILT_AT=$(evidence_field built_at)
grep -q "^DEPLOY_BUILD_EVIDENCE=PASS path=$BUILD_EVIDENCE_DIR/$SHA/build.tsv api_image_id=$NEW_API web_image_id=$NEW_WEB built_at=$BUILT_AT$" "$out"
[[ "$(docker image inspect -f '{{.Id}}' "gest-o-api:$SHA")" == "$NEW_API" ]]
[[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.created"}}' "$NEW_API")" == "$BUILT_AT" ]]
grep -qx "RELEASE_PIN role=api id=$NEW_API tag=gest-o-api-release:sha256-${NEW_API#sha256:} state=created" "$out"
grep -qx "RELEASE_PIN role=web id=$NEW_WEB tag=gest-o-web-release:sha256-${NEW_WEB#sha256:} state=created" "$out"
grep -qx "RELEASE_ARTIFACT_BOOTSTRAP=PASS role=api id=$OLD_API commit=$OLD_SHA" "$out"
grep -qx "RELEASE_ARTIFACT_BOOTSTRAP=PASS role=web id=$OLD_WEB commit=$OLD_SHA" "$out"
[[ -f "$RELEASE_ARTIFACT_ROOT/$OLD_SHA/api.${OLD_API#sha256:}.tar.gz" && -f "$RELEASE_ARTIFACT_ROOT/$OLD_SHA/web.${OLD_WEB#sha256:}.release.tsv" ]]
grep -q '^RELEASE_RETENTION_MODE=report' "$out"; grep -q '^RELEASE_RETENTION=REPORTED' "$out"
# The images this build produced (no artifact yet) are kept for the cutover.
grep -q "^RELEASE_RETENTION_REPORT kind=image_tag path=gest-o-api-release:sha256-${NEW_API#sha256:} .* decision=keep reason=build_evidence$" "$out" || fail 'tag da imagem api recém-construída marcada para remoção'
grep -q "^RELEASE_RETENTION_REPORT kind=image_tag path=gest-o-web-release:sha256-${NEW_WEB#sha256:} .* decision=keep reason=build_evidence$" "$out" || fail 'tag da imagem web recém-construída marcada para remoção'
no_runtime_change
[[ "$(container_image gest-o-production-api-1)" == "$OLD_API" ]]

# A2. Release tags created on the VPS before the merge are accepted as they are.
runtime_reset "$OLD_SHA"
docker tag "$OLD_API" "gest-o-api-release:sha256-${OLD_API#sha256:}"
docker tag "$OLD_WEB" "gest-o-web-release:sha256-${OLD_WEB#sha256:}"
expect_deploy_ok build build_prepinned
grep -qx "RELEASE_PIN role=api id=$OLD_API tag=gest-o-api-release:sha256-${OLD_API#sha256:} state=existing" "$TMP/build_prepinned.out"
grep -qx "RELEASE_ARTIFACT_BOOTSTRAP=PASS role=api id=$OLD_API commit=$OLD_SHA" "$TMP/build_prepinned.out"

# A3. A second build of the same SHA before the cutover is allowed and replaces the evidence.
first_api=$(evidence_field api_image_id)
expect_deploy_ok build build_again
[[ "$(evidence_field api_image_id)" != "$first_api" ]] || fail 'segundo build não atualizou a evidência'
[[ "$(docker image inspect -f '{{.Id}}' "gest-o-api-release:sha256-${first_api#sha256:}")" == "$first_api" ]] || fail 'tag de release do primeiro build sumiu'
grep -qx "RELEASE_ARTIFACT_BOOTSTRAP=EXISTS role=api id=$OLD_API commit=$OLD_SHA" "$TMP/build_again.out"

# B. Build refused: production already runs this SHA (would move the running image's tag).
runtime_reset "$SHA"
expect_deploy_fail build refuse_running
grep -qx 'DEPLOY_FAILURE_STAGE=build_sha_in_production' "$TMP/refuse_running.err"
grep -q 'build recusado: ' "$TMP/refuse_running.err"
if grep -q 'compose .* build' "$COMMAND_LOG"; then fail 'build executado para SHA em produção'; fi
# C. Build refused: gest-o-api:<sha> names an image a container uses.
runtime_reset "$OLD_SHA"
docker tag "$OLD_API" "gest-o-api:$SHA"; : >"$COMMAND_LOG"
expect_deploy_fail build refuse_in_use
grep -q "gest-o-api:$SHA aponta para $OLD_API, em uso por um container" "$TMP/refuse_in_use.err"
if grep -q 'compose .* build' "$COMMAND_LOG"; then fail 'build executado com tag em uso'; fi
# D. Build refused: gest-o-api:<sha> names an image that already has a release artifact.
runtime_reset "$OLD_SHA"
RELEASED=$("${ENGINE[@]}" image "gest-o-api:$SHA" "$SHA" 1.0.0 2026-10-01T00:00:00Z api)
release_save api "$RELEASED" "$SHA" 2026-10-01T00:00:00Z "$RELEASED" >/dev/null
: >"$COMMAND_LOG"
expect_deploy_fail build refuse_released
grep -q "gest-o-api:$SHA aponta para $RELEASED, que já possui artefato de release" "$TMP/refuse_released.err"

# E. Cutover: no rebuild, starts the recorded IDs with --pull never, proves them, saves artifacts.
fresh_build
expect_deploy_ok cutover cutover
out="$TMP/cutover.out"; ev="$DEPLOY_EVIDENCE_DIR/$SHA"
if grep -Eq '^docker compose .* build|^docker build' "$COMMAND_LOG"; then fail 'cutover fez rebuild'; fi
grep -q "^DEPLOY_BUILD_EVIDENCE=LOADED path=$BUILD_EVIDENCE_DIR/$SHA/build.tsv api_image_id=$NEW_API web_image_id=$NEW_WEB" "$out"
grep -q '^docker compose .* up -d --no-build --no-deps --pull never api web$' "$COMMAND_LOG"
[[ "$(container_image gest-o-production-api-1)" == "$NEW_API" && "$(container_image gest-o-production-web-1)" == "$NEW_WEB" ]]
[[ "$(awk -F'\t' '$1=="gest-o-production-api-1"{print $4}' "$FAKE_DOCKER_STATE/containers")" == "$NEW_API" ]] || fail 'compose não recebeu API_IMAGE=sha256:...'
[[ "$(awk -F'\t' '$1=="gest-o-production-api-1"{print $8}' "$FAKE_DOCKER_STATE/containers")" == "$(evidence_field built_at)" ]] || fail 'APP_BUILT_AT do runtime difere da evidência'
grep -q "method=runtime-identity verified_identity=$OLD_API artifact_id=$OLD_API" "$out"
grep -qx "RELEASE_ARTIFACT_BOOTSTRAP=EXISTS role=api id=$OLD_API commit=$OLD_SHA" "$out"
grep -qx "DEPLOY_RELEASE_ARTIFACT=PASS role=api id=$NEW_API" "$out"
grep -qx "DEPLOY_RELEASE_ARTIFACT=PASS role=web id=$NEW_WEB" "$out"
[[ -f "$RELEASE_ARTIFACT_ROOT/$SHA/api.${NEW_API#sha256:}.tar.gz" && -f "$RELEASE_ARTIFACT_ROOT/$SHA/web.${NEW_WEB#sha256:}.release.tsv" ]]
[[ "$(awk -F'\t' 'NR>1{print $1"|"$2}' "$ev/rollback-artifacts.tsv")" == "api|$OLD_API"$'\n'"web|$OLD_WEB" ]] || fail 'rollback-artifacts.tsv incompleto'
[[ "$(stat -c '%a' "$ev/production-release-artifact.sh")" == 600 && "$(stat -c '%a' "$ev/rollback-artifacts.tsv")" == 600 ]]
[[ "$(head -1 "$ev/previous-runtime.tsv" | awk -F'\t' '{print NF}')" -eq 12 ]] || fail 'previous-runtime.tsv mudou de colunas'
grep -q "^RELEASE_RETENTION_REPORT kind=release path=$RELEASE_ARTIFACT_ROOT/$OLD_SHA/api.${OLD_API#sha256:}.tar.gz .* decision=keep reason=recent_[12],current_rollback$" "$out"
if grep -Eq '^docker (rmi|rm|image rm|image prune|system prune)' "$COMMAND_LOG"; then fail 'cutover removeu imagens'; fi

# F. Cutover without build evidence fails before anything else.
runtime_reset "$OLD_SHA"
expect_deploy_fail cutover no_evidence
grep -qx 'DEPLOY_FAILURE_STAGE=build_evidence' "$TMP/no_evidence.err"
grep -q 'evidência de build ausente ou inválida .* (missing); rode phase=build para este SHA' "$TMP/no_evidence.err"
no_runtime_change
# G. Recorded image no longer in the engine.
fresh_build
"${ENGINE[@]}" forget "$NEW_WEB"
expect_deploy_fail cutover target_missing
grep -q "imagem OCI alvo $NEW_WEB ausente; rode phase=build para este SHA" "$TMP/target_missing.err"
no_runtime_change
# H. Evidence edited after the build (built_at no longer matches the image).
fresh_build
awk -F'\t' 'BEGIN{OFS="\t"} $1=="built_at"{$2="2026-01-01T00:00:00Z"} {print}' "$BUILD_EVIDENCE_DIR/$SHA/build.tsv" >"$TMP/edit"
cat "$TMP/edit" >"$BUILD_EVIDENCE_DIR/$SHA/build.tsv"
expect_deploy_fail cutover evidence_edited
grep -q "diverge da evidência de build: api_created_mismatch" "$TMP/evidence_edited.err"
no_runtime_change

# I. A started container running another image is rejected and rolled back (die inside the window).
fresh_build
"${ENGINE[@]}" fault up-other-image-api
expect_deploy_fail cutover wrong_image
grep -q "api não executa a imagem da evidência de build ($NEW_API)" "$TMP/wrong_image.err"
rolled_back wrong_image
# I2. Unhealthy service is rolled back too (previously `die` skipped the ERR trap).
fresh_build
"${ENGINE[@]}" fault up-unhealthy-web
expect_deploy_fail cutover unhealthy
grep -q 'web não ficou healthy' "$TMP/unhealthy.err"
rolled_back unhealthy

# J. Release artifact failure after a healthy cutover: exit 3, no rollback.
fresh_build
"${ENGINE[@]}" fault save-fail
expect_deploy_fail cutover artifact_fail
grep -qx "DEPLOY_RELEASE_ARTIFACT=FAIL role=api id=$NEW_API reason=save_failed" "$TMP/artifact_fail.err"
grep -qx 'DEPLOY_FAILURE_EXIT_CODE=3' "$TMP/artifact_fail.err"
grep -q 'NÃO execute rollback' "$TMP/artifact_fail.out"
if grep -q 'Falha: executando rollback' "$TMP/artifact_fail.out"; then fail 'runtime saudável foi revertido'; fi
[[ "$(container_image gest-o-production-api-1)" == "$NEW_API" ]]
"${ENGINE[@]}" clear save-fail

# K. Engine lost the running image after phase=build: restored from the release artifact.
fresh_build
"${ENGINE[@]}" forget "$OLD_API"
expect_deploy_ok cutover artifact_load
grep -q "^RELEASE_RESTORE id=$OLD_API tar=$RELEASE_ARTIFACT_ROOT/$OLD_SHA/api.${OLD_API#sha256:}.tar.gz state=loaded$" "$TMP/artifact_load.out"
grep -q "rollback_image role=api method=release-artifact-load verified_identity=$OLD_API artifact_id=$OLD_API" "$TMP/artifact_load.out"
[[ "$(awk -F'\t' '$1=="api"{print $11}' "$DEPLOY_EVIDENCE_DIR/$SHA/previous-runtime.tsv")" == release-artifact-load ]]
# L. Tampered artifact is never loaded; without other proof the cutover fails closed.
fresh_build
"${ENGINE[@]}" forget "$OLD_API"
printf 'x' >>"$RELEASE_ARTIFACT_ROOT/$OLD_SHA/api.${OLD_API#sha256:}.tar.gz"
expect_deploy_fail cutover artifact_tampered
grep -q 'sem imagem anterior verificável' "$TMP/artifact_tampered.err"
if grep -q '^docker load' "$COMMAND_LOG"; then fail 'tar adulterado foi carregado'; fi
no_runtime_change

# M. Manual rollback after a successful cutover when the engine lost the previous image:
# rollback.sh restores it from the recorded artifact using the frozen lib copy.
run_rollback(){ EVIDENCE_DIR="$DEPLOY_EVIDENCE_DIR/$SHA" APP_DIR="$APP" PRODUCTION_ENV_FILE="$TMP/canonical.env" bash "$DEPLOY_EVIDENCE_DIR/$SHA/rollback.sh" >"$TMP/$1.out" 2>&1; }
fresh_build
expect_deploy_ok cutover cutover_for_rollback
"${ENGINE[@]}" forget "$OLD_API"; : >"$COMMAND_LOG"
run_rollback manual_rollback || { cat "$TMP/manual_rollback.out"; fail 'rollback manual falhou'; }
grep -q "imagem de rollback $OLD_API de api ausente do Docker Engine; restaurando do artefato" "$TMP/manual_rollback.out"
grep -q "^RELEASE_RESTORE id=$OLD_API .* state=loaded$" "$TMP/manual_rollback.out"
grep -q '^docker compose .* up -d --no-build --no-deps --pull never --force-recreate api$' "$COMMAND_LOG"
[[ "$(container_image gest-o-production-api-1)" == "$OLD_API" && "$(container_image gest-o-production-web-1)" == "$OLD_WEB" ]]
# M2. Tampered artifact: rollback refuses before loading and before touching the runtime.
fresh_build
expect_deploy_ok cutover cutover_for_rollback2
"${ENGINE[@]}" forget "$OLD_API"; printf 'x' >>"$RELEASE_ARTIFACT_ROOT/$OLD_SHA/api.${OLD_API#sha256:}.tar.gz"; : >"$COMMAND_LOG"
if run_rollback tampered_rollback; then fail 'rollback aceitou artefato adulterado'; fi
grep -q 'não restaurou .*: tar_digest_mismatch' "$TMP/tampered_rollback.out"
if grep -Eq '^docker load|^docker compose .* (stop|rm|up) ' "$COMMAND_LOG"; then fail 'rollback alterou o runtime com artefato adulterado'; fi
[[ "$(container_image gest-o-production-api-1)" == "$NEW_API" ]]

printf 'production cutover no-rebuild safety passed\n'
