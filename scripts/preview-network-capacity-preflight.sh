#!/usr/bin/env bash
set -Eeuo pipefail
: "${PREVIEW_OWNER_PR:?}" "${PREVIEW_OWNER_RUN_ID:?}" "${PREVIEW_OWNER_RUN_ATTEMPT:?}" "${PREVIEW_OWNER_WORKFLOW:?}"

probe_name="gesto-preview-network-probe-${PREVIEW_OWNER_RUN_ID}-${PREVIEW_OWNER_RUN_ATTEMPT}-$$"
probe_id=""
tmp=$(mktemp -d)
cleanup_probe() {
  local original_rc=$? cleanup_rc=0
  if [[ -n "$probe_id" ]]; then
    local facts
    facts=$(docker network inspect -f '{{.Id}} {{index .Labels "com.gesto.preview.capacity-probe"}} {{index .Labels "com.gesto.preview.run-id"}} {{len .Containers}}' "$probe_name") || cleanup_rc=$?
    if [[ $cleanup_rc -eq 0 && "$facts" == "$probe_id true $PREVIEW_OWNER_RUN_ID 0" ]]; then
      docker network rm "$probe_id" >/dev/null || cleanup_rc=$?
    else
      printf 'PREVIEW_NETWORK_CAPACITY_PROBE_CLEANUP=FAIL reason=identity_or_endpoint_diverged\n' >&2
      cleanup_rc=1
    fi
  fi
  rm -rf "$tmp"
  [[ $original_rc -ne 0 ]] && exit "$original_rc"
  [[ $cleanup_rc -eq 0 ]] || exit "$cleanup_rc"
}
trap cleanup_probe EXIT

if ! docker network create --driver bridge \
  --label com.gesto.preview.capacity-probe=true \
  --label "com.gesto.preview.pr=$PREVIEW_OWNER_PR" \
  --label "com.gesto.preview.run-id=$PREVIEW_OWNER_RUN_ID" \
  --label "com.gesto.preview.run-attempt=$PREVIEW_OWNER_RUN_ATTEMPT" \
  --label "com.gesto.preview.workflow=$PREVIEW_OWNER_WORKFLOW" \
  "$probe_name" >"$tmp/id" 2>"$tmp/error"; then
  if grep -Fqi 'all predefined address pools have been fully subnetted' "$tmp/error"; then reason=predefined_address_pools_exhausted
  elif grep -Eqi 'overlap|conflict' "$tmp/error"; then reason=address_conflict
  else reason=network_create_failed
  fi
  printf 'PREVIEW_NETWORK_CAPACITY=FAIL reason=%s\n' "$reason" >&2
  exit 1
fi
probe_id=$(tr -d '\r\n' <"$tmp/id")
[[ "$probe_id" =~ ^[a-f0-9]{12,64}$ ]]
cleanup_probe
trap - EXIT
probe_id=""
printf 'PREVIEW_NETWORK_CAPACITY=PASS probe=isolated_bridge\n'
