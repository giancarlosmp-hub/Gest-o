#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(TMPDIR=/tmp mktemp -d); outside=$(mktemp -d /var/tmp/pr827-override.XXXXXXXX)
cleanup(){ rm -rf "$tmp" "$outside"; }; trap cleanup EXIT
git clone --quiet --no-hardlinks "$ROOT" "$tmp/checkout"
cp "$ROOT/scripts/pr827-schema-runner.sh" "$tmp/checkout/scripts/pr827-schema-runner.sh"
cp "$ROOT/scripts/lib/pr827-backup-proof.sh" "$tmp/checkout/scripts/lib/pr827-backup-proof.sh"
result="$tmp/backup/latest/result.tsv"
run_case(){
  local label=$1 runner=$2 fixture=$3 supplied_result=$4 expected_rc=$5 rc
  set +e
  PR827_BACKUP_FIXTURE_ROOT="$fixture" BACKUP_RESULT_FILE="$supplied_result" bash "$runner/scripts/pr827-schema-runner.sh" --validate-backup-override >"$tmp/$label.out" 2>&1
  rc=$?
  set -e
  [[ $rc -eq $expected_rc ]]
  if (( expected_rc == 0 )); then grep -Fxq BACKUP_OVERRIDE_AUTHORIZATION=PASS "$tmp/$label.out"; else grep -Fq '[pr827-schema] ERROR protected backup fixture boundary is invalid' "$tmp/$label.out"; fi
}
run_case authorized "$tmp/checkout" "$tmp" "$result" 0
run_case primary_checkout "$ROOT" "$tmp" "$result" 1
git clone --quiet --no-hardlinks "$ROOT" "$outside/checkout"
cp "$ROOT/scripts/pr827-schema-runner.sh" "$outside/checkout/scripts/pr827-schema-runner.sh"
cp "$ROOT/scripts/lib/pr827-backup-proof.sh" "$outside/checkout/scripts/lib/pr827-backup-proof.sh"
run_case outside_tmp "$outside/checkout" "$outside" "$outside/backup/latest/result.tsv" 1
run_case wrong_result "$tmp/checkout" "$tmp" "$tmp/other/result.tsv" 1
unset PR827_BACKUP_PROOF_ROOT PR827_BACKUP_PROOF_EXPECTED_OWNER
source scripts/lib/pr827-backup-proof.sh
pr827_backup_proof_contract
[[ "$PR827_BACKUP_PROOF_CONTRACT_ROOT" == /var/log/gest-o/backup && "$PR827_BACKUP_PROOF_CONTRACT_OWNER" == root:root ]]
echo BACKUP_OVERRIDE_AUTHORIZATION_REGRESSION=PASS
