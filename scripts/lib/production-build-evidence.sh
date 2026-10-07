#!/usr/bin/env bash
# shellcheck disable=SC2034 # BUILD_EVIDENCE_* and BUILD_EVIDENCE_ERROR are outputs read by the sourcing script
# Build evidence for production deploys.
#
# phase=build records exactly which local images it produced for a commit; the
# cutover consumes that record instead of rebuilding, so the images that were
# built (and checked) are the images that start.  The record is a protected
# key/value TSV: <root>/<commit>/build.tsv (directories 700, file 600, single
# link, expected owner, never a symlink).
#
# Every function returns non-zero on the first failed step.  Callers use them in
# `if`/`||` contexts, where `set -e` does not apply, so no step may rely on it.

BUILD_EVIDENCE_FORMAT=1
BUILD_EVIDENCE_KEYS="format commit built_at app_version api_image_id web_image_id api_revision web_revision api_release_tag web_release_tag recorded_at"

build_evidence_owner() { printf '%s' "${PRODUCTION_BUILD_EVIDENCE_EXPECTED_OWNER:-root:root}"; }

build_evidence_release_tag() { printf 'gest-o-%s-release:sha256-%s' "$1" "${2#sha256:}"; }

build_evidence_protected_dir() {
  [[ -d "$1" && ! -L "$1" && "$(stat -c '%U:%G:%a' -- "$1" 2>/dev/null)" == "$(build_evidence_owner):700" ]]
}

build_evidence_protected_file() {
  [[ -f "$1" && ! -L "$1" && -s "$1" && "$(stat -c '%h:%U:%G:%a' -- "$1" 2>/dev/null)" == "1:$(build_evidence_owner):600" ]]
}

# build_evidence_prepare_dir <dir>: creates (or re-protects) a 700 directory
# owned by the expected owner, refusing symlinks at the path itself.
build_evidence_prepare_dir() {
  local dir=$1 owner group
  owner=$(build_evidence_owner); group=${owner#*:}; owner=${owner%%:*}
  [[ ! -L "$dir" ]] || return 1
  install -d -o "$owner" -g "$group" -m 700 -- "$dir" || return 1
  build_evidence_protected_dir "$dir"
}

# build_evidence_write <root> <commit> <built_at> <app_version> <api_id> <web_id> <api_revision> <web_revision>
build_evidence_write() {
  local root=$1 commit=$2 built_at=$3 app_version=$4 api_id=$5 web_id=$6 api_revision=$7 web_revision=$8
  local dir file tmp owner group
  BUILD_EVIDENCE_ERROR=
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { BUILD_EVIDENCE_ERROR=commit_format; return 1; }
  build_evidence_value_ok "$built_at" "$app_version" "$api_id" "$web_id" || return 1
  [[ "$api_revision" == "$commit" && "$web_revision" == "$commit" ]] || { BUILD_EVIDENCE_ERROR=revision_mismatch; return 1; }
  dir="$root/$commit"; file="$dir/build.tsv"
  build_evidence_prepare_dir "$root" || { BUILD_EVIDENCE_ERROR=root_unprotected; return 1; }
  build_evidence_prepare_dir "$dir" || { BUILD_EVIDENCE_ERROR=dir_unprotected; return 1; }
  [[ ! -L "$file" ]] || { BUILD_EVIDENCE_ERROR=symlink; return 1; }
  [[ ! -e "$file" || -f "$file" ]] || { BUILD_EVIDENCE_ERROR=not_regular_file; return 1; }
  tmp=$(mktemp "$dir/.build.tsv.XXXXXX") || { BUILD_EVIDENCE_ERROR=tmp_create; return 1; }
  if ! {
    printf 'format\t%s\n' "$BUILD_EVIDENCE_FORMAT"
    printf 'commit\t%s\n' "$commit"
    printf 'built_at\t%s\n' "$built_at"
    printf 'app_version\t%s\n' "$app_version"
    printf 'api_image_id\t%s\n' "$api_id"
    printf 'web_image_id\t%s\n' "$web_id"
    printf 'api_revision\t%s\n' "$api_revision"
    printf 'web_revision\t%s\n' "$web_revision"
    printf 'api_release_tag\t%s\n' "$(build_evidence_release_tag api "$api_id")"
    printf 'web_release_tag\t%s\n' "$(build_evidence_release_tag web "$web_id")"
    printf 'recorded_at\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$tmp"; then rm -f -- "$tmp"; BUILD_EVIDENCE_ERROR=tmp_write; return 1; fi
  owner=$(build_evidence_owner); group=${owner#*:}; owner=${owner%%:*}
  if ! { chown "$owner:$group" -- "$tmp" && chmod 600 -- "$tmp"; }; then rm -f -- "$tmp"; BUILD_EVIDENCE_ERROR=tmp_protect; return 1; fi
  mv -f -- "$tmp" "$file" || { rm -f -- "$tmp"; BUILD_EVIDENCE_ERROR=publish; return 1; }
  build_evidence_load "$root" "$commit"
}

build_evidence_value_ok() {
  local built_at=$1 app_version=$2 api_id=$3 web_id=$4
  [[ "$built_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { BUILD_EVIDENCE_ERROR=built_at_format; return 1; }
  [[ "$app_version" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$ ]] || { BUILD_EVIDENCE_ERROR=app_version_format; return 1; }
  [[ "$api_id" =~ ^sha256:[0-9a-f]{64}$ && "$web_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { BUILD_EVIDENCE_ERROR=image_id_format; return 1; }
}

# build_evidence_load <root> <expected_commit>
# Sets BUILD_EVIDENCE_{FILE,COMMIT,BUILT_AT,APP_VERSION,API_IMAGE_ID,WEB_IMAGE_ID,API_RELEASE_TAG,WEB_RELEASE_TAG}
# or BUILD_EVIDENCE_ERROR.
build_evidence_load() {
  local root=$1 expected=$2 file key value line count
  local -A seen=()
  BUILD_EVIDENCE_ERROR='' BUILD_EVIDENCE_FILE='' BUILD_EVIDENCE_COMMIT='' BUILD_EVIDENCE_BUILT_AT='' BUILD_EVIDENCE_APP_VERSION=''
  BUILD_EVIDENCE_API_IMAGE_ID='' BUILD_EVIDENCE_WEB_IMAGE_ID='' BUILD_EVIDENCE_API_RELEASE_TAG='' BUILD_EVIDENCE_WEB_RELEASE_TAG=''
  [[ "$expected" =~ ^[0-9a-f]{40}$ ]] || { BUILD_EVIDENCE_ERROR=commit_format; return 1; }
  file="$root/$expected/build.tsv"
  [[ -e "$file" || -L "$file" ]] || { BUILD_EVIDENCE_ERROR=missing; return 1; }
  [[ ! -L "$file" && ! -L "$root/$expected" && ! -L "$root" ]] || { BUILD_EVIDENCE_ERROR=symlink; return 1; }
  if ! { build_evidence_protected_dir "$root" && build_evidence_protected_dir "$root/$expected"; }; then BUILD_EVIDENCE_ERROR=dir_unprotected; return 1; fi
  build_evidence_protected_file "$file" || { BUILD_EVIDENCE_ERROR=file_unprotected; return 1; }
  count=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *$'\t'* && "${line#*$'\t'}" != *$'\t'* ]] || { BUILD_EVIDENCE_ERROR=malformed_line; return 1; }
    key=${line%%$'\t'*}; value=${line#*$'\t'}
    [[ " $BUILD_EVIDENCE_KEYS " == *" $key "* ]] || { BUILD_EVIDENCE_ERROR=unknown_key; return 1; }
    [[ -z "${seen[$key]+x}" ]] || { BUILD_EVIDENCE_ERROR=duplicate_key; return 1; }
    seen[$key]=$value; count=$((count + 1))
  done <"$file"
  [[ "$count" -eq "$(wc -w <<<"$BUILD_EVIDENCE_KEYS")" ]] || { BUILD_EVIDENCE_ERROR=missing_key; return 1; }
  [[ "${seen[format]}" == "$BUILD_EVIDENCE_FORMAT" ]] || { BUILD_EVIDENCE_ERROR=format; return 1; }
  [[ "${seen[commit]}" == "$expected" ]] || { BUILD_EVIDENCE_ERROR=commit_mismatch; return 1; }
  build_evidence_value_ok "${seen[built_at]}" "${seen[app_version]}" "${seen[api_image_id]}" "${seen[web_image_id]}" || return 1
  [[ "${seen[api_revision]}" == "$expected" && "${seen[web_revision]}" == "$expected" ]] || { BUILD_EVIDENCE_ERROR=revision_mismatch; return 1; }
  [[ "${seen[api_release_tag]}" == "$(build_evidence_release_tag api "${seen[api_image_id]}")" &&
     "${seen[web_release_tag]}" == "$(build_evidence_release_tag web "${seen[web_image_id]}")" ]] || { BUILD_EVIDENCE_ERROR=release_tag_mismatch; return 1; }
  BUILD_EVIDENCE_FILE=$file
  BUILD_EVIDENCE_COMMIT=${seen[commit]}
  BUILD_EVIDENCE_BUILT_AT=${seen[built_at]}
  BUILD_EVIDENCE_APP_VERSION=${seen[app_version]}
  BUILD_EVIDENCE_API_IMAGE_ID=${seen[api_image_id]}
  BUILD_EVIDENCE_WEB_IMAGE_ID=${seen[web_image_id]}
  BUILD_EVIDENCE_API_RELEASE_TAG=${seen[api_release_tag]}
  BUILD_EVIDENCE_WEB_RELEASE_TAG=${seen[web_release_tag]}
}

# build_image_label <image> <label>: prints the OCI label, empty when absent.
build_image_label() {
  local value
  value=$(docker image inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null) || return 1
  [[ "$value" != '<no value>' ]] || value=""
  printf '%s' "$value"
}

# build_image_validate <role> <image_id> <commit> <built_at>
# The image must exist under exactly this ID, carry the commit/build-time labels
# and contain a build-info.json written by the same build.  Never pulls.
build_image_validate() {
  local role=$1 id=$2 commit=$3 built_at=$4 actual revision created info path
  BUILD_EVIDENCE_ERROR=
  case "$role" in
    api) path=/app/apps/api/dist/build-info.json ;;
    web) path=/usr/share/nginx/html/build-info.json ;;
    *) BUILD_EVIDENCE_ERROR=role; return 1 ;;
  esac
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || { BUILD_EVIDENCE_ERROR="${role}_image_id_format"; return 1; }
  actual=$(docker image inspect -f '{{.Id}}' "$id" 2>/dev/null) || { BUILD_EVIDENCE_ERROR="${role}_image_absent"; return 1; }
  [[ "$actual" == "$id" ]] || { BUILD_EVIDENCE_ERROR="${role}_image_id_mismatch"; return 1; }
  revision=$(build_image_label "$id" org.opencontainers.image.revision) || { BUILD_EVIDENCE_ERROR="${role}_label_unreadable"; return 1; }
  [[ "$revision" == "$commit" ]] || { BUILD_EVIDENCE_ERROR="${role}_revision_mismatch"; return 1; }
  created=$(build_image_label "$id" org.opencontainers.image.created) || { BUILD_EVIDENCE_ERROR="${role}_label_unreadable"; return 1; }
  [[ "$created" == "$built_at" ]] || { BUILD_EVIDENCE_ERROR="${role}_created_mismatch"; return 1; }
  info=$(docker run --rm --network none --pull never --entrypoint cat "$id" "$path" 2>/dev/null) || { BUILD_EVIDENCE_ERROR="${role}_build_info_unreadable"; return 1; }
  BUILD_INFO_JSON=$info BUILD_INFO_COMMIT=$commit BUILD_INFO_BUILT_AT=$built_at node -e '
    let b; try { b = JSON.parse(process.env.BUILD_INFO_JSON); } catch { process.exit(1); }
    process.exit(b && b.commit === process.env.BUILD_INFO_COMMIT && b.builtAt === process.env.BUILD_INFO_BUILT_AT ? 0 : 1);
  ' || { BUILD_EVIDENCE_ERROR="${role}_build_info_mismatch"; return 1; }
}
