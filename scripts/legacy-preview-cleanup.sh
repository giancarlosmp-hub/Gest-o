#!/usr/bin/env bash
set -Eeuo pipefail
# Safe legacy preview inventory/apply. The reviewed TSV is an explicit allowlist,
# not a discovery shortcut: project, PR, container IDs and network IDs are fixed.
mode=${1:-inventory}; manifest=${2:-}
[[ "$mode" == inventory || "$mode" == apply ]] || { echo 'LEGACY_PREVIEW_RESULT=INVALID_MODE'; exit 2; }
[[ -r "$manifest" ]] || { echo 'LEGACY_PREVIEW_RESULT=MANIFEST_REQUIRED'; exit 2; }
[[ "$(head -n1 "$manifest")" == $'project\tpr\tcontainer_ids\tnetwork_ids' ]] || { echo 'LEGACY_PREVIEW_RESULT=INVALID_HEADER'; exit 2; }

while IFS=$'\t' read -r project pr container_csv network_csv extra; do
  [[ -z "${extra:-}" && "$project" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ && "$pr" =~ ^[0-9]+$ ]] || { echo 'LEGACY_PREVIEW_RESULT=INVALID_ROW'; exit 1; }
  [[ ",$container_csv," != *",,"* && ",$network_csv," != *",,"* ]] || { echo 'LEGACY_PREVIEW_RESULT=EMPTY_ID'; exit 1; }
  IFS=, read -ra containers <<<"$container_csv"; IFS=, read -ra networks <<<"$network_csv"
  ((${#containers[@]} > 0 && ${#networks[@]} > 0)) || { echo 'LEGACY_PREVIEW_RESULT=INSUFFICIENT_EVIDENCE'; exit 1; }
  for id in "${containers[@]}"; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || { echo 'LEGACY_PREVIEW_RESULT=FULL_ID_REQUIRED'; exit 1; }
    actual_project=$(docker container inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id")
    [[ "$actual_project" == "$project" ]] || { echo 'LEGACY_PREVIEW_RESULT=OWNERSHIP_DIVERGED'; exit 1; }
    mounts=$(docker container inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' "$id")
    [[ "$mounts" != *gest-o_pgdata* ]] || { echo 'LEGACY_PREVIEW_RESULT=SHARED_VOLUME_PROTECTED'; exit 1; }
  done
  for id in "${networks[@]}"; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || { echo 'LEGACY_PREVIEW_RESULT=FULL_ID_REQUIRED'; exit 1; }
    [[ "$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' "$id")" == "$project" ]] || { echo 'LEGACY_PREVIEW_RESULT=OWNERSHIP_DIVERGED'; exit 1; }
  done
  echo "LEGACY_PREVIEW_VERIFIED project=$project pr=$pr containers=${#containers[@]} networks=${#networks[@]} mode=$mode"
  if [[ "$mode" == apply ]]; then
    [[ "${LEGACY_PREVIEW_APPLY_CONFIRMATION:-}" == "REMOVE_REVIEWED_LEGACY_PREVIEWS" ]] || { echo 'LEGACY_PREVIEW_RESULT=CONFIRMATION_REQUIRED'; exit 1; }
    # Revalidation above is immediately adjacent to deletion. Volumes are never removed.
    docker container rm "${containers[@]}"
    docker network rm "${networks[@]}"
  fi
done < <(tail -n +2 "$manifest")
echo "LEGACY_PREVIEW_RESULT=PASS mode=$mode volumes_removed=0"
