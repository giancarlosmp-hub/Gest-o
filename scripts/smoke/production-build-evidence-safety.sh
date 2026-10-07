#!/usr/bin/env bash
# Build evidence contract: protected record written by phase=build and the image
# checks the cutover runs before trusting it.  Fake Docker, no engine access.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP:?}"' EXIT
BIN="$TMP/bin"; STATE="$TMP/state"; mkdir -p "$BIN" "$STATE"
PRODUCTION_BUILD_EVIDENCE_EXPECTED_OWNER="$(id -un):$(id -gn)"; export PRODUCTION_BUILD_EVIDENCE_EXPECTED_OWNER
export COMMAND_LOG="$TMP/commands" FAKE_STATE="$STATE"
# shellcheck source=scripts/lib/production-build-evidence.sh
source "$ROOT/scripts/lib/production-build-evidence.sh"

SHA=$(printf 'c%.0s' {1..40}); OTHER=$(printf 'd%.0s' {1..40})
API_ID=sha256:$(printf 'a%.0s' {1..64}); WEB_ID=sha256:$(printf 'b%.0s' {1..64})
BUILT_AT=2026-10-07T01:02:03Z
EV="$TMP/deploy-builds"

# images: id <TAB> inspect-id <TAB> revision <TAB> created <TAB> build-info json ('-' = unreadable)
cat >"$BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
row(){ awk -F'\t' -v r="$1" '$1==r{print; exit}' "$FAKE_STATE/images"; }
case "$1 $2" in
 'image inspect')
  r=$(row "${!#}"); [[ -n "$r" ]] || exit 1
  IFS=$'\t' read -r _ id rev created _ <<<"$r"
  case "$4" in
   *revision*) printf '%s\n' "$rev";;
   *created*) printf '%s\n' "$created";;
   *.Id*) printf '%s\n' "$id";;
  esac;;
 'run --rm')
  [[ "$*" == *'--network none --pull never --entrypoint cat '* ]] || exit 97
  id=${*: -2:1}
  r=$(row "$id"); [[ -n "$r" ]] || exit 125
  json=$(cut -f5 <<<"$r"); [[ "$json" != - ]] || exit 1
  printf '%s\n' "$json";;
 *) exit 99;;
esac
EOF
chmod +x "$BIN/docker"
export PATH="$BIN:$PATH"

reset_images(){
  printf '%s\t%s\t%s\t%s\t{"commit":"%s","builtAt":"%s"}\n' "$API_ID" "$API_ID" "$SHA" "$BUILT_AT" "$SHA" "$BUILT_AT" >"$STATE/images"
  printf '%s\t%s\t%s\t%s\t{"version":"1.0.0","commit":"%s","builtAt":"%s"}\n' "$WEB_ID" "$WEB_ID" "$SHA" "$BUILT_AT" "$SHA" "$BUILT_AT" >>"$STATE/images"
}
fresh(){ rm -rf "${EV:?}"; build_evidence_write "$EV" "$SHA" "$BUILT_AT" 1.0.0 "$API_ID" "$WEB_ID" "$SHA" "$SHA"; }
expect_load_error(){
  local expected=$1
  if build_evidence_load "$EV" "$SHA"; then printf 'load aceitou evidência inválida (%s)\n' "$expected" >&2; exit 1; fi
  [[ "$BUILD_EVIDENCE_ERROR" == "$expected" ]] || { printf 'esperado %s, obtido %s\n' "$expected" "$BUILD_EVIDENCE_ERROR" >&2; exit 1; }
}
expect_write_error(){
  local expected=$1; shift
  rm -rf "${EV:?}"
  if build_evidence_write "$EV" "$@"; then printf 'write aceitou valor inválido (%s)\n' "$expected" >&2; exit 1; fi
  [[ "$BUILD_EVIDENCE_ERROR" == "$expected" ]] || { printf 'esperado %s, obtido %s\n' "$expected" "$BUILD_EVIDENCE_ERROR" >&2; exit 1; }
  [[ ! -e "$EV/$SHA/build.tsv" ]]
}
set_field(){ awk -F'\t' -v k="$1" -v v="$2" 'BEGIN{OFS="\t"} $1==k{$2=v} {print}' "$EV/$SHA/build.tsv" >"$TMP/edit"; cat "$TMP/edit" >"$EV/$SHA/build.tsv"; }

# A. Round trip: protected layout and every output populated.
fresh
[[ "$(stat -c '%a' "$EV")" == 700 && "$(stat -c '%a' "$EV/$SHA")" == 700 && "$(stat -c '%h:%a' "$EV/$SHA/build.tsv")" == 1:600 ]]
[[ "$BUILD_EVIDENCE_COMMIT" == "$SHA" && "$BUILD_EVIDENCE_BUILT_AT" == "$BUILT_AT" && "$BUILD_EVIDENCE_APP_VERSION" == 1.0.0 ]]
[[ "$BUILD_EVIDENCE_API_IMAGE_ID" == "$API_ID" && "$BUILD_EVIDENCE_WEB_IMAGE_ID" == "$WEB_ID" ]]
[[ "$BUILD_EVIDENCE_API_RELEASE_TAG" == "gest-o-api-release:sha256-${API_ID#sha256:}" ]]
[[ "$BUILD_EVIDENCE_WEB_RELEASE_TAG" == "gest-o-web-release:sha256-${WEB_ID#sha256:}" ]]
compgen -G "$EV/$SHA/.build.tsv.*" >/dev/null && { echo 'arquivo temporário restou' >&2; exit 1; }
# A2. Rewriting for the same SHA (a second build before cutover) replaces atomically.
NEW_API=sha256:$(printf 'e%.0s' {1..64})
build_evidence_write "$EV" "$SHA" "$BUILT_AT" 1.0.0 "$NEW_API" "$WEB_ID" "$SHA" "$SHA"
[[ "$BUILD_EVIDENCE_API_IMAGE_ID" == "$NEW_API" ]]

# B. Write refuses invalid input before touching the record.
expect_write_error commit_format short "$BUILT_AT" 1.0.0 "$API_ID" "$WEB_ID" "$SHA" "$SHA"
expect_write_error built_at_format "$SHA" '2026-10-07 01:02:03' 1.0.0 "$API_ID" "$WEB_ID" "$SHA" "$SHA"
expect_write_error app_version_format "$SHA" "$BUILT_AT" 'bad version' "$API_ID" "$WEB_ID" "$SHA" "$SHA"
expect_write_error image_id_format "$SHA" "$BUILT_AT" 1.0.0 gest-o-api:latest "$WEB_ID" "$SHA" "$SHA"
expect_write_error revision_mismatch "$SHA" "$BUILT_AT" 1.0.0 "$API_ID" "$WEB_ID" "$OTHER" "$SHA"
rm -rf "${EV:?}"; mkdir -p "$TMP/elsewhere"; ln -s "$TMP/elsewhere" "$EV"
if build_evidence_write "$EV" "$SHA" "$BUILT_AT" 1.0.0 "$API_ID" "$WEB_ID" "$SHA" "$SHA"; then exit 1; fi
[[ "$BUILD_EVIDENCE_ERROR" == root_unprotected && -z "$(ls -A "$TMP/elsewhere")" ]]; rm -f "$EV"

# C. Load fails closed on every tampering.
rm -rf "${EV:?}"; expect_load_error missing
fresh; cp "$EV/$SHA/build.tsv" "$TMP/target"; rm "$EV/$SHA/build.tsv"; ln -s "$TMP/target" "$EV/$SHA/build.tsv"; expect_load_error symlink
fresh; mv "$EV/$SHA" "$TMP/real-dir"; ln -s "$TMP/real-dir" "$EV/$SHA"; expect_load_error symlink
fresh; chmod 644 "$EV/$SHA/build.tsv"; expect_load_error file_unprotected
fresh; chmod 755 "$EV/$SHA"; expect_load_error dir_unprotected
fresh; ln "$EV/$SHA/build.tsv" "$TMP/hardlink"; expect_load_error file_unprotected; rm -f "$TMP/hardlink"
fresh; PRODUCTION_BUILD_EVIDENCE_EXPECTED_OWNER="nobody-$$:nogroup-$$" expect_load_error dir_unprotected
fresh; printf 'commit\t%s\n' "$SHA" >>"$EV/$SHA/build.tsv"; expect_load_error duplicate_key
fresh; printf 'extra\tx\n' >>"$EV/$SHA/build.tsv"; expect_load_error unknown_key
fresh; grep -v '^recorded_at' "$EV/$SHA/build.tsv" >"$TMP/edit"; cat "$TMP/edit" >"$EV/$SHA/build.tsv"; expect_load_error missing_key
fresh; printf 'note\ta\tb\n' >>"$EV/$SHA/build.tsv"; expect_load_error malformed_line
fresh; set_field format 2; expect_load_error format
fresh; set_field commit "$OTHER"; expect_load_error commit_mismatch
fresh; set_field built_at yesterday; expect_load_error built_at_format
fresh; set_field web_revision "$OTHER"; expect_load_error revision_mismatch
fresh; set_field api_image_id "$NEW_API"; expect_load_error release_tag_mismatch
fresh; set_field web_release_tag "gest-o-web:$SHA"; expect_load_error release_tag_mismatch
if build_evidence_load "$EV" not-a-sha; then exit 1; fi; [[ "$BUILD_EVIDENCE_ERROR" == commit_format ]]

# D. Image validation: identity, labels and build-info, never pulling.
expect_image_error(){
  local expected=$1 role=$2 id=$3
  if build_image_validate "$role" "$id" "$SHA" "$BUILT_AT"; then printf 'imagem inválida aceita (%s)\n' "$expected" >&2; exit 1; fi
  [[ "$BUILD_EVIDENCE_ERROR" == "$expected" ]] || { printf 'esperado %s, obtido %s\n' "$expected" "$BUILD_EVIDENCE_ERROR" >&2; exit 1; }
}
edit_image(){ awk -F'\t' -v id="$1" -v col="$2" -v v="$3" 'BEGIN{OFS="\t"} $1==id{$col=v} {print}' "$STATE/images" >"$TMP/img"; cat "$TMP/img" >"$STATE/images"; }
reset_images; : >"$COMMAND_LOG"
build_image_validate api "$API_ID" "$SHA" "$BUILT_AT"
build_image_validate web "$WEB_ID" "$SHA" "$BUILT_AT"
grep -q -- "--entrypoint cat $API_ID /app/apps/api/dist/build-info.json" "$COMMAND_LOG"
grep -q -- "--entrypoint cat $WEB_ID /usr/share/nginx/html/build-info.json" "$COMMAND_LOG"
grep -Eq 'docker (pull|build)|--pull (always|missing)' "$COMMAND_LOG" && exit 1
expect_image_error api_image_id_format api gest-o-api:latest
expect_image_error api_image_absent api "$NEW_API"
reset_images; edit_image "$API_ID" 2 "$NEW_API"; expect_image_error api_image_id_mismatch api "$API_ID"
reset_images; edit_image "$WEB_ID" 3 "$OTHER"; expect_image_error web_revision_mismatch web "$WEB_ID"
reset_images; edit_image "$WEB_ID" 3 '<no value>'; expect_image_error web_revision_mismatch web "$WEB_ID"
reset_images; edit_image "$API_ID" 4 2026-10-07T09:09:09Z; expect_image_error api_created_mismatch api "$API_ID"
reset_images; edit_image "$API_ID" 5 -; expect_image_error api_build_info_unreadable api "$API_ID"
reset_images; edit_image "$API_ID" 5 "{\"commit\":\"$OTHER\",\"builtAt\":\"$BUILT_AT\"}"; expect_image_error api_build_info_mismatch api "$API_ID"
reset_images; edit_image "$WEB_ID" 5 "{\"commit\":\"$SHA\",\"builtAt\":\"2026-01-01T00:00:00Z\"}"; expect_image_error web_build_info_mismatch web "$WEB_ID"
reset_images; edit_image "$WEB_ID" 5 'not json'; expect_image_error web_build_info_mismatch web "$WEB_ID"
expect_image_error role db "$API_ID"

# E. Failures inside `if` (where set -e is inert) still stop at the failed step.
reset_images; edit_image "$API_ID" 3 "$OTHER"; : >"$COMMAND_LOG"
if build_image_validate api "$API_ID" "$SHA" "$BUILT_AT"; then exit 1; fi
grep -q 'docker run' "$COMMAND_LOG" && { echo 'validação continuou após falha de rótulo' >&2; exit 1; }
if grep -Eq '^\s*set -[a-z]*e' "$ROOT/scripts/lib/production-build-evidence.sh"; then echo 'lib não pode depender de set -e' >&2; exit 1; fi

printf 'production build evidence safety passed\n'
