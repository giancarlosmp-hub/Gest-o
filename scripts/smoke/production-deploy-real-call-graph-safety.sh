#!/usr/bin/env bash
# Real entrypoint -> deploy -> preflight call graph, build and cutover, against
# the stateful fake OCI engine (images, tags, containers and port owners live in
# $FAKE_DOCKER_STATE), so inventory, rollback-image resolution and the
# rebaseline restore path execute end to end.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP:?}"' EXIT
# shellcheck source=scripts/smoke/lib/production-deploy-harness.sh
source "$ROOT/scripts/smoke/lib/production-deploy-harness.sh"
harness_init
OLD_SHA=$(printf 'd%.0s' {1..40})
fresh_build(){ runtime_reset "$OLD_SHA"; expect_deploy_ok build build; : >"$COMMAND_LOG"; }

# Build: legacy env overlay, authoritative backup resolution and preflight, without touching the runtime.
runtime_reset "$OLD_SHA"
expect_deploy_ok build build
grep -qx 'LEGACY_VALUES_LOADED=PASS' "$TMP/build.out"
grep -qx 'PRODUCTION_BACKUP_AUTHORITATIVE_RESOLUTION=PASS' "$TMP/build.out"
grep -qx 'PRODUCTION_BACKUP_HINTS_OVERRIDDEN=PASS' "$TMP/build.out"
grep -qx 'PRODUCTION_PREFLIGHT=PASS' "$TMP/build.out"
if grep -q 'backup_path_mismatch' "$TMP/build.out" "$TMP/build.err"; then exit 1; fi
if grep -Eq 'docker (stop|start|rm|restart) |docker compose .* (up|stop|rm) |PRODUCTION_CUTOVER' "$COMMAND_LOG"; then exit 1; fi
[[ "$(grep -c '^DEPLOY_PREFLIGHT_SCRIPT_SOURCE=CHECKOUT_MAIN$' "$TMP/build.out")" -ge 2 ]]

# 1. Marcador stale com CONFIRM=PRODUCTION_CUTOVER deve falhar
fresh_build
mkdir -p "$DEPLOY_EVIDENCE_DIR/$SHA"; touch "$DEPLOY_EVIDENCE_DIR/$SHA/cutover-started"
expect_deploy_fail cutover stale PRODUCTION_CUTOVER
grep -q "evidência do SHA indica cutover iniciado; revisão manual obrigatória" "$TMP/stale.err"
no_runtime_change

# 2. Cutover parcialmente iniciado / container parado deve falhar na reautorização
docker stop "$(awk -F'\t' '$1=="gest-o-production-web-1"{print $2}' "$FAKE_DOCKER_STATE/containers")" >/dev/null
: >"$COMMAND_LOG"
expect_deploy_fail cutover partial PRODUCTION_CUTOVER_REAUTHORIZED
grep -q "reautorização bloqueada: porta 5173 não possui proprietário único ou container foi parado" "$TMP/partial.err"
no_runtime_change

# 3. Marcador stale reautorizado com containers saudáveis deve arquivar a evidência e prosseguir.
# Os rótulos de rollback vêm da imagem resolvida (OLD_SHA, 0.9.0), que é a que o rollback sobe,
# e não do APP_COMMIT do ambiente do container.
fresh_build
"${ENGINE[@]}" container gest-o-production-api-1 "gest-o-api:$OLD_SHA" true '127.0.0.1:4000->4000/tcp' not-the-image-label 2026-09-01T00:00:00Z
mkdir -p "$DEPLOY_EVIDENCE_DIR/$SHA"; touch "$DEPLOY_EVIDENCE_DIR/$SHA/cutover-started"
expect_deploy_ok cutover reauth PRODUCTION_CUTOVER_REAUTHORIZED
grep -q "cutover reautorizado manualmente para $SHA" "$TMP/reauth.out"
compgen -G "$DEPLOY_EVIDENCE_DIR/$SHA.reauthorized-*" >/dev/null
grep -q "method=runtime-identity verified_identity=$OLD_API artifact_id=$OLD_API" "$TMP/reauth.out"
grep -qx "ROLLBACK_APP_COMMIT=$OLD_SHA" "$DEPLOY_EVIDENCE_DIR/$SHA/rollback-images.env"
grep -qx "ROLLBACK_APP_VERSION=0.9.0" "$DEPLOY_EVIDENCE_DIR/$SHA/rollback-images.env"
grep -qx "ROLLBACK_APP_BUILT_AT=2026-09-01T00:00:00Z" "$DEPLOY_EVIDENCE_DIR/$SHA/rollback-images.env"
[[ "$(awk -F'\t' '$1=="api"{print $10}' "$DEPLOY_EVIDENCE_DIR/$SHA/previous-runtime.tsv")" == "$OLD_SHA" ]]
[[ "$(awk -F'\t' '$1=="web"{print $10}' "$DEPLOY_EVIDENCE_DIR/$SHA/previous-runtime.tsv")" == "$OLD_SHA" ]]
grep -q '^docker compose .* up -d --no-build --no-deps --pull never api web' "$COMMAND_LOG"

# 4. Cutover concluído deve ser idempotente (runtime já serve $SHA)
: >"$COMMAND_LOG"
expect_deploy_ok cutover completed PRODUCTION_CUTOVER
grep -q "Cutover já concluído anteriormente para $SHA" "$TMP/completed.out"
no_runtime_change

# 5. Imagem legada não inspecionável, sem artefato de release, com rebaseline válida:
# restaura o backup OCI e conclui o cutover.  O rollback sobe o artefato de rebaseline,
# então os rótulos gravados são os dele ($SHA), não os do runtime legado.
fresh_build
rm -rf "${RELEASE_ARTIFACT_ROOT:?}"
"${ENGINE[@]}" forget "$OLD_API"; "${ENGINE[@]}" forget "$OLD_WEB"
mkdir -p "$REBASELINE_EVIDENCE_DIR/$SHA" "$RELEASE_ARTIFACT_ROOT/$SHA"
api_id=$("${ENGINE[@]}" image "rebaseline-api:$SHA" "$SHA" 1.0.0 2026-09-29T11:00:00Z api)
web_id=$("${ENGINE[@]}" image "rebaseline-web:$SHA" "$SHA" 1.0.0 2026-09-29T11:00:00Z web)
api_tar="$RELEASE_ARTIFACT_ROOT/$SHA/gest-o-api.tar"; web_tar="$RELEASE_ARTIFACT_ROOT/$SHA/gest-o-web.tar"
docker save "rebaseline-api:$SHA" >"$api_tar"; docker save "rebaseline-web:$SHA" >"$web_tar"
"${ENGINE[@]}" forget "$api_id"; "${ENGINE[@]}" forget "$web_id"
api_tar_sha=$(sha256sum "$api_tar" | cut -d' ' -f1); web_tar_sha=$(sha256sum "$web_tar" | cut -d' ' -f1)
cat >"$REBASELINE_EVIDENCE_DIR/$SHA/result.tsv" <<EOF
result	PASS
rebaseline_commit	$SHA
rebaselined_at	2026-09-29T12:00:00Z
api_image_tag	gest-o-api:$SHA
api_image_id	$api_id
api_image_digest	$api_id
api_tar_path	$api_tar
api_tar_sha256	$api_tar_sha
web_image_tag	gest-o-web:$SHA
web_image_id	$web_id
web_image_digest	$web_id
web_tar_path	$web_tar
web_tar_sha256	$web_tar_sha
legacy_runtime_api_identity	$OLD_API
legacy_runtime_api_commit	$OLD_SHA
legacy_runtime_api_inspectable	no
legacy_runtime_web_identity	$OLD_WEB
legacy_runtime_web_commit	$OLD_SHA
legacy_runtime_web_inspectable	no
cutover_executed	NO
EOF
cat >"$REBASELINE_EVIDENCE_DIR/$SHA/manifest.tsv" <<EOF
role	image_tag	image_id	digest	tar_path	tar_sha256
api	gest-o-api:$SHA	$api_id	$api_id	$api_tar	$api_tar_sha
web	gest-o-web:$SHA	$web_id	$web_id	$web_tar	$web_tar_sha
EOF
: >"$COMMAND_LOG"
expect_deploy_ok cutover rebaseline_cutover PRODUCTION_CUTOVER
grep -q "RELEASE_ARTIFACT_BOOTSTRAP=UNAVAILABLE role=api" "$TMP/rebaseline_cutover.out"
grep -q "method=authorized-rebaseline" "$TMP/rebaseline_cutover.out"
grep -q "verified_target_id=$api_id" "$TMP/rebaseline_cutover.out"
grep -q "^docker load -i $api_tar" "$COMMAND_LOG"
grep -qx "ROLLBACK_APP_COMMIT=$SHA" "$DEPLOY_EVIDENCE_DIR/$SHA/rollback-images.env"
grep -qx "ROLLBACK_APP_VERSION=1.0.0" "$DEPLOY_EVIDENCE_DIR/$SHA/rollback-images.env"
grep -qx "ROLLBACK_APP_BUILT_AT=2026-09-29T11:00:00Z" "$DEPLOY_EVIDENCE_DIR/$SHA/rollback-images.env"
if grep -q "$OLD_SHA" "$DEPLOY_EVIDENCE_DIR/$SHA/rollback-images.env"; then exit 1; fi
[[ "$(awk -F'\t' '$1=="api"{print $10}' "$DEPLOY_EVIDENCE_DIR/$SHA/previous-runtime.tsv")" == "$SHA" ]]

# 6. Imagem legada ausente, sem artefato de release e sem rebaseline: falha fechado
fresh_build
rm -rf "${RELEASE_ARTIFACT_ROOT:?}"
"${ENGINE[@]}" forget "$OLD_API"; "${ENGINE[@]}" forget "$OLD_WEB"
expect_deploy_fail cutover no_rebaseline PRODUCTION_CUTOVER
grep -q "sem imagem anterior verificável" "$TMP/no_rebaseline.err"
no_runtime_change
[[ ! -e "$DEPLOY_EVIDENCE_DIR/$SHA/cutover-started" ]]

# 7. Imagem de rollback verificável, mas sem rótulo de revisão: falha antes de parar qualquer container
runtime_reset "$OLD_SHA"
UNL_API=$("${ENGINE[@]}" image gest-o-api:unlabelled '<no value>' 0.9.0 2026-09-01T00:00:00Z api)
"${ENGINE[@]}" image gest-o-web:unlabelled '<no value>' 0.9.0 2026-09-01T00:00:00Z web >/dev/null
"${ENGINE[@]}" container gest-o-production-api-1 gest-o-api:unlabelled true '127.0.0.1:4000->4000/tcp' "$OLD_SHA" 2026-09-01T00:00:00Z
"${ENGINE[@]}" container gest-o-production-web-1 gest-o-web:unlabelled true '127.0.0.1:5173->80/tcp' "$OLD_SHA" 2026-09-01T00:00:00Z
expect_deploy_ok build build_unlabelled
grep -q '^RELEASE_ARTIFACT_BOOTSTRAP=FAIL role=api .* reason=revision_label$' "$TMP/build_unlabelled.out"
: >"$COMMAND_LOG"
expect_deploy_fail cutover unlabelled PRODUCTION_CUTOVER
grep -q "artefato de rollback $UNL_API de api sem rótulo org.opencontainers.image.revision" "$TMP/unlabelled.err"
no_runtime_change
[[ ! -e "$DEPLOY_EVIDENCE_DIR/$SHA/cutover-started" ]]

printf 'production deploy real call graph safety passed\n'
