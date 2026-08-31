#!/usr/bin/env bash
# EXIT handler for the disposable PR827 preview harness. It deliberately owns
# only resources whose creation was recorded by this process.
pr827_preview_harness_cleanup(){
  local operation_rc=$1 container_rc=NOT_CREATED network_rc=NOT_CREATED image_rc=NOT_CREATED temp_rc=NOT_CREATED
  local cleanup_failed=0 final_rc final_state=PASS
  trap - EXIT INT TERM
  set +e

  if (( HARNESS_CONTAINER_CREATED == 1 )); then
    if docker container inspect "$name" >/dev/null 2>&1; then
      if docker rm -f "$name" >/dev/null 2>&1; then
        if docker container inspect "$name" >/dev/null 2>&1; then container_rc=ABSENCE_NOT_PROVEN; cleanup_failed=1
        else container_rc=REMOVED; fi
      else container_rc=REMOVE_FAILED; cleanup_failed=1; fi
    else container_rc=ALREADY_ABSENT; fi
  fi

  if (( HARNESS_NETWORK_CREATED == 1 )); then
    if docker network inspect "$network" >/dev/null 2>&1; then
      if docker network rm "$network" >/dev/null 2>&1; then
        if docker network inspect "$network" >/dev/null 2>&1; then network_rc=ABSENCE_NOT_PROVEN; cleanup_failed=1
        else network_rc=REMOVED; fi
      else network_rc=REMOVE_FAILED; cleanup_failed=1; fi
    else network_rc=ALREADY_ABSENT; fi
  fi

  # postgres:16 is an input to this harness, never an image created by it.
  if (( HARNESS_IMAGE_CREATED == 1 )); then image_rc=OWNED_IMAGE_CLEANUP_UNIMPLEMENTED; cleanup_failed=1; fi

  if (( HARNESS_TEMP_CREATED == 1 )); then
    if [[ -e $HARNESS_TEMP_ROOT ]]; then
      if rm -rf "$HARNESS_TEMP_ROOT"; then
        if [[ -e $HARNESS_TEMP_ROOT ]]; then temp_rc=ABSENCE_NOT_PROVEN; cleanup_failed=1
        else temp_rc=REMOVED; fi
      else temp_rc=REMOVE_FAILED; cleanup_failed=1; fi
    else temp_rc=ALREADY_ABSENT; fi
  fi

  if (( operation_rc != 0 )); then final_rc=$operation_rc; final_state=OPERATION_FAILED
  elif (( cleanup_failed != 0 )); then final_rc=1; final_state=CLEANUP_FAILED
  else final_rc=0; fi

  printf 'HARNESS_OPERATION_RC=%s\n' "$operation_rc"
  printf 'HARNESS_CLEANUP_CONTAINER_RC=%s\n' "$container_rc"
  printf 'HARNESS_CLEANUP_NETWORK_RC=%s\n' "$network_rc"
  printf 'HARNESS_CLEANUP_IMAGE_RC=%s\n' "$image_rc"
  printf 'HARNESS_CLEANUP_TEMP_RC=%s\n' "$temp_rc"
  printf 'HARNESS_CLEANUP_FINAL_STATE=%s\n' "$final_state"
  printf 'HARNESS_FINAL_RC=%s\n' "$final_rc"
  if (( final_rc == 0 )); then echo 'PR827_PREVIEW_HARNESS_FINAL_RESULT=PASS'; fi
  exit "$final_rc"
}
