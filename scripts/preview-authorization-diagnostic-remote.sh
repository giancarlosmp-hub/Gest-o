#!/usr/bin/env bash
set -uo pipefail

: "${DIAGNOSTIC_TEMP_DIR:?}" "${DIAGNOSTIC_MANIFEST:?}" "${DIAGNOSTIC_CODE_SHA:?}"
: "${PREVIEW_OWNER_REPOSITORY:?}" "${PREVIEW_OWNER_PR:?}" "${PREVIEW_OWNER_RUN_ID:?}"
: "${PREVIEW_OWNER_RUN_ATTEMPT:?}" "${PREVIEW_OWNER_WORKFLOW:?}" "${EXPECTED_PREVIEW_SHA:?}"
: "${COMPOSE_PROJECT_NAME:?}" "${GITHUB_TOKEN:?}"

if [[ ! "$DIAGNOSTIC_TEMP_DIR" =~ ^/tmp/gesto-preview-authorization-diagnostic-[0-9]+-[0-9]+$ ]]; then
  echo 'PREVIEW_AUTH_DIAGNOSTIC_RESULT=ERROR reason=unsafe_temporary_directory'
  exit 2
fi
trusted_script="${DIAGNOSTIC_TEMP_DIR}/scripts/preview-image-lifecycle.mjs"
output_file="${DIAGNOSTIC_TEMP_DIR}/authorization-output.txt"

cleanup_temporary_files() {
  if [[ "$DIAGNOSTIC_TEMP_DIR" =~ ^/tmp/gesto-preview-authorization-diagnostic-[0-9]+-[0-9]+$ ]]; then
    if rm -rf -- "$DIAGNOSTIC_TEMP_DIR"; then
      echo 'PREVIEW_AUTH_DIAGNOSTIC_TEMP_CLEANUP=REMOVED'
    else
      echo 'PREVIEW_AUTH_DIAGNOSTIC_TEMP_CLEANUP=FAILED'
    fi
  else
    echo 'PREVIEW_AUTH_DIAGNOSTIC_TEMP_CLEANUP=REFUSED'
  fi
}
trap cleanup_temporary_files EXIT

echo 'PREVIEW_AUTH_DIAGNOSTIC_REMOTE_STARTED=YES'
echo "PREVIEW_AUTH_DIAGNOSTIC_CODE_SHA=${DIAGNOSTIC_CODE_SHA}"
echo "PREVIEW_AUTH_DIAGNOSTIC_TARGET=project:${COMPOSE_PROJECT_NAME},pr:${PREVIEW_OWNER_PR},run:${PREVIEW_OWNER_RUN_ID},attempt:${PREVIEW_OWNER_RUN_ATTEMPT}"

if [ ! -f "$DIAGNOSTIC_MANIFEST" ]; then
  echo 'PREVIEW_AUTH_DIAGNOSTIC_RESULT=PRESERVED reason=manifest_absent'
  echo 'PREVIEW_AUTH_DIAGNOSTIC_EXIT_CODE=NOT_EXECUTED'
  echo 'PREVIEW_AUTH_DIAGNOSTIC_CLEANUP_EXECUTED=NO'
  exit 1
fi
if [ ! -f "$trusted_script" ]; then
  echo 'PREVIEW_AUTH_DIAGNOSTIC_RESULT=ERROR reason=trusted_script_absent'
  echo 'PREVIEW_AUTH_DIAGNOSTIC_EXIT_CODE=NOT_EXECUTED'
  echo 'PREVIEW_AUTH_DIAGNOSTIC_CLEANUP_EXECUTED=NO'
  exit 2
fi

set +e
node "$trusted_script" authorize "$DIAGNOSTIC_MANIFEST" >"$output_file" 2>&1
authorization_rc=$?
set -e
reason=$(sed -n 's/^PREVIEW_IMAGE_RESULT=PRESERVED reason=\([^ ]*\).*$/\1/p' "$output_file" | tail -n 1)
field=$(sed -n 's/^PREVIEW_IMAGE_RESULT=PRESERVED .* field=\([^ ]*\).*$/\1/p' "$output_file" | tail -n 1)
if [ "$authorization_rc" -eq 0 ] && grep -q '^PREVIEW_IMAGE_AUTHORIZATION=PASS ' "$output_file"; then
  echo 'PREVIEW_AUTH_DIAGNOSTIC_RESULT=PASS reason=authorization_approved'
  diagnostic_rc=0
elif [[ "$reason" == github_query_failed_* ]] || [ "$reason" = github_auth_missing ]; then
  echo "PREVIEW_AUTH_DIAGNOSTIC_RESULT=ERROR reason=${reason:-github_api_error}"
  diagnostic_rc=$authorization_rc
  [ "$diagnostic_rc" -ne 0 ] || diagnostic_rc=2
elif [ "$authorization_rc" -ne 0 ] && [ -n "$reason" ]; then
  printf 'PREVIEW_AUTH_DIAGNOSTIC_RESULT=PRESERVED reason=%s' "$reason"
  [ -z "$field" ] || printf ' field=%s' "$field"
  printf '\n'
  diagnostic_rc=$authorization_rc
else
  echo "PREVIEW_AUTH_DIAGNOSTIC_RESULT=ERROR reason=unexpected_authorize_result"
  diagnostic_rc=2
fi
echo "PREVIEW_AUTH_DIAGNOSTIC_EXIT_CODE=${authorization_rc}"
echo 'PREVIEW_AUTH_DIAGNOSTIC_CLEANUP_EXECUTED=NO'
exit "$diagnostic_rc"
