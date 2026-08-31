#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
output=$(mktemp); legacy_output=$(mktemp)
remove_output(){
 local rc=$1
 trap - EXIT INT TERM
 if rm -f "$output" "$legacy_output"; then exit "$rc"; fi
 echo 'PREVIEW_PROCESS_OUTPUT_CLEANUP=FAIL' >&2
 if (( rc != 0 )); then exit "$rc"; fi
 exit 1
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'remove_output "$?"' EXIT

direct_rc=0
if bash scripts/smoke/pr827-preview-postgres.sh >"$output" 2>&1; then direct_rc=0
else direct_rc=$?; fi
cat "$output"
printf 'DIRECT_HARNESS_PROCESS_RC=%s\n' "$direct_rc"
final_marker_count=$(awk '$0=="PR827_PREVIEW_HARNESS_FINAL_RESULT=PASS"{n++} END{print n+0}' "$output")
if (( direct_rc != 0 )); then exit "$direct_rc"; fi
if (( final_marker_count != 1 )); then
  echo 'DIRECT_HARNESS_FINAL_MARKER_CONTRACT=FAIL' >&2
  exit 1
fi
echo 'DIRECT_HARNESS_FINAL_MARKER_CONTRACT=PASS'

legacy_rc=0
if bash scripts/smoke/pr827-legacy-history.sh >"$legacy_output" 2>&1; then legacy_rc=0
else legacy_rc=$?; fi
cat "$legacy_output"
printf 'LEGACY_HISTORY_SUBPROCESS_RC=%s\n' "$legacy_rc"
if (( legacy_rc != 0 )); then exit "$legacy_rc"; fi
legacy_final_marker_count=$(awk '$0=="LEGACY_HISTORY_HARNESS_FINAL_RESULT=PASS"{n++} END{print n+0}' "$legacy_output")
legacy_failure_count=$(awk '$0=="LEGACY_SCENARIO_RESULT=FAIL"{n++} END{print n+0}' "$legacy_output")
if (( legacy_final_marker_count != 1 || legacy_failure_count != 0 )); then
 echo 'LEGACY_HISTORY_FINAL_MARKER_CONTRACT=FAIL' >&2
 exit 1
fi
echo 'LEGACY_HISTORY_FINAL_MARKER_CONTRACT=PASS'

if rm -f "$output" "$legacy_output"; then trap - EXIT INT TERM
else echo 'PREVIEW_PROCESS_OUTPUT_CLEANUP=FAIL' >&2; exit 1; fi
echo 'PREVIEW_PROCESS_WRAPPER_RESULT=PASS'
