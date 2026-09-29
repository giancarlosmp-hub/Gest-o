#!/usr/bin/env bash
# Library to validate production rebaseline evidence bundles.

validate_rebaseline_evidence() {
  local app_commit=$1 rebaseline_root=${2:-${REBASELINE_EVIDENCE_DIR:-/var/log/gest-o/rebaseline}}
  local evidence_dir="$rebaseline_root/$app_commit" result_file manifest_file
  local rec_result rec_commit rec_api_id rec_web_id rec_api_tar rec_api_tar_sha rec_web_tar rec_web_tar_sha
  local calc_api_tar_sha calc_web_tar_sha

  [[ "$app_commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ -d "$evidence_dir" && ! -L "$evidence_dir" ]] || return 1

  result_file="$evidence_dir/result.tsv"
  manifest_file="$evidence_dir/manifest.tsv"

  [[ -f "$result_file" && ! -L "$result_file" ]] || return 1
  [[ -f "$manifest_file" && ! -L "$manifest_file" ]] || return 1

  rec_result=$(awk -F'\t' '$1=="result"{print $2}' "$result_file")
  rec_commit=$(awk -F'\t' '$1=="rebaseline_commit"{print $2}' "$result_file")
  rec_api_id=$(awk -F'\t' '$1=="api_image_id"{print $2}' "$result_file")
  rec_web_id=$(awk -F'\t' '$1=="web_image_id"{print $2}' "$result_file")
  rec_api_tar=$(awk -F'\t' '$1=="api_tar_path"{print $2}' "$result_file")
  rec_api_tar_sha=$(awk -F'\t' '$1=="api_tar_sha256"{print $2}' "$result_file")
  rec_web_tar=$(awk -F'\t' '$1=="web_tar_path"{print $2}' "$result_file")
  rec_web_tar_sha=$(awk -F'\t' '$1=="web_tar_sha256"{print $2}' "$result_file")

  [[ "$rec_result" == "PASS" ]] || return 1
  [[ "$rec_commit" == "$app_commit" ]] || return 1
  [[ "$rec_api_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  [[ "$rec_web_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1

  # Check tarball persistence & integrity if present
  if [[ -n "$rec_api_tar" ]]; then
    [[ -f "$rec_api_tar" && ! -L "$rec_api_tar" ]] || return 1
    calc_api_tar_sha=$(sha256sum "$rec_api_tar" | cut -d' ' -f1)
    [[ "$calc_api_tar_sha" == "$rec_api_tar_sha" ]] || return 1
  fi

  if [[ -n "$rec_web_tar" ]]; then
    [[ -f "$rec_web_tar" && ! -L "$rec_web_tar" ]] || return 1
    calc_web_tar_sha=$(sha256sum "$rec_web_tar" | cut -d' ' -f1)
    [[ "$calc_web_tar_sha" == "$rec_web_tar_sha" ]] || return 1
  fi

  REBASELINE_VERIFIED_COMMIT=$rec_commit
  REBASELINE_VERIFIED_API_ID=$rec_api_id
  REBASELINE_VERIFIED_WEB_ID=$rec_web_id
  return 0
}
