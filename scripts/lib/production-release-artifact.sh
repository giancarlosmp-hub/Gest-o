#!/usr/bin/env bash
# shellcheck disable=SC2034 # RELEASE_* variables are outputs read by the sourcing script
# Persistent release artifacts for production rollback.
#
# Each released image gets an immutable name, gest-o-<role>-release:sha256-<hex>,
# so that moving a build tag can never leave a running image without a name
# (containerd image store makes such images uninspectable), and a verified
# `docker save | gzip -1` copy:
#
#   <root>/<commit>/<role>.<hex>.tar.gz        artifact (600)
#   <root>/<commit>/<role>.<hex>.release.tsv   record (600), written last
#
# With the containerd image store the image ID is the digest of the top-level
# OCI index, so a tar is accepted only when its index.json has exactly one
# descriptor with that digest (and the release tag as ref name) and the blob
# for it hashes to the ID.  A restored image is accepted only when the engine
# reports the recorded ID again; the rollback predicate still decides.
#
# Every function returns non-zero on the first failed step and is meant to be
# called from `if`/`||` contexts, where `set -e` does not apply.  Retention only
# reports in this version: nothing here deletes files, tags or images.

release_artifact_root() { printf '%s' "${RELEASE_ARTIFACT_ROOT:-/var/log/gest-o/oci-backups}"; }
release_artifact_owner() { printf '%s' "${RELEASE_ARTIFACT_EXPECTED_OWNER:-root:root}"; }
release_log() { printf '[release-artifact] %s\n' "$*"; }
release_tag_for() { printf 'gest-o-%s-release:sha256-%s' "$1" "${2#sha256:}"; }
release_role_ok() { [[ "$1" == api || "$1" == web ]]; }
release_id_ok() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }
release_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

release_label() {
  local value
  value=$(docker image inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null) || return 1
  [[ "$value" != '<no value>' ]] || value=""
  printf '%s' "$value" | tr -d '\t\r\n'
}

# A directory is safe when it is a real directory owned by the expected owner
# and not writable by group or others.  Existing directories are never
# re-permissioned; missing ones are created 700.
release_dir_safe() {
  local mode
  [[ -d "$1" && ! -L "$1" ]] || return 1
  [[ "$(stat -c '%U:%G' -- "$1" 2>/dev/null)" == "$(release_artifact_owner)" ]] || return 1
  mode=$(stat -c '%a' -- "$1" 2>/dev/null) || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 8#022) == 0 ))
}

release_prepare_dir() {
  local owner group
  [[ ! -L "$1" ]] || return 1
  if [[ ! -e "$1" ]]; then
    owner=$(release_artifact_owner); group=${owner#*:}; owner=${owner%%:*}
    install -d -o "$owner" -g "$group" -m 700 -- "$1" || return 1
  fi
  release_dir_safe "$1"
}

release_file_safe() {
  [[ -f "$1" && ! -L "$1" && -s "$1" && "$(stat -c '%h:%U:%G:%a' -- "$1" 2>/dev/null)" == "1:$(release_artifact_owner):600" ]]
}

release_protect_file() {
  local owner group
  owner=$(release_artifact_owner); group=${owner#*:}; owner=${owner%%:*}
  chown "$owner:$group" -- "$1" || return 1
  chmod 600 -- "$1"
}

# release_pin <role> <image_id>: gives the image its immutable release name.
# An existing release tag is accepted only when it already names this exact ID.
release_pin() {
  local role=$1 id=$2 tag current
  RELEASE_ERROR=''
  release_role_ok "$role" || { RELEASE_ERROR=role; return 1; }
  release_id_ok "$id" || { RELEASE_ERROR=image_id_format; return 1; }
  tag=$(release_tag_for "$role" "$id")
  if current=$(docker image inspect -f '{{.Id}}' "$tag" 2>/dev/null); then
    if [[ "$current" != "$id" ]]; then
      RELEASE_ERROR=release_tag_conflict
      release_log "ERRO: $tag já aponta para $current, não para $id"
      return 1
    fi
    printf 'RELEASE_PIN role=%s id=%s tag=%s state=existing\n' "$role" "$id" "$tag"
    return 0
  fi
  current=$(docker image inspect -f '{{.Id}}' "$id" 2>/dev/null) || { RELEASE_ERROR=image_absent; return 1; }
  [[ "$current" == "$id" ]] || { RELEASE_ERROR=image_id_mismatch; return 1; }
  docker tag "$id" "$tag" || { RELEASE_ERROR=tag_failed; return 1; }
  current=$(docker image inspect -f '{{.Id}}' "$tag" 2>/dev/null) || { RELEASE_ERROR=release_tag_readback; return 1; }
  [[ "$current" == "$id" ]] || { RELEASE_ERROR=release_tag_readback; return 1; }
  printf 'RELEASE_PIN role=%s id=%s tag=%s state=created\n' "$role" "$id" "$tag"
}

# release_disk_check <dir> <image_id>: free space must cover the image size
# (which tracks the saved size with containerd) plus 10% and a fixed margin.
release_disk_check() {
  local dir=$1 id=$2 size avail_kb need min_free=${RELEASE_ARTIFACT_MIN_FREE_BYTES:-2147483648}
  RELEASE_ERROR=''
  [[ "$min_free" =~ ^[0-9]+$ ]] || { RELEASE_ERROR=min_free_format; return 1; }
  size=$(docker image inspect -f '{{.Size}}' "$id" 2>/dev/null) || { RELEASE_ERROR=image_size_unreadable; return 1; }
  [[ "$size" =~ ^[0-9]+$ ]] || { RELEASE_ERROR=image_size_unreadable; return 1; }
  avail_kb=$(df -Pk -- "$dir" 2>/dev/null | awk 'NR==2{print $4}') || { RELEASE_ERROR=disk_unreadable; return 1; }
  [[ "$avail_kb" =~ ^[0-9]+$ ]] || { RELEASE_ERROR=disk_unreadable; return 1; }
  need=$(( size + size / 10 + min_free ))
  if (( avail_kb * 1024 < need )); then
    RELEASE_ERROR=disk_insufficient
    release_log "ERRO: espaço insuficiente em $dir: livre=$((avail_kb * 1024)) necessário=$need"
    return 1
  fi
}

# release_verify_tar <tar.gz> <image_id> <release_tag>: offline proof that the
# archive holds exactly this image under its release name.
release_verify_tar() {
  local file=$1 id=$2 tag=$3 hex entries index top
  local -
  set -o pipefail
  RELEASE_ERROR=''
  hex=${id#sha256:}
  [[ -f "$file" && ! -L "$file" ]] || { RELEASE_ERROR=tar_missing; return 1; }
  gzip -t -- "$file" 2>/dev/null || { RELEASE_ERROR=gzip_corrupt; return 1; }
  entries=$(gzip -dc -- "$file" | tar -tf - 2>/dev/null) || { RELEASE_ERROR=tar_unreadable; return 1; }
  if ! { grep -Fxq index.json <<<"$entries" && grep -Fxq oci-layout <<<"$entries" && grep -Fxq "blobs/sha256/$hex" <<<"$entries"; }; then
    RELEASE_ERROR=oci_layout_incomplete; return 1
  fi
  index=$(gzip -dc -- "$file" | tar -xOf - index.json 2>/dev/null) || { RELEASE_ERROR=index_unreadable; return 1; }
  RELEASE_INDEX_JSON=$index RELEASE_EXPECTED_ID=$id RELEASE_EXPECTED_REF=${tag##*:} node -e '
    let index; try { index = JSON.parse(process.env.RELEASE_INDEX_JSON); } catch { process.exit(1); }
    const m = Array.isArray(index?.manifests) ? index.manifests : [];
    const d = m.length === 1 ? m[0] : null;
    const ok = d && d.digest === process.env.RELEASE_EXPECTED_ID &&
      /^application\/vnd\.oci\.image\.(index|manifest)\.v1\+json$/.test(d.mediaType || "") &&
      d.annotations?.["org.opencontainers.image.ref.name"] === process.env.RELEASE_EXPECTED_REF;
    process.exit(ok ? 0 : 1);
  ' || { RELEASE_ERROR=index_mismatch; return 1; }
  top=$(gzip -dc -- "$file" | tar -xOf - "blobs/sha256/$hex" 2>/dev/null | sha256sum | cut -d' ' -f1) || { RELEASE_ERROR=top_blob_unreadable; return 1; }
  [[ "$top" == "$hex" ]] || { RELEASE_ERROR=top_blob_digest; return 1; }
}

RELEASE_META_KEYS="format role image_id runtime_identity release_tag commit built_at tar tar_sha256 compression released_at"

# release_meta_load <record>: sets RELEASE_META_* from a protected record.
release_meta_load() {
  local meta=$1 line key value count hex
  local -A seen=()
  RELEASE_ERROR='' RELEASE_META_ROLE='' RELEASE_META_IMAGE_ID='' RELEASE_META_RUNTIME_IDENTITY='' RELEASE_META_RELEASE_TAG=''
  RELEASE_META_COMMIT='' RELEASE_META_BUILT_AT='' RELEASE_META_TAR='' RELEASE_META_TAR_SHA256='' RELEASE_META_RELEASED_AT=''
  release_file_safe "$meta" || { RELEASE_ERROR=meta_unprotected; return 1; }
  count=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *$'\t'* && "${line#*$'\t'}" != *$'\t'* ]] || { RELEASE_ERROR=meta_malformed; return 1; }
    key=${line%%$'\t'*}; value=${line#*$'\t'}
    [[ " $RELEASE_META_KEYS " == *" $key "* && -z "${seen[$key]+x}" ]] || { RELEASE_ERROR=meta_malformed; return 1; }
    seen[$key]=$value; count=$((count + 1))
  done <"$meta"
  [[ "$count" -eq "$(wc -w <<<"$RELEASE_META_KEYS")" && "${seen[format]}" == 1 ]] || { RELEASE_ERROR=meta_malformed; return 1; }
  if ! { release_role_ok "${seen[role]}" && release_id_ok "${seen[image_id]}" && release_id_ok "${seen[runtime_identity]}"; }; then RELEASE_ERROR=meta_invalid; return 1; fi
  hex=${seen[image_id]#sha256:}
  if ! [[ "${seen[release_tag]}" == "$(release_tag_for "${seen[role]}" "${seen[image_id]}")" &&
          "${seen[commit]}" =~ ^[0-9a-f]{40}$ &&
          "$(basename -- "$meta")" == "${seen[role]}.$hex.release.tsv" &&
          "${seen[tar]}" == "$(dirname -- "$meta")/${seen[role]}.$hex.tar.gz" &&
          "${seen[tar_sha256]}" =~ ^[0-9a-f]{64}$ &&
          "${seen[compression]}" == gzip-1 &&
          "${seen[released_at]}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    RELEASE_ERROR=meta_invalid; return 1
  fi
  RELEASE_META_ROLE=${seen[role]}
  RELEASE_META_IMAGE_ID=${seen[image_id]}
  RELEASE_META_RUNTIME_IDENTITY=${seen[runtime_identity]}
  RELEASE_META_RELEASE_TAG=${seen[release_tag]}
  RELEASE_META_COMMIT=${seen[commit]}
  RELEASE_META_BUILT_AT=${seen[built_at]}
  RELEASE_META_TAR=${seen[tar]}
  RELEASE_META_TAR_SHA256=${seen[tar_sha256]}
  RELEASE_META_RELEASED_AT=${seen[released_at]}
}

# release_save <role> <image_id> <commit> <built_at> <runtime_identity>
# Pins, checks disk, saves, verifies and publishes one artifact.
release_save() {
  local role=$1 id=$2 commit=$3 built_at=$4 identity=$5 root dir hex tag final meta tmp meta_tmp sha bytes
  local -
  set -o pipefail
  RELEASE_ERROR=''
  if ! { release_role_ok "$role" && release_id_ok "$id" && release_id_ok "$identity"; }; then RELEASE_ERROR=arguments; return 1; fi
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { RELEASE_ERROR=commit_format; return 1; }
  built_at=$(printf '%s' "$built_at" | tr -d '\t\r\n')
  root=$(release_artifact_root); dir="$root/$commit"; hex=${id#sha256:}
  release_prepare_dir "$root" || { RELEASE_ERROR=root_unprotected; return 1; }
  release_prepare_dir "$dir" || { RELEASE_ERROR=dir_unprotected; return 1; }
  release_pin "$role" "$id" || return 1
  tag=$(release_tag_for "$role" "$id")
  final="$dir/$role.$hex.tar.gz"; meta="$dir/$role.$hex.release.tsv"
  [[ ! -L "$final" && ! -L "$meta" ]] || { RELEASE_ERROR=symlink; return 1; }
  release_disk_check "$dir" "$id" || return 1
  tmp=$(mktemp "$dir/.$role.$hex.tar.gz.tmp.XXXXXX") || { RELEASE_ERROR=tmp_create; return 1; }
  if ! docker save "$tag" | gzip -1 >"$tmp"; then rm -f -- "$tmp"; RELEASE_ERROR=save_failed; return 1; fi
  release_protect_file "$tmp" || { rm -f -- "$tmp"; RELEASE_ERROR=tmp_protect; return 1; }
  release_verify_tar "$tmp" "$id" "$tag" || { rm -f -- "$tmp"; return 1; }
  sha=$(sha256sum -- "$tmp" | cut -d' ' -f1) || { rm -f -- "$tmp"; RELEASE_ERROR=digest_failed; return 1; }
  mv -f -- "$tmp" "$final" || { rm -f -- "$tmp"; RELEASE_ERROR=publish_tar; return 1; }
  meta_tmp=$(mktemp "$dir/.$role.$hex.release.tsv.tmp.XXXXXX") || { RELEASE_ERROR=tmp_create; return 1; }
  if ! {
    printf 'format\t1\n'
    printf 'role\t%s\n' "$role"
    printf 'image_id\t%s\n' "$id"
    printf 'runtime_identity\t%s\n' "$identity"
    printf 'release_tag\t%s\n' "$tag"
    printf 'commit\t%s\n' "$commit"
    printf 'built_at\t%s\n' "${built_at:-unknown}"
    printf 'tar\t%s\n' "$final"
    printf 'tar_sha256\t%s\n' "$sha"
    printf 'compression\tgzip-1\n'
    printf 'released_at\t%s\n' "$(release_now)"
  } >"$meta_tmp"; then rm -f -- "$meta_tmp"; RELEASE_ERROR=meta_write; return 1; fi
  release_protect_file "$meta_tmp" || { rm -f -- "$meta_tmp"; RELEASE_ERROR=meta_write; return 1; }
  mv -f -- "$meta_tmp" "$meta" || { rm -f -- "$meta_tmp"; RELEASE_ERROR=meta_write; return 1; }
  release_meta_load "$meta" || return 1
  [[ "$(sha256sum -- "$final" | cut -d' ' -f1)" == "$sha" ]] || { RELEASE_ERROR=tar_digest_mismatch; return 1; }
  bytes=$(stat -c '%s' -- "$final")
  RELEASE_ARTIFACT_TAR=$final RELEASE_ARTIFACT_SHA256=$sha RELEASE_ARTIFACT_META=$meta
  printf 'RELEASE_ARTIFACT role=%s id=%s commit=%s tar=%s tar_sha256=%s bytes=%s state=created\n' "$role" "$id" "$commit" "$final" "$sha" "$bytes"
}

# release_find_for_identity <role> <identity>: finds a published artifact whose
# image ID or recorded runtime identity is exactly <identity> and whose tar
# still matches its recorded digest.  Sets RELEASE_FOUND_*.
release_find_for_identity() {
  local role=$1 identity=$2 meta root
  RELEASE_ERROR=not_found RELEASE_FOUND_META='' RELEASE_FOUND_IMAGE_ID='' RELEASE_FOUND_TAG='' RELEASE_FOUND_TAR='' RELEASE_FOUND_TAR_SHA256='' RELEASE_FOUND_COMMIT=''
  if ! { release_role_ok "$role" && release_id_ok "$identity"; }; then RELEASE_ERROR=arguments; return 1; fi
  root=$(release_artifact_root)
  for meta in "$root"/*/"$role".*.release.tsv; do
    [[ -e "$meta" ]] || break
    if release_meta_load "$meta" && [[ "$RELEASE_META_IMAGE_ID" == "$identity" || "$RELEASE_META_RUNTIME_IDENTITY" == "$identity" ]]; then
      if [[ -f "$RELEASE_META_TAR" && ! -L "$RELEASE_META_TAR" ]] && [[ "$(sha256sum -- "$RELEASE_META_TAR" | cut -d' ' -f1)" == "$RELEASE_META_TAR_SHA256" ]]; then
        RELEASE_ERROR='' RELEASE_FOUND_META=$meta RELEASE_FOUND_IMAGE_ID=$RELEASE_META_IMAGE_ID RELEASE_FOUND_TAG=$RELEASE_META_RELEASE_TAG
        RELEASE_FOUND_TAR=$RELEASE_META_TAR RELEASE_FOUND_TAR_SHA256=$RELEASE_META_TAR_SHA256 RELEASE_FOUND_COMMIT=$RELEASE_META_COMMIT
        return 0
      fi
      RELEASE_ERROR=tar_digest_mismatch
    fi
  done
  return 1
}

# release_restore_tar <image_id> <release_tag> <tar> <tar_sha256>: the digest is
# checked before anything is loaded; the load must reproduce the exact ID.
release_restore_tar() {
  local id=$1 tag=$2 tar=$3 sha=$4 current
  local -
  set -o pipefail
  RELEASE_ERROR=''
  if ! { release_id_ok "$id" && [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; }; then RELEASE_ERROR=arguments; return 1; fi
  [[ -f "$tar" && ! -L "$tar" ]] || { RELEASE_ERROR=tar_missing; return 1; }
  [[ "$(sha256sum -- "$tar" | cut -d' ' -f1)" == "$sha" ]] || { RELEASE_ERROR=tar_digest_mismatch; return 1; }
  release_verify_tar "$tar" "$id" "$tag" || return 1
  if current=$(docker image inspect -f '{{.Id}}' "$id" 2>/dev/null) && [[ "$current" == "$id" ]]; then
    printf 'RELEASE_RESTORE id=%s tar=%s state=present\n' "$id" "$tar"
    return 0
  fi
  gzip -dc -- "$tar" | docker load >/dev/null || { RELEASE_ERROR=load_failed; return 1; }
  current=$(docker image inspect -f '{{.Id}}' "$id" 2>/dev/null) || { RELEASE_ERROR=load_id_mismatch; return 1; }
  [[ "$current" == "$id" ]] || { RELEASE_ERROR=load_id_mismatch; return 1; }
  current=$(docker image inspect -f '{{.Id}}' "$tag" 2>/dev/null) || { RELEASE_ERROR=load_tag_mismatch; return 1; }
  [[ "$current" == "$id" ]] || { RELEASE_ERROR=load_tag_mismatch; return 1; }
  printf 'RELEASE_RESTORE id=%s tar=%s state=loaded\n' "$id" "$tar"
}

# release_restore <role> <identity>: restores the artifact recorded for a
# runtime identity (used when the engine lost the image).
release_restore() {
  release_find_for_identity "$1" "$2" || return 1
  release_restore_tar "$RELEASE_FOUND_IMAGE_ID" "$RELEASE_FOUND_TAG" "$RELEASE_FOUND_TAR" "$RELEASE_FOUND_TAR_SHA256"
}

release_port_owner() {
  docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null | awk -F'|' -v p=":$1->" '$2~p{print $1}'
}

# ensure_runtime_release_artifact <build|cutover>
# Makes sure the runtime currently serving each role is pinned and has a
# verified artifact.  Requires resolve_rollback_image (production-rollback-image.sh).
# build: reports and always succeeds.  cutover: fails only when a role has
# neither an artifact nor an inspectable image (nothing could roll it back).
ensure_runtime_release_artifact() {
  local mode=$1 spec role port owners container_id identity config_image artifact_id commit built_at status reason unavailable=0
  for spec in api:4000 web:5173; do
    role=${spec%%:*}; port=${spec##*:}; status=''; reason=''; identity=''; commit=''
    owners=$(release_port_owner "$port")
    if [[ "$(printf '%s\n' "$owners" | sed '/^$/d' | wc -l)" -ne 1 ]]; then
      status=UNAVAILABLE; reason=port_owner
    elif ! container_id=$(docker inspect -f '{{.Id}}' "$owners" 2>/dev/null) ||
         ! identity=$(docker inspect -f '{{.Image}}' "$container_id" 2>/dev/null) ||
         ! config_image=$(docker inspect -f '{{.Config.Image}}' "$container_id" 2>/dev/null); then
      status=UNAVAILABLE; reason=container_inspect
    elif resolve_rollback_image "$role" "$identity" "$config_image"; then
      artifact_id=$ROLLBACK_ARTIFACT_ID
      if ! release_pin "$role" "$artifact_id"; then
        status=FAIL; reason=$RELEASE_ERROR
      elif release_find_for_identity "$role" "$identity"; then
        status=EXISTS; commit=$RELEASE_FOUND_COMMIT
      elif ! commit=$(release_label "$artifact_id" org.opencontainers.image.revision) || [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
        status=FAIL; reason=revision_label
      else
        built_at=$(release_label "$artifact_id" org.opencontainers.image.created) || built_at=unknown
        if release_save "$role" "$artifact_id" "$commit" "$built_at" "$identity"; then
          status=PASS
        else
          status=FAIL; reason=$RELEASE_ERROR
        fi
      fi
    elif release_find_for_identity "$role" "$identity"; then
      status=EXISTS; commit=$RELEASE_FOUND_COMMIT
    else
      status=UNAVAILABLE; reason=not_inspectable_without_artifact
    fi
    [[ "$status" != UNAVAILABLE ]] || unavailable=$((unavailable + 1))
    printf 'RELEASE_ARTIFACT_BOOTSTRAP=%s role=%s id=%s commit=%s%s\n' "$status" "$role" "${identity:-unknown}" "${commit:-unknown}" "${reason:+ reason=$reason}"
  done
  [[ "$mode" == build || "$unavailable" -eq 0 ]]
}

# Rollback set of the last successful cutover (the one that wrote index.local.html).
release_current_rollback_ids() {
  local root=${DEPLOY_EVIDENCE_DIR:-/var/log/gest-o/deploy} dir latest='' latest_ts=0 ts
  for dir in "$root"/*/; do
    [[ -f "$dir/index.local.html" ]] || continue
    ts=$(stat -c '%Y' -- "$dir/index.local.html" 2>/dev/null) || return 1
    if (( ts > latest_ts )); then latest_ts=$ts; latest=$dir; fi
  done
  [[ -n "$latest" ]] || return 0
  [[ -f "$latest/previous-runtime.tsv" && ! -L "$latest/previous-runtime.tsv" ]] || return 1
  awk -F'\t' '$1=="api"||$1=="web"{print $5; print $12; n++} END{if(n!=2) exit 1}' "$latest/previous-runtime.tsv"
}

release_bytes() {
  local bytes
  bytes=$(du -sb -- "$1" 2>/dev/null | cut -f1)
  [[ "$bytes" =~ ^[0-9]+$ ]] || bytes=0
  printf '%s' "$bytes"
}

# One report row: kind path id bytes decision reason (also kept for the file).
release_report_emit() {
  RELEASE_REPORT_ROWS+=$(printf '%s\t%s\t%s\t%s\t%s\t%s' "$1" "$2" "$3" "$4" "$5" "$6")$'\n'
  printf 'RELEASE_RETENTION_REPORT kind=%s path=%s id=%s bytes=%s decision=%s reason=%s\n' "$1" "$2" "$3" "$4" "$5" "$6"
}

# release_retention_report: lists what a future retention would keep and what
# it would delete.  Report only: it never removes anything and always returns 0.
release_retention_report() {
  local mode=${RELEASE_RETENTION:-report} keep=${RELEASE_RETENTION_KEEP:-2} root cids cid img in_use rollback_ids
  local meta rows dir f rank decision reasons role row_role id released tag tag_id keep_ids report_dir report avail_kb used
  root=$(release_artifact_root)
  [[ "$mode" == report ]] || printf 'RELEASE_RETENTION_WARN mode=%s unsupported_in_this_version using=report\n' "$mode"
  [[ "$keep" =~ ^[1-9][0-9]*$ ]] || keep=2
  printf 'RELEASE_RETENTION_MODE=report keep=%s root=%s\n' "$keep" "$root"
  if ! cids=$(docker ps -aq 2>/dev/null); then printf 'RELEASE_RETENTION=SKIPPED reason=containers_unreadable\n'; return 0; fi
  in_use=''
  for cid in $cids; do
    if ! img=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null); then printf 'RELEASE_RETENTION=SKIPPED reason=container_image_unreadable\n'; return 0; fi
    in_use+="$img"$'\n'
  done
  if ! rollback_ids=$(release_current_rollback_ids); then printf 'RELEASE_RETENTION=SKIPPED reason=rollback_set_unreadable\n'; return 0; fi
  RELEASE_REPORT_ROWS=''

  rows=''
  for meta in "$root"/*/*.release.tsv; do
    [[ -e "$meta" ]] || break
    if release_meta_load "$meta"; then
      rows+=$(printf '%s\t%s\t%s\t%s' "$RELEASE_META_RELEASED_AT" "$RELEASE_META_ROLE" "$RELEASE_META_IMAGE_ID" "$meta")$'\n'
    else
      release_report_emit release_record "$meta" - "$(release_bytes "$meta")" keep "unverifiable_record:${RELEASE_ERROR}"
    fi
  done
  keep_ids=''
  for role in api web; do
    rank=0
    while IFS=$'\t' read -r released row_role id meta; do
      [[ -n "$meta" && -n "$released" && "$row_role" == "$role" ]] || continue
      rank=$((rank + 1)); reasons=''
      if (( rank <= keep )); then reasons+="recent_${rank},"; fi
      if grep -Fxq "$id" <<<"$in_use"; then reasons+="in_use,"; fi
      if grep -Fxq "$id" <<<"$rollback_ids"; then reasons+="current_rollback,"; fi
      if [[ -n "$reasons" ]]; then decision=keep; keep_ids+="$id"$'\n'; else decision=would_delete; reasons=superseded,; fi
      release_report_emit release "${meta%.release.tsv}.tar.gz" "$id" "$(release_bytes "${meta%.release.tsv}.tar.gz")" "$decision" "${reasons%,}"
    done < <(awk -F'\t' -v r="$role" '$2==r' <<<"$rows" | sort -r)
  done

  for dir in "$root"/*/; do
    [[ -d "$dir" ]] || break
    dir=${dir%/}
    for f in "$dir"/* "$dir"/.*; do
      [[ -e "$f" && ! -d "$f" ]] || continue
      case "$f" in
        *.release.tsv) ;;
        "$dir"/.*.tmp.*) release_report_emit orphan_tmp "$f" - "$(release_bytes "$f")" would_delete incomplete_write ;;
        *.tar.gz)
          if [[ ! -e "${f%.tar.gz}.release.tsv" ]]; then
            release_report_emit unrecorded_file "$f" - "$(release_bytes "$f")" report_only no_release_record
          fi ;;
        *) release_report_emit legacy_file "$f" - "$(release_bytes "$f")" report_only legacy ;;
      esac
    done
  done
  for dir in "${REBASELINE_EVIDENCE_DIR:-/var/log/gest-o/rebaseline}"/*/; do
    [[ -d "$dir" ]] || break
    release_report_emit rebaseline_dir "${dir%/}" - "$(release_bytes "$dir")" report_only legacy
  done
  while IFS=$'\t' read -r tag tag_id; do
    [[ -n "$tag" ]] || continue
    reasons=''
    if grep -Fxq "$tag_id" <<<"$in_use"; then reasons+="in_use,"; fi
    if grep -Fxq "$tag_id" <<<"$rollback_ids"; then reasons+="current_rollback,"; fi
    if grep -Fxq "$tag_id" <<<"$keep_ids"; then reasons+="kept_release,"; fi
    if [[ -n "$reasons" ]]; then decision=keep; else decision=would_delete; reasons=unreferenced,; fi
    release_report_emit image_tag "$tag" "$tag_id" - "$decision" "${reasons%,}"
  done < <(docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}}{{"\t"}}{{.ID}}' 2>/dev/null | grep -E '^gest-o-(api|web)-(release|rollback|rebaseline):')
  avail_kb=$(df -Pk -- "$root" 2>/dev/null | awk 'NR==2{print $4}')
  used=$(df -Pk -- "$root" 2>/dev/null | awk 'NR==2{print $5}')
  if [[ "$avail_kb" =~ ^[0-9]+$ ]]; then avail_kb=$((avail_kb * 1024)); else avail_kb=unknown; fi
  printf 'RELEASE_RETENTION_REPORT kind=disk path=%s avail_bytes=%s used=%s\n' "$root" "$avail_kb" "${used:-unknown}"

  report_dir=${RELEASE_RETENTION_REPORT_DIR:-/var/log/gest-o/release-retention}
  report="$report_dir/$(date -u +%Y%m%dT%H%M%SZ).tsv"
  if release_prepare_dir "$report_dir" && printf 'kind\tpath\tid\tbytes\tdecision\treason\n%s' "$RELEASE_REPORT_ROWS" >"$report" && release_protect_file "$report"; then
    printf 'RELEASE_RETENTION=REPORTED file=%s\n' "$report"
  else
    printf 'RELEASE_RETENTION_WARN report_file_not_written dir=%s\n' "$report_dir"
  fi
  return 0
}
