#!/usr/bin/env bash
# Disk maintenance after a HEALTHY phase=cutover.  Called only by
# deploy-production.sh, after the new runtime passed every check and its release
# artifact was saved:
#
#   production-post-cutover-maintenance.sh --commit=<sha>
#
#  1. oci-backups-retention.sh in simulation, then --apply with exactly the
#     counts it reported (release folders and Docker tags, same rules as the
#     manual run: current, rollback, 2 newest, rebaseline/legacy, pending build).
#  2. Build cache older than 7 days:
#       docker builder prune --force --filter until=168h
#     This is the only prune in the repository (approved exception) and it
#     runs nowhere else.
#
# Never fails the deploy: it prints DEPLOY_RETENTION=OK|FAILED|SKIPPED and
# DEPLOY_BUILD_CACHE=OK|FAILED|SKIPPED and always exits 0.  The full output goes
# to /var/log/gest-o/oci-backups-retention/<UTC>-post-cutover.log.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

commit=''
for arg in "$@"; do
  case "$arg" in
    --commit=*) commit=${arg#--commit=} ;;
    *) printf 'DEPLOY_RETENTION=SKIPPED reason=invalid_argument\nDEPLOY_BUILD_CACHE=SKIPPED reason=invalid_argument\n'; exit 0 ;;
  esac
done

log_dir=${OCI_RETENTION_LOG_DIR:-/var/log/gest-o/oci-backups-retention}
log="$log_dir/$(date -u +%Y%m%dT%H%M%SZ)-post-cutover.log"
if mkdir -p -- "$log_dir" 2>/dev/null && chmod 700 -- "$log_dir" 2>/dev/null && : >>"$log" 2>/dev/null; then
  chmod 600 -- "$log" 2>/dev/null || :
else
  log=/dev/null
fi
say() { printf '%s\n' "$*"; printf '%s\n' "$*" >>"$log"; }
say "DEPLOY_MAINTENANCE_LOG=$log"

# Only after a healthy cutover of this commit: deploy-production.sh writes
# index.local.html after /health/version and the web answered for it.
evidence="${DEPLOY_EVIDENCE_DIR:-/var/log/gest-o/deploy}/$commit"
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ || ! -f "$evidence/index.local.html" || -L "$evidence/index.local.html" ]]; then
  say 'DEPLOY_RETENTION=SKIPPED reason=no_healthy_cutover_evidence'
  say 'DEPLOY_BUILD_CACHE=SKIPPED reason=no_healthy_cutover_evidence'
  exit 0
fi

# reason=<x> from a STOPPED line, else the RESULT value, else the exit code.
failure_reason() {
  local out=$1 rc=$2 line
  line=$(grep '^OCI_RETENTION_RESULT=' <<<"$out" | tail -n1)
  if [[ "$line" =~ \ reason=([A-Za-z0-9_]+) ]]; then printf '%s' "${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^OCI_RETENTION_RESULT=([A-Z_]+) && "${BASH_REMATCH[1]}" != SIMULATED && "${BASH_REMATCH[1]}" != APPLIED ]]; then printf '%s' "${BASH_REMATCH[1]}"
  else printf 'exit_%s' "$rc"
  fi
}

retention() {
  local out rc dirs tags
  out=$(timeout 15m bash "$SCRIPT_DIR/oci-backups-retention.sh" 2>&1); rc=$?
  printf '%s\n' "$out" >>"$log"
  if [[ "$rc" -ne 0 || ! "$(grep '^OCI_RETENTION_RESULT=' <<<"$out" | tail -n1)" =~ ^OCI_RETENTION_RESULT=SIMULATED\ candidates=([0-9]+)\ mutations=0\ tag_candidates=([0-9]+)$ ]]; then
    say "DEPLOY_RETENTION=FAILED step=simulation reason=$(failure_reason "$out" "$rc") log=$log"
    return
  fi
  dirs=${BASH_REMATCH[1]} tags=${BASH_REMATCH[2]}
  if [[ "$dirs" == 0 && "$tags" == 0 ]]; then
    say "DEPLOY_RETENTION=OK removed_dirs=0 removed_tags=0 log=$log"
    return
  fi
  out=$(timeout 15m bash "$SCRIPT_DIR/oci-backups-retention.sh" --apply "--expect=$dirs" "--expect-tags=$tags" 2>&1); rc=$?
  printf '%s\n' "$out" >>"$log"
  if [[ "$rc" -eq 0 && "$(grep '^OCI_RETENTION_RESULT=' <<<"$out" | tail -n1)" =~ ^OCI_RETENTION_RESULT=APPLIED\ removed_dirs=([0-9]+)\ mutations=[0-9]+\ removed_tags=([0-9]+)\ avail_kb=([0-9a-z]+)$ ]]; then
    say "DEPLOY_RETENTION=OK removed_dirs=${BASH_REMATCH[1]} removed_tags=${BASH_REMATCH[2]} avail_kb=${BASH_REMATCH[3]} log=$log"
  else
    say "DEPLOY_RETENTION=FAILED step=apply reason=$(failure_reason "$out" "$rc") log=$log"
  fi
}

build_cache() {
  local out rc reclaimed
  out=$(timeout 15m docker builder prune --force --filter until=168h 2>&1); rc=$?
  printf '%s\n' "$out" >>"$log"
  if [[ "$rc" -eq 0 ]]; then
    reclaimed=$(sed -n 's/^Total reclaimed space: *//p' <<<"$out" | tail -n1 | tr -cd '[:alnum:].')
    say "DEPLOY_BUILD_CACHE=OK older_than=168h reclaimed=${reclaimed:-unknown}"
  else
    say "DEPLOY_BUILD_CACHE=FAILED reason=exit_$rc"
  fi
}

retention
build_cache
exit 0
