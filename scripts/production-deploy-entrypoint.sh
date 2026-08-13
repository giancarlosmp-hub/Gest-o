#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/apps/gest-o}"
DEPLOY_MODE="${DEPLOY_MODE:-build}"
failure_stage=initialization
failure_command=entrypoint_initialization

report_failure() {
  local exit_code=$?
  trap - ERR
  printf 'DEPLOY_FAILURE_STAGE=%s\n' "$failure_stage" >&2
  printf 'DEPLOY_FAILURE_COMMAND=%s\n' "$failure_command" >&2
  printf 'DEPLOY_FAILURE_EXIT_CODE=%s\n' "$exit_code" >&2
  exit "$exit_code"
}
trap report_failure ERR

fail() {
  local stage=$1 command=$2 exit_code=${3:-1} message=${4:-}
  trap - ERR
  printf 'DEPLOY_FAILURE_STAGE=%s\n' "$stage" >&2
  printf 'DEPLOY_FAILURE_COMMAND=%s\n' "$command" >&2
  printf 'DEPLOY_FAILURE_EXIT_CODE=%s\n' "$exit_code" >&2
  [[ -z "$message" ]] || printf '%s\n' "$message" >&2
  exit "$exit_code"
}

failure_stage=repository_access
failure_command=change_to_application_directory
cd "$APP_DIR"

failure_stage=git_fetch
failure_command=git_fetch_main
git fetch origin main
printf 'DEPLOY_GIT_FETCH=PASS\n'

failure_stage=git_switch
failure_command=git_switch_main
git switch main
printf 'DEPLOY_GIT_SWITCH=PASS\n'

failure_stage=git_fast_forward
failure_command=git_pull_fast_forward_main
git pull --ff-only origin main
printf 'DEPLOY_GIT_FAST_FORWARD=PASS\n'

if [[ ! "${EXPECTED_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  fail expected_sha_format validate_expected_sha_format 1 \
    'DEPLOY_EXPECTED_SHA_FORMAT=FAIL'
fi
printf 'DEPLOY_EXPECTED_SHA_FORMAT=PASS\n'

failure_stage=checkout_sha_read
failure_command=read_checkout_sha
if ! actual_sha="$(git rev-parse HEAD)"; then
  fail checkout_sha_read read_checkout_sha 1 'DEPLOY_CHECKOUT_SHA_MATCH=FAIL'
fi
if [[ ! "$actual_sha" =~ ^[0-9a-f]{40}$ ]]; then
  fail checkout_sha_format validate_checkout_sha_format 1 \
    "DEPLOY_CHECKOUT_SHA_MATCH=FAIL EXPECTED_SHA=$EXPECTED_SHA ACTUAL_SHA=$actual_sha"
fi
if [[ "$actual_sha" != "$EXPECTED_SHA" ]]; then
  fail checkout_sha_match compare_checkout_sha 1 \
    "DEPLOY_CHECKOUT_SHA_MATCH=FAIL EXPECTED_SHA=$EXPECTED_SHA ACTUAL_SHA=$actual_sha"
fi
printf 'DEPLOY_CHECKOUT_SHA_MATCH=PASS\n'

failure_stage=worktree_validation
failure_command=validate_clean_worktree
worktree_status="$(git status --porcelain)"
if [[ -n "$worktree_status" ]]; then
  fail worktree_validation validate_clean_worktree 1 'DEPLOY_WORKTREE_CLEAN=FAIL'
fi
printf 'DEPLOY_WORKTREE_CLEAN=PASS\n'

if [[ ! -f scripts/deploy-production.sh ]]; then
  fail deploy_script_validation validate_deploy_script_presence 1 'DEPLOY_SCRIPT_PRESENT=FAIL'
fi
printf 'DEPLOY_SCRIPT_PRESENT=PASS\n'
printf 'DEPLOY_SCRIPT_STARTING=%s\n' "$DEPLOY_MODE"

failure_stage=deploy_script
failure_command=run_deploy_script
if [[ "$DEPLOY_MODE" == cutover ]]; then
  MODE=cutover CONFIRM=PRODUCTION_CUTOVER EXPECTED_SHA="$EXPECTED_SHA" bash scripts/deploy-production.sh
elif [[ "$DEPLOY_MODE" == build ]]; then
  MODE=build EXPECTED_SHA="$EXPECTED_SHA" bash scripts/deploy-production.sh
else
  fail deploy_mode validate_deploy_mode 1 'DEPLOY_MODE=FAIL'
fi
