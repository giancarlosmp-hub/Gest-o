#!/usr/bin/env bash
# Manual retention of the release artifacts in /var/log/gest-o/oci-backups
# (TD-DEPLOY-RETENTION-DELETE).  Not called by the deploy.
#
#   oci-backups-retention.sh                      simulation: lists candidates and sizes
#   oci-backups-retention.sh --apply --expect=N   removes exactly the N candidates
#
# A <commit> folder is a candidate only when every tar in it is reported as
# "release ... would_delete superseded" by the newest retention report
# (/var/log/gest-o/release-retention/<UTC>.tsv, written by every deploy) and the
# folder is none of: the 2 newest releases per role, the current runtime, the
# rollback of the last healthy cutover (previous-runtime.tsv and
# rollback-artifacts.tsv), the pending build, a folder without .release.tsv
# (rebaseline/legacy) or with an unverifiable record.  The protections are
# recomputed here; the report alone is never enough.
#
# Removal is file by file (rm -- <folder>/<name>) followed by rmdir.  Docker
# tags are not touched.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/production-release-artifact.sh
source "$SCRIPT_DIR/lib/production-release-artifact.sh"

apply=no expect=''
for arg in "$@"; do
  case "$arg" in
    --apply) apply=yes ;;
    --expect=*) expect=${arg#--expect=} ;;
    *) echo 'OCI_RETENTION_RESULT=INVALID_ARGUMENT'; exit 2 ;;
  esac
done
if [[ "$apply" == yes && ! "$expect" =~ ^[1-9][0-9]*$ ]]; then echo 'OCI_RETENTION_RESULT=EXPECT_REQUIRED'; exit 2; fi

KEEP=2
root=$(release_artifact_root)
report_dir=${RELEASE_RETENTION_REPORT_DIR:-/var/log/gest-o/release-retention}
deploy_dir=${DEPLOY_EVIDENCE_DIR:-/var/log/gest-o/deploy}
log_dir=${OCI_RETENTION_LOG_DIR:-/var/log/gest-o/oci-backups-retention}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p -- "$log_dir" || { echo 'OCI_RETENTION_RESULT=LOG_DIR_UNAVAILABLE'; exit 1; }
chmod 700 -- "$log_dir" 2>/dev/null || :
log="$log_dir/$stamp.log"
: >>"$log" || { echo 'OCI_RETENTION_RESULT=LOG_DIR_UNAVAILABLE'; exit 1; }
chmod 600 -- "$log" 2>/dev/null || :
mutations=0
say() { printf '%s\n' "$*"; printf '%s\n' "$*" >>"$log"; }
stop() { say "OCI_RETENTION_RESULT=STOPPED reason=$1 mutations=$mutations"; say "OCI_RETENTION_LOG=$log"; exit 1; }
say "OCI_RETENTION_MODE=$([[ $apply == yes ]] && echo apply || echo simulation) keep=$KEEP root=$root"

[[ -d "$root" && ! -L "$root" ]] || stop root_unavailable
root_real=$(realpath -e -- "$root") || stop root_unavailable

# --- Newest retention report. ---
report=''
for f in "$report_dir"/*.tsv; do
  [[ -e "$f" ]] || break
  [[ "$(basename -- "$f")" =~ ^[0-9]{8}T[0-9]{6}Z\.tsv$ ]] || continue
  if [[ -z "$report" || "$(basename -- "$f")" > "$(basename -- "$report")" ]]; then report=$f; fi
done
[[ -n "$report" ]] || stop report_missing
[[ -f "$report" && ! -L "$report" ]] || stop report_invalid
[[ "$(head -n1 -- "$report")" == $'kind\tpath\tid\tbytes\tdecision\treason' ]] || stop report_invalid
r=$(basename -- "$report" .tsv)
report_at="${r:0:4}-${r:4:2}-${r:6:2}T${r:9:2}:${r:11:2}:${r:13:2}Z"
say "OCI_RETENTION_REPORT file=$(basename -- "$report") at=$report_at"

# --- Protected identities. ---
cids=$(docker ps -aq --no-trunc) || stop containers_unreadable
in_use=''
for cid in $cids; do
  img=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null) || stop container_image_unreadable
  in_use+="$img"$'\n'
done
rollback_ids=$(release_current_rollback_ids) || stop rollback_set_unreadable
pending_ids=$(release_pending_build_ids) || stop build_evidence_unreadable
# Last healthy cutover: same rule as release_current_rollback_ids.
latest_cutover='' latest_ts=0
for d in "$deploy_dir"/*/; do
  [[ -f "$d/index.local.html" ]] || continue
  ts=$(stat -c '%Y' -- "$d/index.local.html" 2>/dev/null) || stop rollback_set_unreadable
  if (( ts > latest_ts )); then latest_ts=$ts; latest_cutover=${d%/}; fi
done
current_commit='' rollback_commits='' rollback_tars=''
if [[ -n "$latest_cutover" ]]; then
  current_commit=$(basename -- "$latest_cutover")
  rollback_commits=$(awk -F'\t' '$1=="api"||$1=="web"{print $10}' "$latest_cutover/previous-runtime.tsv") || stop rollback_set_unreadable
  if [[ -e "$latest_cutover/rollback-artifacts.tsv" ]]; then
    [[ -f "$latest_cutover/rollback-artifacts.tsv" && ! -L "$latest_cutover/rollback-artifacts.tsv" ]] || stop rollback_set_unreadable
    rollback_tars=$(awk -F'\t' 'NR>1{print $4}' "$latest_cutover/rollback-artifacts.tsv") || stop rollback_set_unreadable
  fi
fi

# --- Folders and records. ---
declare -A reasons=() files=() meta_rows=()
dirs=() rows=''
add_reason() { [[ ",${reasons[$1]}," == *",$2,"* ]] || reasons[$1]+="${reasons[$1]:+,}$2"; }
for d in "$root"/*/ "$root"/.*/; do
  d=${d%/}; name=$(basename -- "$d")
  [[ "$name" == . || "$name" == .. || ! -e "$d" ]] && continue
  dirs+=("$name"); reasons[$name]=''; files[$name]=''
  if [[ -L "$d" ]]; then add_reason "$name" symlink; continue; fi
  [[ "$name" =~ ^[0-9a-f]{40}$ ]] || add_reason "$name" unexpected_dir_name
  metas=0 tars=0
  for f in "$d"/* "$d"/.*; do
    base=$(basename -- "$f")
    [[ "$base" == . || "$base" == .. || ! -e "$f" && ! -L "$f" ]] && continue
    files[$name]+="$base"$'\n'
    if [[ -L "$f" || ! -f "$f" ]]; then add_reason "$name" unexpected_file; continue; fi
    if [[ "$base" =~ ^(api|web)\.[0-9a-f]{64}\.release\.tsv$ ]]; then
      metas=$((metas + 1))
      [[ -f "$d/${base%.release.tsv}.tar.gz" ]] || add_reason "$name" unpaired_file
      if release_meta_load "$d/$base"; then
        rows+=$(printf '%s\t%s\t%s\t%s\t%s\t%s' "$RELEASE_META_RELEASED_AT" "$RELEASE_META_ROLE" "$name" "$RELEASE_META_IMAGE_ID" "$RELEASE_META_RUNTIME_IDENTITY" "$RELEASE_META_TAR")$'\n'
        [[ "$RELEASE_META_RELEASED_AT" > "$report_at" ]] && stop report_stale
      else
        add_reason "$name" unverifiable_record
      fi
    elif [[ "$base" =~ ^(api|web)\.[0-9a-f]{64}\.tar\.gz$ ]]; then
      tars=$((tars + 1))
      [[ -f "$d/${base%.tar.gz}.release.tsv" ]] || add_reason "$name" unpaired_file
    else
      add_reason "$name" unexpected_file
    fi
  done
  (( metas > 0 )) || add_reason "$name" no_release_record
  if awk -F'\t' -v p="$d/" '$1=="release_record" && index($2,p)==1 && index($6,"unverifiable_record")==1 {f=1} END{exit !f}' "$report"; then
    add_reason "$name" unverifiable_record
  fi
done

# The newest $KEEP releases per role, over every loadable record.
for role in api web; do
  rank=0
  while IFS=$'\t' read -r _ _ name _; do
    [[ -n "$name" ]] || continue
    rank=$((rank + 1)); (( rank <= KEEP )) && add_reason "$name" "recent_$rank"
  done < <(awk -F'\t' -v r="$role" '$2==r' <<<"$rows" | LC_ALL=C sort -r)
done

while IFS=$'\t' read -r released role name id runtime tar; do
  [[ -n "$name" ]] || continue
  if grep -Fxq -e "$id" -e "$runtime" <<<"$in_use"; then add_reason "$name" in_use; fi
  if grep -Fxq -e "$id" -e "$runtime" <<<"$rollback_ids" || grep -Fxq -e "$tar" <<<"$rollback_tars"; then add_reason "$name" current_rollback; fi
  if grep -Fxq -e "$id" -e "$runtime" <<<"$pending_ids"; then add_reason "$name" build_pending; fi
  # Exactly one report row for this tar, with the same ID, would_delete superseded.
  if ! awk -F'\t' -v p="$tar" -v i="$id" '$1=="release" && $2==p {n++; if ($3==i && $5=="would_delete" && $6=="superseded") ok++} END{exit !(n==1 && ok==1)}' "$report"; then
    add_reason "$name" not_superseded_in_report
  fi
done <<<"$rows"
for name in "${dirs[@]}"; do
  [[ -n "$current_commit" && "$name" == "$current_commit" ]] && add_reason "$name" current
  if grep -Fxq -e "$name" <<<"$rollback_commits"; then add_reason "$name" current_rollback; fi
done

# --- Plan. ---
candidates=() candidate_bytes=0
for name in "${dirs[@]}"; do
  bytes=$(release_bytes "$root/$name")
  if [[ -z "${reasons[$name]}" ]]; then
    candidates+=("$name"); candidate_bytes=$((candidate_bytes + bytes))
    say "OCI_RETENTION_PLAN dir=$name decision=candidate bytes=$bytes"
  else
    say "OCI_RETENTION_PLAN dir=$name decision=keep reason=${reasons[$name]} bytes=$bytes"
  fi
done
say "OCI_RETENTION_COUNTS dirs=${#dirs[@]} candidates=${#candidates[@]} keep=$(( ${#dirs[@]} - ${#candidates[@]} )) candidate_bytes=$candidate_bytes"

if [[ "$apply" != yes ]]; then
  say "OCI_RETENTION_RESULT=SIMULATED candidates=${#candidates[@]} mutations=0"
  say "OCI_RETENTION_LOG=$log"
  exit 0
fi

# --- Apply: one file at a time by name, then rmdir (never recursive). ---
[[ "$expect" == "${#candidates[@]}" ]] || stop expect_mismatch
for name in "${candidates[@]}"; do
  d="$root/$name"
  [[ -d "$d" && ! -L "$d" && "$(realpath -e -- "$d")" == "$root_real/$name" ]] || stop dir_changed
  now=''
  for f in "$d"/* "$d"/.*; do
    base=$(basename -- "$f")
    [[ "$base" == . || "$base" == .. || ! -e "$f" && ! -L "$f" ]] && continue
    now+="$base"$'\n'
  done
  [[ "$now" == "${files[$name]}" ]] || stop dir_changed
  while IFS= read -r base; do
    [[ -n "$base" ]] || continue
    rm -- "$d/$base" </dev/null >>"$log" 2>&1 || stop file_rm_failed
    mutations=$((mutations + 1))
  done <<<"${files[$name]}"
  rmdir -- "$d" >>"$log" 2>&1 || stop rmdir_failed
  mutations=$((mutations + 1))
  say "OCI_RETENTION_REMOVED dir=$name"
done
avail_kb=$(df -Pk -- "$root" 2>/dev/null | awk 'NR==2{print $4}')
say "OCI_RETENTION_RESULT=APPLIED removed_dirs=${#candidates[@]} mutations=$mutations avail_kb=${avail_kb:-unknown}"
say "OCI_RETENTION_LOG=$log"
