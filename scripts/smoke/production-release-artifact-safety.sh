#!/usr/bin/env bash
# Release artifact contract (pin, save, verify, restore, bootstrap, retention
# report) against the stateful fake OCI engine.  No real Docker access.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP:?}"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
export FAKE_DOCKER_STATE="$TMP/engine" COMMAND_LOG="$TMP/commands"
FAKE_REAL_NODE=$(command -v node); export FAKE_REAL_NODE
printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$ROOT/scripts/smoke/lib/fake-oci-docker.sh" >"$BIN/docker"; chmod +x "$BIN/docker"
export PATH="$BIN:$PATH"
ENGINE=(bash "$ROOT/scripts/smoke/lib/fake-oci-engine.sh")
RELEASE_ARTIFACT_EXPECTED_OWNER="$(id -un):$(id -gn)"
export RELEASE_ARTIFACT_EXPECTED_OWNER RELEASE_ARTIFACT_ROOT="$TMP/oci-backups" RELEASE_ARTIFACT_MIN_FREE_BYTES=0
export REBASELINE_EVIDENCE_DIR="$TMP/rebaseline" DEPLOY_EVIDENCE_DIR="$TMP/deploy" RELEASE_RETENTION_REPORT_DIR="$TMP/release-retention"
# shellcheck source=scripts/lib/production-rollback-image.sh
source "$ROOT/scripts/lib/production-rollback-image.sh"
# shellcheck source=scripts/lib/production-release-artifact.sh
source "$ROOT/scripts/lib/production-release-artifact.sh"

OLD=$(printf '6%.0s' {1..40}); NEW=$(printf '7%.0s' {1..40})
fail(){ printf 'FALHA: %s\n' "$*" >&2; exit 1; }
expect_error(){ [[ "$RELEASE_ERROR" == "$1" ]] || fail "esperado RELEASE_ERROR=$1, obtido ${RELEASE_ERROR:-vazio}"; }
no_tmp_left(){ ! compgen -G "$RELEASE_ARTIFACT_ROOT/*/.*.tmp.*" >/dev/null || fail 'temporário restou'; }
tag_id(){ docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }
reset(){
  "${ENGINE[@]}" init; : >"$COMMAND_LOG"
  rm -rf "${RELEASE_ARTIFACT_ROOT:?}" "${DEPLOY_EVIDENCE_DIR:?}" "${RELEASE_RETENTION_REPORT_DIR:?}" "${REBASELINE_EVIDENCE_DIR:?}"
  API=$("${ENGINE[@]}" image "gest-o-api:$OLD" "$OLD" 1.0.0 2026-10-01T00:00:00Z api)
  WEB=$("${ENGINE[@]}" image "gest-o-web:$OLD" "$OLD" 1.0.0 2026-10-01T00:00:00Z web)
  "${ENGINE[@]}" container gest-o-production-api-1 "$API" true '127.0.0.1:4000->4000/tcp' "$OLD" 2026-10-01T00:00:00Z
  "${ENGINE[@]}" container gest-o-production-web-1 "$WEB" true '127.0.0.1:5173->80/tcp' "$OLD" 2026-10-01T00:00:00Z
}

# A. Pin: created, pre-existing with the same ID (state=existing), conflict, absent.
reset
release_pin api "$API" >"$TMP/pin.out"
grep -qx "RELEASE_PIN role=api id=$API tag=gest-o-api-release:sha256-${API#sha256:} state=created" "$TMP/pin.out"
[[ "$(tag_id "gest-o-api-release:sha256-${API#sha256:}")" == "$API" ]]
docker tag "$WEB" "gest-o-web-release:sha256-${WEB#sha256:}"   # manual pin made on the VPS before the merge
: >"$COMMAND_LOG"
release_pin web "$WEB" >"$TMP/pin-existing.out"
grep -qx "RELEASE_PIN role=web id=$WEB tag=gest-o-web-release:sha256-${WEB#sha256:} state=existing" "$TMP/pin-existing.out"
grep -q '^docker tag ' "$COMMAND_LOG" && fail 'tag pré-existente com o mesmo ID foi recriada'
docker tag "$WEB" "gest-o-api-release:sha256-${API#sha256:}"   # conflicting name
if release_pin api "$API" >/dev/null; then fail 'conflito de tag de release aceito'; fi
expect_error release_tag_conflict
[[ "$(tag_id "gest-o-api-release:sha256-${API#sha256:}")" == "$WEB" ]] || fail 'pin em conflito moveu a tag'
if release_pin api "sha256:$(printf '1%.0s' {1..64})" >/dev/null; then fail 'pin de imagem ausente aceito'; fi
expect_error image_absent
if release_pin db "$API" >/dev/null; then fail 'papel inválido aceito'; fi; expect_error role

# B. Save: verified gzip OCI archive, protected record, nothing temporary left.
reset
release_save api "$API" "$OLD" 2026-10-01T00:00:00Z "$API" >"$TMP/save.out"
hex=${API#sha256:}; tar_file="$RELEASE_ARTIFACT_ROOT/$OLD/api.$hex.tar.gz"; meta_file="$RELEASE_ARTIFACT_ROOT/$OLD/api.$hex.release.tsv"
grep -q "^RELEASE_ARTIFACT role=api id=$API commit=$OLD tar=$tar_file tar_sha256=$(sha256sum "$tar_file" | cut -d' ' -f1) bytes=[0-9]* state=created$" "$TMP/save.out"
[[ "$(stat -c '%a' "$tar_file")" == 600 && "$(stat -c '%a' "$meta_file")" == 600 && "$(stat -c '%a' "$RELEASE_ARTIFACT_ROOT/$OLD")" == 700 ]]
gzip -dc "$tar_file" | tar -xOf - index.json | grep -q "\"digest\":\"$API\""
release_meta_load "$meta_file"
[[ "$RELEASE_META_COMMIT" == "$OLD" && "$RELEASE_META_IMAGE_ID" == "$API" && "$RELEASE_META_BUILT_AT" == 2026-10-01T00:00:00Z ]]
grep -qx 'compression	gzip-1' "$meta_file"
no_tmp_left
grep -Eq '^docker save gest-o-api-release:sha256-[0-9a-f]{64}$' "$COMMAND_LOG" || fail 'save não usou a tag de release'

# C/D/E. Disk, save and verification failures leave no record and no temporary file.
reset
if RELEASE_ARTIFACT_MIN_FREE_BYTES=999999999999999999 release_save api "$API" "$OLD" x "$API" >/dev/null; then fail 'disco insuficiente aceito'; fi
expect_error disk_insufficient; no_tmp_left
if compgen -G "$RELEASE_ARTIFACT_ROOT/$OLD/*.release.tsv" >/dev/null; then fail 'registro publicado sem espaço'; fi
grep -q '^docker save' "$COMMAND_LOG" && fail 'save executado sem espaço'
"${ENGINE[@]}" fault save-fail
if release_save api "$API" "$OLD" x "$API" >/dev/null 2>&1; then fail 'falha de save aceita'; fi
expect_error save_failed; no_tmp_left; "${ENGINE[@]}" clear save-fail
"${ENGINE[@]}" fault save-wrong-digest
if release_save api "$API" "$OLD" x "$API" >/dev/null; then fail 'index.json com outro digest aceito'; fi
expect_error index_mismatch; no_tmp_left; "${ENGINE[@]}" clear save-wrong-digest
! compgen -G "$RELEASE_ARTIFACT_ROOT/$OLD/*" >/dev/null || fail 'artefato parcial publicado'
if release_save api "$API" not-a-commit x "$API" >/dev/null; then fail 'commit inválido aceito'; fi; expect_error commit_format

# F. Lookup by runtime identity requires an intact record and archive.
reset
release_save api "$API" "$OLD" 2026-10-01T00:00:00Z "$API" >/dev/null
release_find_for_identity api "$API"; [[ "$RELEASE_FOUND_TAR" == "$tar_file" && "$RELEASE_FOUND_COMMIT" == "$OLD" ]]
if release_find_for_identity web "$API"; then fail 'artefato encontrado para o papel errado'; fi
cp "$tar_file" "$TMP/good.tar.gz"; printf 'x' >>"$tar_file"
if release_find_for_identity api "$API"; then fail 'tar adulterado aceito'; fi; expect_error tar_digest_mismatch
cat "$TMP/good.tar.gz" >"$tar_file"
chmod 644 "$meta_file"
if release_find_for_identity api "$API"; then fail 'registro desprotegido aceito'; fi; chmod 600 "$meta_file"
release_find_for_identity api "$API"

# G. Restore: digest checked before load, exact ID required after load.
"${ENGINE[@]}" forget "$API"; : >"$COMMAND_LOG"
if docker image inspect "$API" >/dev/null 2>&1; then fail 'imagem não foi esquecida'; fi
release_restore api "$API" >"$TMP/restore.out"
grep -qx "RELEASE_RESTORE id=$API tar=$tar_file state=loaded" "$TMP/restore.out"
[[ "$(tag_id "$API")" == "$API" && "$(tag_id "gest-o-api-release:sha256-${API#sha256:}")" == "$API" ]]
[[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$API")" == "$OLD" ]]
: >"$COMMAND_LOG"; release_restore api "$API" >"$TMP/restore2.out"
grep -qx "RELEASE_RESTORE id=$API tar=$tar_file state=present" "$TMP/restore2.out"
grep -q '^docker load' "$COMMAND_LOG" && fail 'load executado com a imagem presente'
"${ENGINE[@]}" forget "$API"; printf 'x' >>"$tar_file"; : >"$COMMAND_LOG"
if release_restore_tar "$API" "gest-o-api-release:sha256-${API#sha256:}" "$tar_file" "$(sha256sum "$TMP/good.tar.gz" | cut -d' ' -f1)" >/dev/null; then fail 'tar adulterado restaurado'; fi
expect_error tar_digest_mismatch
grep -q '^docker load' "$COMMAND_LOG" && fail 'load executado antes da prova de digest'
cat "$TMP/good.tar.gz" >"$tar_file"
"${ENGINE[@]}" fault load-other-id
if release_restore api "$API" >/dev/null; then fail 'load com outro ID aceito'; fi
expect_error load_id_mismatch; "${ENGINE[@]}" clear load-other-id

# H. Bootstrap of the running runtime (transition path).
reset
ensure_runtime_release_artifact build >"$TMP/boot.out"
grep -q "^RELEASE_ARTIFACT_BOOTSTRAP=PASS role=api id=$API commit=$OLD$" "$TMP/boot.out"
grep -q "^RELEASE_ARTIFACT_BOOTSTRAP=PASS role=web id=$WEB commit=$OLD$" "$TMP/boot.out"
ensure_runtime_release_artifact cutover >"$TMP/boot2.out"
grep -q "^RELEASE_ARTIFACT_BOOTSTRAP=EXISTS role=api id=$API commit=$OLD$" "$TMP/boot2.out"
grep -q "RELEASE_PIN role=api id=$API tag=gest-o-api-release:sha256-${API#sha256:} state=existing" "$TMP/boot2.out"
[[ "$(find "$RELEASE_ARTIFACT_ROOT/$OLD" -name '*.tar.gz' | wc -l)" -eq 2 ]] || fail 'bootstrap idempotente gerou artefato extra'
# Runtime image not inspectable, artifact present: still EXISTS (the inventory can restore it).
"${ENGINE[@]}" forget "$API"
ensure_runtime_release_artifact cutover >"$TMP/boot3.out"
grep -q "^RELEASE_ARTIFACT_BOOTSTRAP=EXISTS role=api id=$API" "$TMP/boot3.out"
# Neither artifact nor inspectable image: reported in build, fatal in cutover.
reset
"${ENGINE[@]}" forget "$API"
ensure_runtime_release_artifact build >"$TMP/boot4.out"
grep -q "^RELEASE_ARTIFACT_BOOTSTRAP=UNAVAILABLE role=api id=$API commit=unknown reason=not_inspectable_without_artifact$" "$TMP/boot4.out"
grep -q '^RELEASE_ARTIFACT_BOOTSTRAP=PASS role=web' "$TMP/boot4.out"
if ensure_runtime_release_artifact cutover >/dev/null; then fail 'cutover aceitou runtime sem artefato nem imagem'; fi
# Disk too small during bootstrap: FAIL is reported but the build is not failed.
reset
RELEASE_ARTIFACT_MIN_FREE_BYTES=999999999999999999 ensure_runtime_release_artifact build >"$TMP/boot5.out"
grep -q '^RELEASE_ARTIFACT_BOOTSTRAP=FAIL role=api .* reason=disk_insufficient$' "$TMP/boot5.out"
# Runtime image without revision label cannot be recorded.
"${ENGINE[@]}" init
UNL=$("${ENGINE[@]}" image "gest-o-api:legacy" '<no value>' 1.0.0 x api)
"${ENGINE[@]}" container gest-o-production-api-1 "$UNL" true '127.0.0.1:4000->4000/tcp'
"${ENGINE[@]}" container gest-o-production-web-1 "$UNL" true '127.0.0.1:5173->80/tcp'
ensure_runtime_release_artifact build >"$TMP/boot6.out"
grep -q '^RELEASE_ARTIFACT_BOOTSTRAP=FAIL role=api .* reason=revision_label$' "$TMP/boot6.out"

# I. Retention: report only.
reset
set_released_at(){ awk -F'\t' -v v="$2" 'BEGIN{OFS="\t"} $1=="released_at"{$2=v} {print}' "$1" >"$TMP/meta.edit"; cat "$TMP/meta.edit" >"$1"; }
declare -a R=()
for i in 1 2 3 4; do
  c=$(printf '%040d' 0 | tr 0 "$i")
  R[i]=$("${ENGINE[@]}" image "gest-o-api:$c" "$c" 1.0.0 "2026-09-0${i}T00:00:00Z" api)
  release_save api "${R[i]}" "$c" x "${R[i]}" >/dev/null
  set_released_at "$RELEASE_ARTIFACT_META" "2026-09-0${i}T00:00:00Z"
done
OLD_IN_USE=$("${ENGINE[@]}" image gest-o-api:in-use "$(printf 'a%.0s' {1..40})" 1.0.0 x api)
release_save api "$OLD_IN_USE" "$(printf 'a%.0s' {1..40})" x "$OLD_IN_USE" >/dev/null; set_released_at "$RELEASE_ARTIFACT_META" 2026-08-01T00:00:00Z
"${ENGINE[@]}" container stopped-old-api "$OLD_IN_USE" false -
OLD_ROLLBACK=$("${ENGINE[@]}" image gest-o-api:rollback "$(printf 'b%.0s' {1..40})" 1.0.0 x api)
release_save api "$OLD_ROLLBACK" "$(printf 'b%.0s' {1..40})" x "$OLD_ROLLBACK" >/dev/null; set_released_at "$RELEASE_ARTIFACT_META" 2026-07-01T00:00:00Z
mkdir -p "$DEPLOY_EVIDENCE_DIR/$NEW"; : >"$DEPLOY_EVIDENCE_DIR/$NEW/index.local.html"
printf 'role\trollback_mode\tcontainer_name\tcontainer_id\truntime_identity\trollback_reference\tport\tnetworks\trestart_policy\tprevious_commit\tresolution_method\tartifact_id\n' >"$DEPLOY_EVIDENCE_DIR/$NEW/previous-runtime.tsv"
printf 'api\timage\tc\tcid\t%s\t%s\t4000\tgest-o_default,\tunless-stopped\tb\truntime-identity\t%s\n' "$OLD_ROLLBACK" "$OLD_ROLLBACK" "$OLD_ROLLBACK" >>"$DEPLOY_EVIDENCE_DIR/$NEW/previous-runtime.tsv"
printf 'web\timage\tc\tcid\t%s\t%s\t5173\tgest-o_default,\tunless-stopped\tb\truntime-identity\t%s\n' "$WEB" "$WEB" "$WEB" >>"$DEPLOY_EVIDENCE_DIR/$NEW/previous-runtime.tsv"
mkdir -p "$RELEASE_ARTIFACT_ROOT/$OLD" "$REBASELINE_EVIDENCE_DIR/$OLD"
printf 'legacy' >"$RELEASE_ARTIFACT_ROOT/$OLD/gest-o-api.tar"; printf 'half' >"$RELEASE_ARTIFACT_ROOT/$OLD/.api.x.tar.gz.tmp.abc123"
printf 'PASS' >"$REBASELINE_EVIDENCE_DIR/$OLD/result.tsv"
before_files=$(find "$TMP/oci-backups" "$REBASELINE_EVIDENCE_DIR" "$DEPLOY_EVIDENCE_DIR" -printf '%p %s\n' | sort)
before_tags=$(sort "$FAKE_DOCKER_STATE/tags")
: >"$COMMAND_LOG"
release_retention_report >"$TMP/retention.out"
report_line(){ grep -F "RELEASE_RETENTION_REPORT kind=$1 path=$2 " "$TMP/retention.out"; }
rel(){ printf '%s/%s/api.%s.tar.gz' "$RELEASE_ARTIFACT_ROOT" "$1" "${2#sha256:}"; }
report_line release "$(rel "$(printf '4%.0s' {1..40})" "${R[4]}")" | grep -q 'decision=keep reason=recent_1$'
report_line release "$(rel "$(printf '3%.0s' {1..40})" "${R[3]}")" | grep -q 'decision=keep reason=recent_2$'
report_line release "$(rel "$(printf '2%.0s' {1..40})" "${R[2]}")" | grep -q 'decision=would_delete reason=superseded$'
report_line release "$(rel "$(printf '1%.0s' {1..40})" "${R[1]}")" | grep -q 'decision=would_delete reason=superseded$'
report_line release "$(rel "$(printf 'a%.0s' {1..40})" "$OLD_IN_USE")" | grep -q 'decision=keep reason=in_use$'
report_line release "$(rel "$(printf 'b%.0s' {1..40})" "$OLD_ROLLBACK")" | grep -q 'decision=keep reason=current_rollback$'
report_line legacy_file "$RELEASE_ARTIFACT_ROOT/$OLD/gest-o-api.tar" | grep -q 'decision=report_only'
report_line orphan_tmp "$RELEASE_ARTIFACT_ROOT/$OLD/.api.x.tar.gz.tmp.abc123" | grep -q 'decision=would_delete reason=incomplete_write$'
report_line rebaseline_dir "$REBASELINE_EVIDENCE_DIR/$OLD" | grep -q 'decision=report_only'
report_line image_tag "gest-o-api-release:sha256-${R[1]#sha256:}" | grep -q 'decision=would_delete reason=unreferenced$'
report_line image_tag "gest-o-api-release:sha256-${R[4]#sha256:}" | grep -q 'decision=keep reason=kept_release$'
grep -q '^RELEASE_RETENTION_REPORT kind=disk ' "$TMP/retention.out"
grep -q "^RELEASE_RETENTION=REPORTED file=$RELEASE_RETENTION_REPORT_DIR/" "$TMP/retention.out"
[[ "$(find "$RELEASE_RETENTION_REPORT_DIR" -name '*.tsv' -perm 600 | wc -l)" -eq 1 ]]
[[ "$(find "$TMP/oci-backups" "$REBASELINE_EVIDENCE_DIR" "$DEPLOY_EVIDENCE_DIR" -printf '%p %s\n' | sort)" == "$before_files" ]] || fail 'retenção alterou arquivos'
[[ "$(sort "$FAKE_DOCKER_STATE/tags")" == "$before_tags" ]] || fail 'retenção alterou tags'
grep -Eq '^docker (rmi|rm|image rm|image prune|system prune|tag)' "$COMMAND_LOG" && fail 'retenção executou comando de remoção'
# Unsupported mode is downgraded to report; unreadable inputs skip without failing.
RELEASE_RETENTION=delete release_retention_report >"$TMP/retention-mode.out"
grep -q '^RELEASE_RETENTION_WARN mode=delete unsupported_in_this_version using=report$' "$TMP/retention-mode.out"
grep -q '^RELEASE_RETENTION_MODE=report' "$TMP/retention-mode.out"
rm "$DEPLOY_EVIDENCE_DIR/$NEW/previous-runtime.tsv"
release_retention_report >"$TMP/retention-skip.out"
grep -qx 'RELEASE_RETENTION=SKIPPED reason=rollback_set_unreadable' "$TMP/retention-skip.out"
"${ENGINE[@]}" fault ps-fail
release_retention_report >"$TMP/retention-skip2.out"
grep -qx 'RELEASE_RETENTION=SKIPPED reason=containers_unreadable' "$TMP/retention-skip2.out"
"${ENGINE[@]}" clear ps-fail

# J. Static guarantees.
lib="$ROOT/scripts/lib/production-release-artifact.sh"
if grep -Eq '^\s*set -[a-z]*e' "$lib"; then fail 'lib depende de set -e'; fi
retention_body=$(awk '/^release_retention_report\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$lib")
[[ -n "$retention_body" ]] || fail 'função de retenção não encontrada'
if grep -Eq '\b(rm|rmi|prune|unlink|shred)\b|docker (image )?rm' <<<"$retention_body"; then fail 'retenção contém comando de remoção'; fi
if grep -Eq 'docker (rmi|image rm|image prune|system prune)' "$lib"; then fail 'lib remove imagens'; fi
# Preview cleanup only targets gesto-pr-<pr>-<run>-<attempt> projects and protected names; release tags never match.
grep -qF '/^gesto-pr-' "$ROOT/scripts/preview-image-lifecycle.mjs" || fail 'filtro de preview mudou; revisar proteção das tags de release'
[[ ! "gest-o-api-release:sha256-${API#sha256:}" =~ ^gesto-pr- ]]

printf 'production release artifact safety passed\n'
