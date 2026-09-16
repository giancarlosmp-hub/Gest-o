#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only verifier for legacy Compose projects. Legacy resources do not carry
# an independently verifiable PR/run identity, so deletion is deliberately not
# implemented. This script never calls any Docker mutating command.
mode=${1:-inventory}; manifest=${2:-}
[[ "$mode" == inventory || "$mode" == apply ]] || { echo 'LEGACY_PREVIEW_RESULT=INVALID_MODE'; exit 2; }
[[ -r "$manifest" ]] || { echo 'LEGACY_PREVIEW_RESULT=MANIFEST_REQUIRED'; exit 2; }
header=$'project\tpr\tcontainer_ids\tnetwork_ids'
[[ "$(head -n1 "$manifest")" == "$header" ]] || { echo 'LEGACY_PREVIEW_RESULT=INVALID_HEADER'; exit 2; }

rows=$(awk 'NR>1 && NF {n++} END {print n+0}' "$manifest")
if [[ "$mode" == apply ]]; then
  [[ "$rows" == 1 ]] || { echo 'LEGACY_PREVIEW_RESULT=APPLY_SINGLE_PROJECT_REQUIRED'; exit 1; }
  echo 'LEGACY_PREVIEW_RESULT=APPLY_DISABLED'
  echo 'PR_STATE=NOT_PROVEN reason=legacy_resources_have_no_independent_pr_run_ownership'
  exit 1
fi
(( rows > 0 )) || { echo 'LEGACY_PREVIEW_RESULT=EMPTY_MANIFEST'; exit 1; }

canonical_csv() {
  tr ',' '\n' | sed '/^$/d' | LC_ALL=C sort -u | paste -sd, -
}

while IFS=$'\t' read -r project pr container_csv network_csv extra; do
  [[ -z "${extra:-}" && "$project" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ && "$pr" =~ ^[0-9]+$ ]] || { echo 'LEGACY_PREVIEW_RESULT=INVALID_ROW'; exit 1; }
  [[ -n "$container_csv" && -n "$network_csv" ]] || { echo 'LEGACY_PREVIEW_RESULT=INSUFFICIENT_EVIDENCE'; exit 1; }
  expected_containers=$(printf '%s' "$container_csv" | canonical_csv)
  expected_networks=$(printf '%s' "$network_csv" | canonical_csv)
  [[ "$(printf '%s' "$container_csv" | tr ',' '\n' | sed '/^$/d' | wc -l)" == "$(printf '%s' "$expected_containers" | tr ',' '\n' | wc -l)" ]] || { echo 'LEGACY_PREVIEW_RESULT=DUPLICATE_RESOURCE'; exit 1; }
  [[ "$(printf '%s' "$network_csv" | tr ',' '\n' | sed '/^$/d' | wc -l)" == "$(printf '%s' "$expected_networks" | tr ',' '\n' | wc -l)" ]] || { echo 'LEGACY_PREVIEW_RESULT=DUPLICATE_RESOURCE'; exit 1; }

  actual_containers=$(docker ps -aq --no-trunc --filter "label=com.docker.compose.project=$project" | LC_ALL=C sort -u | paste -sd, -)
  actual_networks=$(docker network ls -q --no-trunc --filter "label=com.docker.compose.project=$project" | LC_ALL=C sort -u | paste -sd, -)
  [[ "$actual_containers" == "$expected_containers" && "$actual_networks" == "$expected_networks" ]] || { echo 'LEGACY_PREVIEW_RESULT=PROJECT_SET_DIVERGED'; exit 1; }

  IFS=, read -ra containers <<<"$expected_containers"; IFS=, read -ra networks <<<"$expected_networks"
  network_names=()
  for id in "${networks[@]}"; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || { echo 'LEGACY_PREVIEW_RESULT=FULL_ID_REQUIRED'; exit 1; }
    facts=$(docker network inspect -f '{{.Id}}{{"\t"}}{{.Name}}{{"\t"}}{{index .Labels "com.docker.compose.project"}}' "$id")
    IFS=$'\t' read -r observed_id network_name observed_project <<<"$facts"
    [[ "$observed_id" == "$id" && -n "$network_name" && "$observed_project" == "$project" ]] || { echo 'LEGACY_PREVIEW_RESULT=IDENTITY_DIVERGED'; exit 1; }
    network_names+=("$network_name")
  done
  expected_network_names=$(printf '%s\n' "${network_names[@]}" | LC_ALL=C sort -u | paste -sd, -)
  for id in "${containers[@]}"; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || { echo 'LEGACY_PREVIEW_RESULT=FULL_ID_REQUIRED'; exit 1; }
    facts=$(docker container inspect -f '{{.Id}}{{"\t"}}{{.Name}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project"}}{{"\t"}}{{.State.Status}}' "$id")
    IFS=$'\t' read -r observed_id name observed_project state <<<"$facts"
    [[ "$observed_id" == "$id" && "$observed_project" == "$project" && "$name" == /* && -n "$state" ]] || { echo 'LEGACY_PREVIEW_RESULT=IDENTITY_DIVERGED'; exit 1; }
    case "${name#/}" in
      gest-o-production-api-1|gest-o-production-web-1|gest-o-db-clean-v2-20260717) echo 'LEGACY_PREVIEW_RESULT=PRODUCTION_CONTAINER_PROTECTED'; exit 1;;
    esac
    mounts=$(docker container inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' "$id")
    if printf '%s\n' "$mounts" | grep -Fxq -e gest-o_pgdata -e gest-o_pgdata_clean_v2_20260717; then echo 'LEGACY_PREVIEW_RESULT=PROTECTED_VOLUME'; exit 1; fi
    attached=$(docker container inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' "$id" | sed '/^$/d' | LC_ALL=C sort -u | paste -sd, -)
    [[ -n "$attached" && "$attached" == "$expected_network_names" ]] || { echo 'LEGACY_PREVIEW_RESULT=TOPOLOGY_DIVERGED'; exit 1; }
  done
  echo "LEGACY_PREVIEW_INVENTORY=PASS project=$project containers=${#containers[@]} networks=${#networks[@]}"
  echo "PR_STATE=NOT_PROVEN declared_pr=$pr"
done < <(tail -n +2 "$manifest")
echo 'LEGACY_PREVIEW_RESULT=PASS mode=inventory mutations=0'
