#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
source scripts/lib/pr827-preview-harness-cleanup.sh
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
mock_docker(){
 local kind=$1 action=$2
 case "$kind:$action" in
  'container:inspect') [[ -e $MOCK_CONTAINER ]] ;;
  'network:inspect') [[ -e $MOCK_NETWORK ]] ;;
  'rm:-f') [[ ${MOCK_FAIL_CONTAINER:-0} == 0 ]] && rm "$MOCK_CONTAINER" ;;
  'network:rm') [[ ${MOCK_FAIL_NETWORK:-0} == 0 ]] && rm "$MOCK_NETWORK" ;;
  *) return 64 ;;
 esac
}
docker(){ mock_docker "$@"; }
run_case(){
 local label=$1 operation_rc=$2 created_container=$3 created_network=$4 fail_container=$5 fail_network=$6 pre_absent=$7
 local case_root="$work/$label" out="$work/$label.out" rc
 mkdir -p "$case_root/temp"; MOCK_CONTAINER="$case_root/container"; MOCK_NETWORK="$case_root/network"
 if (( created_container == 1 && pre_absent == 0 )); then : >"$MOCK_CONTAINER"; fi
 if (( created_network == 1 && pre_absent == 0 )); then : >"$MOCK_NETWORK"; fi
 if ( name=SANITIZED_CONTAINER network=SANITIZED_NETWORK HARNESS_TEMP_ROOT="$case_root/temp" \
      HARNESS_CONTAINER_CREATED=$created_container HARNESS_NETWORK_CREATED=$created_network HARNESS_IMAGE_CREATED=0 HARNESS_TEMP_CREATED=1 \
      MOCK_CONTAINER="$MOCK_CONTAINER" MOCK_NETWORK="$MOCK_NETWORK" MOCK_FAIL_CONTAINER=$fail_container MOCK_FAIL_NETWORK=$fail_network \
      pr827_preview_harness_cleanup "$operation_rc" ) >"$out" 2>&1; then rc=0; else rc=$?; fi
 printf -v "${label}_rc" '%s' "$rc"
}
run_case pass 0 1 1 0 0 0
test "$pass_rc" -eq 0; grep -Fxq HARNESS_OPERATION_RC=0 "$work/pass.out"; grep -Fxq HARNESS_CLEANUP_CONTAINER_RC=REMOVED "$work/pass.out"; grep -Fxq HARNESS_CLEANUP_NETWORK_RC=REMOVED "$work/pass.out"; grep -Fxq HARNESS_CLEANUP_IMAGE_RC=NOT_CREATED "$work/pass.out"; grep -Fxq HARNESS_CLEANUP_TEMP_RC=REMOVED "$work/pass.out"; grep -Fxq HARNESS_FINAL_RC=0 "$work/pass.out"; grep -Fxq PR827_PREVIEW_HARNESS_FINAL_RESULT=PASS "$work/pass.out"
run_case operation_fail 23 1 1 0 0 0
test "$operation_fail_rc" -eq 23; grep -Fxq HARNESS_CLEANUP_FINAL_STATE=OPERATION_FAILED "$work/operation_fail.out"; test "$(grep -c PR827_PREVIEW_HARNESS_FINAL_RESULT "$work/operation_fail.out")" -eq 0
run_case cleanup_fail 0 1 1 0 1 0
test "$cleanup_fail_rc" -ne 0; grep -Fxq HARNESS_CLEANUP_NETWORK_RC=REMOVE_FAILED "$work/cleanup_fail.out"; grep -Fxq HARNESS_CLEANUP_FINAL_STATE=CLEANUP_FAILED "$work/cleanup_fail.out"
run_case never_created 0 0 0 0 0 0
test "$never_created_rc" -eq 0; grep -Fxq HARNESS_CLEANUP_CONTAINER_RC=NOT_CREATED "$work/never_created.out"; grep -Fxq HARNESS_CLEANUP_NETWORK_RC=NOT_CREATED "$work/never_created.out"; grep -Fxq HARNESS_CLEANUP_IMAGE_RC=NOT_CREATED "$work/never_created.out"
run_case already_absent 0 1 1 0 0 1
test "$already_absent_rc" -eq 0; grep -Fxq HARNESS_CLEANUP_CONTAINER_RC=ALREADY_ABSENT "$work/already_absent.out"; grep -Fxq HARNESS_CLEANUP_NETWORK_RC=ALREADY_ABSENT "$work/already_absent.out"
run_case interrupted 130 1 1 0 0 0
test "$interrupted_rc" -eq 130; grep -Fxq HARNESS_FINAL_RC=130 "$work/interrupted.out"
python3 - scripts/lib/pr827-preview-harness-cleanup.sh scripts/smoke/pr827-preview-postgres.sh <<'PY'
import pathlib, sys
forbidden = (chr(124) * 2 + ' true', chr(124) * 2 + ' :', 'continue' + '-on-error')
for path in sys.argv[1:]:
    text = pathlib.Path(path).read_text()
    assert not any(token in text for token in forbidden), f'forbidden masking token in {path}'
PY
printf 'PREVIEW_CLEANUP_EXIT_CONTRACT=PASS\n'
grep -Fq 'bash scripts/smoke/pr827-preview-postgres.sh' scripts/smoke/pr827-preview-process.sh
grep -Fq 'DIRECT_HARNESS_PROCESS_RC=' scripts/smoke/pr827-preview-process.sh
grep -Fq 'NPM_LIFECYCLE_RC=' .github/workflows/docker-compose-ci.yml
grep -Fq 'WORKFLOW_COMMAND_RC=' .github/workflows/docker-compose-ci.yml
! grep -Fq 'chown nobody:nogroup' scripts/smoke/pr827-legacy-history.sh
printf 'PREVIEW_PARENT_PROCESS_CALL_GRAPH=PASS\n'
