#!/usr/bin/env bash
# legacy-preview-cleanup.sh --pr=N: simulation, apply and every stop, against a
# fake Docker/gh/nginx/systemctl in a temporary directory.  Fictitious data only.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/legacy-preview-cleanup.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP:?}"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
fail(){ printf 'FALHA: %s\n' "$*" >&2; exit 1; }

cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
# Stateful fake: $FAKE_STATE/{containers/<name>/*,networks/<name>,volumes/<name>,images/<hex>/tags}
set -uo pipefail
S=$FAKE_STATE
printf '%s\n' "$*" >>"$FAKE_STATE/calls"
mut(){ printf '%s\n' "$*" >>"$FAKE_STATE/mutations"; }
containers(){ local d; for d in "$S"/containers/*/; do [[ -d "$d" ]] && basename "$d"; done; }
case "$1 ${2:-}" in
  'ps -a')
    filter=''; for a in "$@"; do case "$a" in label=*|volume=*|network=*|ancestor=*) filter=$a;; esac; done
    containers | while IFS= read -r c; do
      d="$S/containers/$c"
      case "$filter" in
        '') echo "$c" ;;
        label=com.docker.compose.project=*) [[ "$(cat "$d/project")" == "${filter#label=com.docker.compose.project=}" ]] && echo "$c" ;;
        volume=*) grep -q "^volume|${filter#volume=}$" "$d/mounts" && echo "$c" ;;
        network=*) grep -Fxq "${filter#network=}" "$d/networks" && echo "$c" ;;
        ancestor=*) [[ "$(cat "$d/image")" == "${filter#ancestor=}" ]] && echo "$c" ;;
      esac
    done; exit 0 ;;
  'container inspect')
    fmt=$4; d="$S/containers/$5"; [[ -d "$d" ]] || exit 1
    case "$fmt" in
      *'.Mounts'*) cat "$d/mounts" ;;
      *'NetworkSettings'*) cat "$d/networks" ;;
      *'range $k, $v := .Config.Labels'*) cat "$d/labels" ;;
      *) printf '%s|%s|%s|%s\n' "$(cat "$d/image")" "$(cat "$d/status")" "$(cat "$d/project")" "$(cat "$d/service")" ;;
    esac; exit 0 ;;
  'container rm')
    [[ "$#" -eq 3 && "$3" != -* ]] || { mut "REFUSED $*"; exit 99; }
    d="$S/containers/$3"; [[ -d "$d" ]] || exit 1
    [[ "$(cat "$d/status")" != running ]] || exit 1
    rm -r "$d"; mut "container rm $3"; exit 0 ;;
  'network ls') for f in "$S"/networks/*; do [[ -e "$f" ]] && basename "$f"; done; exit 0 ;;
  'volume ls') for f in "$S"/volumes/*; do [[ -e "$f" ]] && basename "$f"; done; exit 0 ;;
  'network rm') [[ "$#" -eq 3 && -e "$S/networks/$3" ]] || { mut "REFUSED $*"; exit 99; }; rm "$S/networks/$3"; mut "network rm $3"; exit 0 ;;
  'volume rm') [[ "$#" -eq 3 && -e "$S/volumes/$3" ]] || { mut "REFUSED $*"; exit 99; }; rm "$S/volumes/$3"; mut "volume rm $3"; exit 0 ;;
  'image inspect')
    ref=${*: -1}; hex=${ref#sha256:}; dir="$S/images/$hex"
    if [[ ! -d "$dir" ]]; then dir=$(grep -lFx -- "$ref" "$S"/images/*/tags 2>/dev/null | head -n1); dir=${dir%/tags}; fi
    [[ -n "$dir" && -d "$dir" ]] || exit 1
    case "$4" in *RepoTags*) cat "$dir/tags" ;; *) echo "sha256:$(basename "$dir")" ;; esac; exit 0 ;;
  'image rm')
    [[ "$#" -eq 3 && "$3" != -* ]] || { mut "REFUSED $*"; exit 99; }
    if [[ "$3" == sha256:* ]]; then
      dir="$S/images/${3#sha256:}"; [[ -d "$dir" && ! -s "$dir/tags" ]] || exit 1
      rm -r "$dir"; mut "image rm $3"; exit 0
    fi
    file=$(grep -lFx -- "$3" "$S"/images/*/tags 2>/dev/null | head -n1); [[ -n "$file" ]] || exit 1
    grep -vFx -- "$3" "$file" >"$file.new" || :; mv "$file.new" "$file"
    [[ -s "$file" ]] || rm -r "${file%/tags}"
    mut "image rm $3"; exit 0 ;;
esac
mut "UNEXPECTED $*"; exit 99
FAKE
cat >"$BIN/gh" <<'FAKE'
#!/usr/bin/env bash
case "$1 $2" in
  'auth status') [[ "${FAKE_GH:-unauthenticated}" != unauthenticated ]] ;;
  'pr view') printf '%s\n' "$FAKE_GH" ;;
  *) exit 2 ;;
esac
FAKE
cat >"$BIN/nginx" <<'FAKE'
#!/usr/bin/env bash
printf 'nginx %s\n' "$*" >>"$FAKE_STATE/calls"
[[ "$1" == -t ]] || exit 2
if [[ "${FAKE_NGINX_TEST:-ok}" == fail_once && ! -e "$FAKE_STATE/nginx_failed" ]]; then touch "$FAKE_STATE/nginx_failed"; exit 1; fi
[[ "${FAKE_NGINX_TEST:-ok}" != fail ]]
FAKE
cat >"$BIN/systemctl" <<'FAKE'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$FAKE_STATE/mutations"
FAKE
chmod +x "$BIN"/*
export PATH="$BIN:$PATH"

PR=42 HEX_API=$(printf 'a%.0s' {1..64}) HEX_WEB=$(printf 'b%.0s' {1..64}) HEX_PG=$(printf 'c%.0s' {1..64}) HEX_OTHER=$(printf 'd%.0s' {1..64})
container(){ # name project service imagehex status volume network
  local d="$FAKE_STATE/containers/$1"; mkdir -p "$d"
  printf '%s\n' "$2" >"$d/project"; printf '%s\n' "$3" >"$d/service"; printf 'sha256:%s\n' "$4" >"$d/image"; printf '%s\n' "$5" >"$d/status"
  printf 'com.docker.compose.project\ncom.docker.compose.service\n' >"$d/labels"
  if [[ -n "$6" ]]; then printf 'volume|%s\n' "$6" >"$d/mounts"; else : >"$d/mounts"; fi
  printf '%s\n' "$7" >"$d/networks"
}
image(){ mkdir -p "$FAKE_STATE/images/$1"; shift; if (( $# )); then printf '%s\n' "$@" >"${FAKE_STATE}/images/${HEX:-x}/tags"; fi; }
reset(){
  rm -rf "${TMP:?}/state" "${TMP:?}/www" "${TMP:?}/nginx" "${TMP:?}/evidence" "${TMP:?}/logs"
  export FAKE_STATE="$TMP/state"; mkdir -p "$FAKE_STATE"/{containers,networks,volumes,images}; : >"$FAKE_STATE/mutations"; : >"$FAKE_STATE/calls"
  export PREVIEW_ROOT="$TMP/www/preview" NGINX_SITES_DIR="$TMP/nginx" LEGACY_CLEANUP_LOG_DIR="$TMP/logs"
  export DEPLOY_EVIDENCE_DIR="$TMP/evidence/deploy" BUILD_EVIDENCE_DIR="$TMP/evidence/deploy-builds" REBASELINE_EVIDENCE_DIR="$TMP/evidence/rebaseline" RELEASE_ARTIFACT_ROOT="$TMP/evidence/oci-backups"
  mkdir -p "$DEPLOY_EVIDENCE_DIR/sha-fict" "$BUILD_EVIDENCE_DIR" "$RELEASE_ARTIFACT_ROOT"
  printf 'role\truntime_identity\napi\tsha256:%s\n' "$HEX_OTHER" >"$DEPLOY_EVIDENCE_DIR/sha-fict/previous-runtime.tsv"
  unset FAKE_GH FAKE_NGINX_TEST
  # Legacy preview #42 (fictitious) and an unrelated preview #420 plus production.
  container gesto-pr-42-db-1 gesto-pr-42 db "$HEX_PG" exited gesto_pgdata_pr_42 gesto-pr-42_default
  container gesto-pr-42-api-1 gesto-pr-42 api "$HEX_API" exited '' gesto-pr-42_default
  container gesto-pr-42-web-1 gesto-pr-42 web "$HEX_WEB" exited '' gesto-pr-42_default
  container gesto-pr-420-api-1 gesto-pr-420 api "$HEX_OTHER" running '' gesto-pr-420_default
  container gest-o-production-api-1 gest-o-production api "$HEX_OTHER" running '' gest-o_default
  touch "$FAKE_STATE/networks/gesto-pr-42_default" "$FAKE_STATE/networks/gesto-pr-420_default" "$FAKE_STATE/networks/gest-o_default"
  touch "$FAKE_STATE/volumes/gesto_pgdata_pr_42" "$FAKE_STATE/volumes/gest-o_pgdata"
  HEX=$HEX_API image "$HEX_API" gesto-pr-42-api:latest
  HEX=$HEX_WEB image "$HEX_WEB" gesto-pr-42-web:latest
  HEX=$HEX_PG image "$HEX_PG" postgres:16
  HEX=$HEX_OTHER image "$HEX_OTHER" gest-o-api:fict
  mkdir -p "$PREVIEW_ROOT/pr-42/apps/api" "$PREVIEW_ROOT/pr-420"
  printf 'fictício\n' >"$PREVIEW_ROOT/pr-42/apps/api/file.txt"; printf 'x\n' >"$PREVIEW_ROOT/pr-42/README"
  mkdir -p "$NGINX_SITES_DIR/sites-available" "$NGINX_SITES_DIR/sites-enabled"
  printf '# shared\n' >"$NGINX_SITES_DIR/sites-available/crm-preview"
  ln -s "$NGINX_SITES_DIR/sites-available/crm-preview" "$NGINX_SITES_DIR/sites-enabled/crm-preview"
  printf '42\tCLOSED\n420\tOPEN\n' >"$TMP/closed.tsv"
}
run(){ set +e; OUT=$(bash "$SCRIPT" "$@" 2>"$TMP/stderr"); RC=$?; set -e; }
expect_stop(){ # reason args...
  local reason=$1; shift; run "$@"
  [[ "$RC" -eq 1 ]] || fail "esperado exit 1 para $reason, obtido $RC: $OUT"
  grep -q "LEGACY_PREVIEW_RESULT=STOPPED pr=$PR reason=$reason mutations=0" <<<"$OUT" || fail "esperado $reason: $OUT"
  [[ ! -s "$FAKE_STATE/mutations" ]] || fail "$reason alterou estado: $(cat "$FAKE_STATE/mutations")"
}
APPLY=(--pr=42 "--closed-prs=$TMP/closed.tsv" --apply --expect-containers=3)

# --- Simulation: nothing changes; output has names and counts only. ---
reset; run --pr=42 "--closed-prs=$TMP/closed.tsv"
[[ "$RC" -eq 0 ]] || fail "simulação falhou: $OUT"
grep -q 'LEGACY_PREVIEW_RESULT=SIMULATED pr=42 mutations=0' <<<"$OUT" || fail 'simulação sem resultado'
grep -q 'LEGACY_PREVIEW_COUNTS containers=3 running=0 networks=1 volumes=1 images=2 preview_dirs=1 nginx_sites=0' <<<"$OUT" || fail "contagens: $OUT"
grep -q 'object=nginx_site nginx_site=shared_preserved' <<<"$OUT" || fail 'site compartilhado não relatado'
grep -q 'PR_STATE=CLOSED source=file gh=unavailable' <<<"$OUT" || fail 'fonte do estado do PR'
if grep -qE '[0-9a-f]{64}' <<<"$OUT"; then fail 'saída com ID completo'; fi
if grep -q 'gesto-pr-420' <<<"$OUT"; then fail 'simulação listou preview de outro PR'; fi
[[ ! -s "$FAKE_STATE/mutations" ]] || fail 'simulação alterou estado'
compgen -G "$LEGACY_CLEANUP_LOG_DIR/*-pr-42.log" >/dev/null || fail 'log ausente'

# --- Apply: removes exactly preview #42 by name. ---
reset; run "${APPLY[@]}"
[[ "$RC" -eq 0 ]] || fail "apply falhou: $OUT"
expected=$'container rm gesto-pr-42-db-1\ncontainer rm gesto-pr-42-api-1\ncontainer rm gesto-pr-42-web-1\nnetwork rm gesto-pr-42_default\nvolume rm gesto_pgdata_pr_42'
[[ "$(head -n5 "$FAKE_STATE/mutations" | LC_ALL=C sort)" == "$(LC_ALL=C sort <<<"$expected")" ]] || fail "remoções: $(cat "$FAKE_STATE/mutations")"
grep -Fxq 'image rm gesto-pr-42-api:latest' "$FAKE_STATE/mutations" && grep -Fxq 'image rm gesto-pr-42-web:latest' "$FAKE_STATE/mutations" || fail 'imagens api/web não removidas'
[[ "$(wc -l <"$FAKE_STATE/mutations")" -eq 7 ]] || fail "remoções a mais: $(cat "$FAKE_STATE/mutations")"
[[ -d "$FAKE_STATE/images/$HEX_PG" && -d "$FAKE_STATE/images/$HEX_OTHER" ]] || fail 'imagem compartilhada/produção removida'
[[ -d "$FAKE_STATE/containers/gesto-pr-420-api-1" && -d "$FAKE_STATE/containers/gest-o-production-api-1" && -e "$FAKE_STATE/volumes/gest-o_pgdata" ]] || fail 'recurso alheio removido'
[[ ! -e "$PREVIEW_ROOT/pr-42" && -d "$PREVIEW_ROOT/pr-420" ]] || fail 'pasta da preview'
[[ -f "$NGINX_SITES_DIR/sites-available/crm-preview" && -L "$NGINX_SITES_DIR/sites-enabled/crm-preview" ]] || fail 'site compartilhado tocado'
grep -q 'LEGACY_PREVIEW_RESULT=APPLIED pr=42 mutations=8' <<<"$OUT" || fail "resultado do apply: $OUT"
if grep -q 'systemctl' "$FAKE_STATE/mutations"; then fail 'reload sem site por PR'; fi

# --- Apply with a per-PR site: nginx -t then reload. ---
reset; printf '# pr 42\n' >"$NGINX_SITES_DIR/sites-available/crm-preview-pr-42"
ln -s "$NGINX_SITES_DIR/sites-available/crm-preview-pr-42" "$NGINX_SITES_DIR/sites-enabled/crm-preview-pr-42"
run "${APPLY[@]}"
[[ "$RC" -eq 0 && ! -e "$NGINX_SITES_DIR/sites-available/crm-preview-pr-42" && ! -L "$NGINX_SITES_DIR/sites-enabled/crm-preview-pr-42" ]] || fail "site por PR: $OUT"
grep -Fxq 'systemctl reload nginx' "$FAKE_STATE/mutations" || fail 'reload ausente'
grep -Fxq 'nginx -t' "$FAKE_STATE/calls" || fail 'nginx -t ausente'
[[ -f "$NGINX_SITES_DIR/sites-available/crm-preview" ]] || fail 'site compartilhado tocado'

# --- nginx -t fails: site restored, stop, no reload. ---
reset; printf '# pr 42\n' >"$NGINX_SITES_DIR/sites-available/crm-preview-pr-42"
ln -s "$NGINX_SITES_DIR/sites-available/crm-preview-pr-42" "$NGINX_SITES_DIR/sites-enabled/crm-preview-pr-42"
export FAKE_NGINX_TEST=fail_once; run "${APPLY[@]}"; unset FAKE_NGINX_TEST
[[ "$RC" -eq 1 ]] && grep -q 'reason=nginx_test_failed_site_restored' <<<"$OUT" || fail "nginx -t falho: $OUT"
[[ "$(grep -c '^nginx -t$' "$FAKE_STATE/calls")" -eq 2 ]] || fail 'nginx -t não revalidado após restaurar'
[[ -f "$NGINX_SITES_DIR/sites-available/crm-preview-pr-42" && -L "$NGINX_SITES_DIR/sites-enabled/crm-preview-pr-42" ]] || fail 'site não restaurado'
if grep -q 'systemctl' "$FAKE_STATE/mutations"; then fail 'reload com nginx -t falho'; fi

# --- Stops (nothing changes). ---
reset; printf 'volume|gest-o_pgdata\n' >"$FAKE_STATE/containers/gesto-pr-42-db-1/mounts"
expect_stop production_volume "${APPLY[@]}"
reset; printf 'volume|gesto_pgdata_pr_42\nvolume|gest-o_pgdata_clean_v2_fict\n' >"$FAKE_STATE/containers/gesto-pr-42-db-1/mounts"
expect_stop production_volume "${APPLY[@]}"
reset; printf 'volume|gesto_pgdata_pr_42\nvolume|outro_volume\n' >"$FAKE_STATE/containers/gesto-pr-42-db-1/mounts"
expect_stop unexpected_volume "${APPLY[@]}"
reset; printf 'bind|\n' >"$FAKE_STATE/containers/gesto-pr-42-api-1/mounts"
expect_stop unexpected_mount "${APPLY[@]}"
reset; printf 'volume|gesto_pgdata_pr_42\n' >"$FAKE_STATE/containers/gesto-pr-420-api-1/mounts"
expect_stop volume_used_outside_project "${APPLY[@]}"
reset; printf 'gesto-pr-42-api:latest\ngest-o-api-rollback:fict\n' >"$FAKE_STATE/images/$HEX_API/tags"
expect_stop image_protected_tag "${APPLY[@]}"
reset; printf 'gest-o-web:fict\n' >"$FAKE_STATE/images/$HEX_WEB/tags"
expect_stop image_protected_tag "${APPLY[@]}"
reset; printf 'gesto-pr-42-api:latest\ngesto-pr-43-api:latest\n' >"$FAKE_STATE/images/$HEX_API/tags"
expect_stop image_foreign_tag "${APPLY[@]}"
reset; printf 'api_image_id\tsha256:%s\n' "$HEX_API" >"$BUILD_EVIDENCE_DIR/build.tsv"
expect_stop image_in_deploy_evidence "${APPLY[@]}"
reset; mkdir -p "$RELEASE_ARTIFACT_ROOT/fict"; printf 'image_id\tsha256:%s\n' "$HEX_WEB" >"$RELEASE_ARTIFACT_ROOT/fict/web.x.release.tsv"
expect_stop image_in_deploy_evidence "${APPLY[@]}"
reset; printf 'sha256:%s\n' "$HEX_API" >"$FAKE_STATE/containers/gesto-pr-420-api-1/image"
expect_stop image_used_outside_project "${APPLY[@]}"
reset; printf '42\tOPEN\n' >"$TMP/closed.tsv"
expect_stop pr_not_closed "${APPLY[@]}"
expect_stop pr_not_closed --pr=42 "--closed-prs=$TMP/closed.tsv"
reset; printf '43\tCLOSED\n' >"$TMP/closed.tsv"
expect_stop pr_state_missing_or_duplicated "${APPLY[@]}"
reset; printf '42\tCLOSED\n42\tMERGED\n' >"$TMP/closed.tsv"
expect_stop pr_state_missing_or_duplicated "${APPLY[@]}"
reset; printf '42 CLOSED\n' >"$TMP/closed.tsv"
expect_stop closed_prs_invalid_line "${APPLY[@]}"
reset; export FAKE_GH=OPEN; expect_stop pr_state_sources_disagree "${APPLY[@]}"; unset FAKE_GH
reset; export FAKE_GH=MERGED; expect_stop pr_state_sources_disagree "${APPLY[@]}"; unset FAKE_GH
reset; expect_stop expect_containers_mismatch --pr=42 "--closed-prs=$TMP/closed.tsv" --apply --expect-containers=2
reset; expect_stop expect_containers_mismatch --pr=42 "--closed-prs=$TMP/closed.tsv" --apply --expect-containers=4
reset; printf 'running\n' >"$FAKE_STATE/containers/gesto-pr-42-web-1/status"
expect_stop containers_running "${APPLY[@]}"
reset; mkdir -p "$PREVIEW_ROOT/pr-42/gesto-pr-42-100-1"
expect_stop preview_dir_has_new_preview "${APPLY[@]}"
reset; mv "$PREVIEW_ROOT/pr-42" "$TMP/www/elsewhere"; ln -s "$TMP/www/elsewhere" "$PREVIEW_ROOT/pr-42"
expect_stop preview_dir_symlink "${APPLY[@]}"
[[ -f "$TMP/www/elsewhere/README" ]] || fail 'alvo do link alterado'
reset; container gesto-pr-42-100-1-api-1 gesto-pr-42 api "$HEX_API" exited '' gesto-pr-42_default
expect_stop container_name_not_legacy "${APPLY[@]}"
reset; printf 'com.gesto.preview.pr\n' >>"$FAKE_STATE/containers/gesto-pr-42-api-1/labels"
expect_stop container_has_new_preview_labels "${APPLY[@]}"
reset; printf 'gest-o-production\n' >"$FAKE_STATE/containers/gesto-pr-42-api-1/project"
expect_stop container_set_diverged "${APPLY[@]}"
reset; printf 'gesto-pr-42_default\ngest-o_default\n' >"$FAKE_STATE/containers/gesto-pr-42-api-1/networks"
expect_stop unexpected_network "${APPLY[@]}"
reset; printf 'gesto-pr-42_default\n' >"$FAKE_STATE/containers/gesto-pr-420-api-1/networks"
expect_stop network_used_outside_project "${APPLY[@]}"
reset; printf '# pr 42\n' >"$NGINX_SITES_DIR/sites-available/crm-preview-pr-42"
ln -s "$NGINX_SITES_DIR/sites-available/crm-preview" "$NGINX_SITES_DIR/sites-enabled/crm-preview-pr-42"
expect_stop nginx_site_unexpected "${APPLY[@]}"
reset; rm -r "${FAKE_STATE:?}/containers/gesto-pr-42-db-1" "${FAKE_STATE:?}/containers/gesto-pr-42-api-1" "${FAKE_STATE:?}/containers/gesto-pr-42-web-1"
expect_stop no_containers "${APPLY[@]}"

# --- Old volume name gest-o_pgdata_pr_N: accepted only with the exact --pr number. ---
reset; rm "$FAKE_STATE/volumes/gesto_pgdata_pr_42"; touch "$FAKE_STATE/volumes/gest-o_pgdata_pr_42"
printf 'volume|gest-o_pgdata_pr_42\n' >"$FAKE_STATE/containers/gesto-pr-42-db-1/mounts"
run "${APPLY[@]}"
[[ "$RC" -eq 0 ]] || fail "volume com nome antigo: $OUT"
grep -Fxq 'volume rm gest-o_pgdata_pr_42' "$FAKE_STATE/mutations" || fail 'volume antigo não removido'
[[ -e "$FAKE_STATE/volumes/gest-o_pgdata" ]] || fail 'volume de produção removido'
for other in gest-o_pgdata_pr_420 gest-o_pgdata_pr_4 gest-o_pgdata_pr_42_old; do
  reset; touch "$FAKE_STATE/volumes/$other"; printf 'volume|%s\n' "$other" >"$FAKE_STATE/containers/gesto-pr-42-db-1/mounts"
  expect_stop production_volume "${APPLY[@]}"
done
reset; touch "$FAKE_STATE/volumes/gest-o_pgdata_pr_42"; printf 'volume|gest-o_pgdata_pr_42\n' >"$FAKE_STATE/containers/gesto-pr-42-api-1/mounts"
expect_stop volume_names_ambiguous "${APPLY[@]}"

# --- Orphan volume mode: simulation by default, --apply removes only that volume. ---
orphan_reset(){ reset; touch "$FAKE_STATE/volumes/gesto_pgdata_pr_43" "$FAKE_STATE/volumes/gest-o_pgdata_pr_44" "$FAKE_STATE/volumes/gesto_pgdata_pr_420"; printf '42\tCLOSED\n43\tMERGED\n44\tCLOSED\n420\tOPEN\n' >"$TMP/closed.tsv"; }
orphan_stop(){ # reason pr args...
  local reason=$1 pr=$2; shift 2; run "$@"
  [[ "$RC" -eq 1 ]] && grep -q "LEGACY_PREVIEW_RESULT=STOPPED pr=$pr reason=$reason mutations=0" <<<"$OUT" || fail "órfão: esperado $reason: $OUT"
  [[ ! -s "$FAKE_STATE/mutations" ]] || fail "órfão $reason alterou estado: $(cat "$FAKE_STATE/mutations")"
}
orphan_reset; run --orphan-volume=gesto_pgdata_pr_43 "--closed-prs=$TMP/closed.tsv"
[[ "$RC" -eq 0 ]] && grep -q 'LEGACY_PREVIEW_RESULT=SIMULATED pr=43 mode=orphan_volume mutations=0' <<<"$OUT" || fail "simulação órfão: $OUT"
grep -q 'LEGACY_PREVIEW_PLAN object=orphan_volume name=gesto_pgdata_pr_43 containers=0' <<<"$OUT" || fail 'plano órfão'
[[ ! -s "$FAKE_STATE/mutations" ]] || fail 'simulação órfão alterou estado'
compgen -G "$LEGACY_CLEANUP_LOG_DIR/*-orphan-volume-pr-43.log" >/dev/null || fail 'log órfão ausente'
run --orphan-volume=gesto_pgdata_pr_43 "--closed-prs=$TMP/closed.tsv" --apply
[[ "$RC" -eq 0 ]] && grep -q 'LEGACY_PREVIEW_RESULT=APPLIED pr=43 mode=orphan_volume mutations=1' <<<"$OUT" || fail "apply órfão: $OUT"
[[ "$(cat "$FAKE_STATE/mutations")" == 'volume rm gesto_pgdata_pr_43' ]] || fail "remoções órfão: $(cat "$FAKE_STATE/mutations")"
orphan_reset; run --orphan-volume=gest-o_pgdata_pr_44 "--closed-prs=$TMP/closed.tsv" --apply
[[ "$RC" -eq 0 && "$(cat "$FAKE_STATE/mutations")" == 'volume rm gest-o_pgdata_pr_44' ]] || fail "órfão com nome antigo: $OUT"
orphan_reset; orphan_stop volume_in_use 42 --orphan-volume=gesto_pgdata_pr_42 "--closed-prs=$TMP/closed.tsv" --apply
orphan_reset; orphan_stop pr_not_closed 420 --orphan-volume=gesto_pgdata_pr_420 "--closed-prs=$TMP/closed.tsv" --apply
orphan_reset; orphan_stop volume_not_found 45 --orphan-volume=gesto_pgdata_pr_45 "--closed-prs=$TMP/closed.tsv" --apply
orphan_reset; printf '43\tCLOSED\n' >"$TMP/closed.tsv"; export FAKE_GH=OPEN
orphan_stop pr_state_sources_disagree 43 --orphan-volume=gesto_pgdata_pr_43 "--closed-prs=$TMP/closed.tsv" --apply; unset FAKE_GH
orphan_reset
for args in "--orphan-volume=gest-o_pgdata --closed-prs=$TMP/closed.tsv --apply" "--orphan-volume=gest-o_pgdata_clean_v2_fict --closed-prs=$TMP/closed.tsv" \
  "--orphan-volume=gesto_pgdata_pr_0 --closed-prs=$TMP/closed.tsv" "--orphan-volume=outro_pgdata_pr_43 --closed-prs=$TMP/closed.tsv" \
  "--orphan-volume=gesto_pgdata_pr_43x --closed-prs=$TMP/closed.tsv" "--orphan-volume=gesto_pgdata_pr_43" \
  "--orphan-volume=gesto_pgdata_pr_43 --closed-prs=$TMP/closed.tsv --pr=43" "--orphan-volume=gesto_pgdata_pr_43 --closed-prs=$TMP/closed.tsv --apply --force"; do
  # shellcheck disable=SC2086
  run $args; [[ "$RC" -eq 2 ]] || fail "uso inválido aceito no modo órfão: $args"
done
[[ ! -s "$FAKE_STATE/calls" && ! -s "$FAKE_STATE/mutations" ]] || fail 'uso inválido no modo órfão chamou docker'

# --- Usage errors: exit 2, nothing runs. ---
reset
for args in "--pr=42" "--pr=abc --closed-prs=$TMP/closed.tsv" "--pr=42 --closed-prs=$TMP/closed.tsv --apply" "--pr=42 --closed-prs=$TMP/closed.tsv --force"; do
  # shellcheck disable=SC2086
  run $args; [[ "$RC" -eq 2 ]] || fail "uso inválido aceito: $args"
done
[[ ! -s "$FAKE_STATE/calls" ]] || fail 'uso inválido chamou docker'

# --- Windows-generated list (BOM + CRLF) is accepted. ---
reset; printf '\xef\xbb\xbf42\tMERGED\r\n420\tOPEN\r\n' >"$TMP/closed.tsv"; run --pr=42 "--closed-prs=$TMP/closed.tsv"
[[ "$RC" -eq 0 ]] && grep -q 'PR_STATE=MERGED' <<<"$OUT" || fail "lista do Windows: $OUT"
reset; export FAKE_GH=CLOSED; run --pr=42 "--closed-prs=$TMP/closed.tsv"; unset FAKE_GH
grep -q 'PR_STATE=CLOSED source=file+gh' <<<"$OUT" || fail "gh concordante: $OUT"

# --- Static: no compose down, prune, force or shared-site removal. ---
body=$(awk '/^legacy_pr_main\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SCRIPT")
if grep -nE 'docker compose|compose down|prune|docker [a-z ]*rm[^|]* -f|rm -rf|rm -fr|--force|crm-preview"' <<<"$body"; then fail 'comando proibido no modo por PR'; fi
grep -q 'rm -r --one-file-system -- "\$pdir"' <<<"$body" || fail 'remoção da pasta mudou'
orphan_body=$(awk '/^legacy_orphan_volume_main\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SCRIPT")
if grep -nE 'docker compose|prune| -f\b|--force|\brm\b -|docker (container|image|network) rm' <<<"$orphan_body"; then fail 'comando proibido no modo órfão'; fi
[[ "$(grep -c 'docker volume rm "\$volume"' <<<"$orphan_body")" -eq 1 ]] || fail 'modo órfão remove mais que o volume'
printf 'LEGACY_PREVIEW_CLEANUP_SAFETY=PASS\n'
