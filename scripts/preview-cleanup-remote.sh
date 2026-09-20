#!/usr/bin/env bash
set -euo pipefail

: "${PR_NUMBER:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_TOKEN:?}" "${CLEANUP_SCRIPT:?}"
PREVIEW_PROVENANCE_DIR=${PREVIEW_PROVENANCE_DIR:-/var/www/preview-provenance}
PREVIEW_ROOT=${PREVIEW_ROOT:-/var/www/preview}
NGINX_SITES_DIR=${NGINX_SITES_DIR:-/etc/nginx}
projects_file="$(mktemp)"
trap 'rm -f "$projects_file"; rm -rf "$(dirname "$(dirname "$CLEANUP_SCRIPT")")"' EXIT

# Consume every producer completely. `head -n 1` made docker receive SIGPIPE
# when a project owned enough containers/networks to fill the pipe buffer.
first_line() { awk 'NR == 1 { first=$0 } END { if (NR) print first }'; }

docker ps -a --filter "label=com.gesto.preview=true" --filter "label=com.gesto.preview.pr=${PR_NUMBER}" --format '{{.Label "com.docker.compose.project"}}' >> "$projects_file"
docker network ls --filter "label=com.gesto.preview=true" --filter "label=com.gesto.preview.pr=${PR_NUMBER}" --format '{{.Label "com.docker.compose.project"}}' >> "$projects_file"
docker volume ls --filter "label=com.gesto.preview=true" --filter "label=com.gesto.preview.pr=${PR_NUMBER}" --format '{{.Label "com.docker.compose.project"}}' >> "$projects_file"
if [ -d "$PREVIEW_PROVENANCE_DIR" ]; then
  find "$PREVIEW_PROVENANCE_DIR" -maxdepth 1 -type f -name "gesto-pr-${PR_NUMBER}-*.json" -printf '%f\n' |
    sed 's/\.json$//' >> "$projects_file"
fi
sort -u "$projects_file" -o "$projects_file"

preserved_projects=0
unexpected_errors=0

while IFS= read -r project; do
  [ -n "$project" ] || continue
  case "$project" in "gesto-pr-${PR_NUMBER}-"*) ;; *) echo 'PREVIEW_ORPHAN_SCOPE=REJECTED_PROJECT'; exit 1;; esac
  owner_id="$(docker ps -aq --filter "label=com.docker.compose.project=${project}" | first_line)"
  manifest_path="${PREVIEW_PROVENANCE_DIR}/${project}.json"
  manifest_facts="$(node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1]));if(m.format!==1||m.project!==process.argv[2]||!Array.isArray(m.images)||m.images.length!==2)process.exit(1);const v=m.images.map(x=>x.labels||{});for(const k of ["pr","run-id","run-attempt","workflow","commit"]){if(!v[0][k]||v.some(x=>x[k]!==v[0][k]))process.exit(1)}process.stdout.write([v[0].pr,v[0]["run-id"],v[0]["run-attempt"],v[0].workflow,v[0].commit].join("\t"))' "$manifest_path" "$project")"
  IFS=$'\t' read -r manifest_pr manifest_run manifest_attempt manifest_workflow owner_commit <<<"$manifest_facts"
  if [ -n "$owner_id" ]; then
    owner_pr="$(docker inspect -f '{{ index .Config.Labels "com.gesto.preview.pr" }}' "$owner_id")"
    owner_run="$(docker inspect -f '{{ index .Config.Labels "com.gesto.preview.run-id" }}' "$owner_id")"
    owner_attempt="$(docker inspect -f '{{ index .Config.Labels "com.gesto.preview.run-attempt" }}' "$owner_id")"
    owner_workflow="$(docker inspect -f '{{ index .Config.Labels "com.gesto.preview.workflow" }}' "$owner_id")"
  elif network_id="$(docker network ls -q --filter "label=com.docker.compose.project=${project}" | first_line)" && [ -n "$network_id" ]; then
    owner_pr="$(docker network inspect -f '{{ index .Labels "com.gesto.preview.pr" }}' "$network_id")"
    owner_run="$(docker network inspect -f '{{ index .Labels "com.gesto.preview.run-id" }}' "$network_id")"
    owner_attempt="$(docker network inspect -f '{{ index .Labels "com.gesto.preview.run-attempt" }}' "$network_id")"
    owner_workflow="$(docker network inspect -f '{{ index .Labels "com.gesto.preview.workflow" }}' "$network_id")"
  else
    owner_pr=$manifest_pr owner_run=$manifest_run owner_attempt=$manifest_attempt owner_workflow=$manifest_workflow
  fi
  diverged=0
  for identity_field in pr run_id run_attempt workflow; do
    case "$identity_field" in
      pr) observed=$owner_pr expected=$manifest_pr ;;
      run_id) observed=$owner_run expected=$manifest_run ;;
      run_attempt) observed=$owner_attempt expected=$manifest_attempt ;;
      workflow) observed=$owner_workflow expected=$manifest_workflow ;;
    esac
    if [ "$observed" != "$expected" ]; then
      echo "PREVIEW_IMAGE_RESULT=PRESERVED reason=runtime_manifest_identity_diverged field=${identity_field}"
      preserved_projects=$((preserved_projects + 1))
      diverged=1
      break
    fi
  done
  if [ "$diverged" -eq 1 ]; then
    echo "PREVIEW_PROJECT_CLEANUP=PRESERVED project=${project}"
    continue
  fi
  if [ "$owner_pr" != "$PR_NUMBER" ] || [ "$owner_workflow" != "Preview-Deploy" ]; then
    echo "PREVIEW_IMAGE_RESULT=PRESERVED reason=owner_pr_or_workflow_mismatch project=${project}"
    preserved_projects=$((preserved_projects + 1))
    echo "PREVIEW_PROJECT_CLEANUP=PRESERVED project=${project}"
    continue
  fi
  run_facts="$(curl -fsS -H "Authorization: Bearer ${GITHUB_TOKEN}" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${owner_run}/attempts/${owner_attempt}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(typeof x.status!=="string"||!Number.isSafeInteger(x.run_attempt))process.exit(1);process.stdout.write(`${x.status}\t${x.run_attempt}`)})')"
  IFS=$'\t' read -r run_status authenticated_attempt <<<"$run_facts"
  if [ "$run_status" != "completed" ]; then
    echo "PREVIEW_IMAGE_RESULT=PRESERVED reason=run_status_not_completed project=${project}"
    preserved_projects=$((preserved_projects + 1))
    echo "PREVIEW_PROJECT_CLEANUP=PRESERVED project=${project}"
    continue
  fi
  if [ "$authenticated_attempt" != "$owner_attempt" ]; then
    echo "PREVIEW_IMAGE_RESULT=PRESERVED reason=authenticated_run_identity_diverged field=run_attempt pr=${owner_pr} run_id=${owner_run} expected=${owner_attempt} observed=${authenticated_attempt}"
    preserved_projects=$((preserved_projects + 1))
    echo "PREVIEW_PROJECT_CLEANUP=PRESERVED project=${project}"
    continue
  fi
  # The image commit is the PR head checked out by preview.yml. A pull_request
  # run's head_sha is a distinct workflow-run revision and must not overwrite it.
  if [ -n "${owner_commit:-}" ]; then export EXPECTED_PREVIEW_SHA="$owner_commit"; fi
  export PREVIEW_OWNER_PR="$owner_pr" PREVIEW_OWNER_RUN_ID="$owner_run" PREVIEW_OWNER_RUN_ATTEMPT="$owner_attempt"
  export PREVIEW_OWNER_WORKFLOW="$owner_workflow" COMPOSE_PROJECT_NAME="$project"
  preview_dir="${PREVIEW_ROOT}/pr-${PR_NUMBER}/${project}"
  # Authenticate ownership and immutable image facts before the first teardown
  # mutation. Cleanup repeats every check after teardown immediately before rm.
  auth_output="$(mktemp)"
  auth_rc=0
  node "$CLEANUP_SCRIPT" authorize "$manifest_path" >"$auth_output" 2>&1 || auth_rc=$?
  auth_msg="$(cat "$auth_output")"
  rm -f "$auth_output"
  if [ -n "$auth_msg" ]; then
    printf '%s\n' "$auth_msg"
  fi
  if [ "$auth_rc" -ne 0 ]; then
    if echo "$auth_msg" | grep -Eq 'reason=(producer_run_not_|pr_not_closed|authenticated_run_identity_diverged|container_reference_|production_container_reference|rollback_or_recovery_|concurrent_run_|references_diverged_|protected_tag_|manifest_|project_invalid|numeric_identity_invalid|identity_)'; then
      echo "PREVIEW_PROJECT_CLEANUP=PRESERVED project=${project}"
      preserved_projects=$((preserved_projects + 1))
    else
      echo "PREVIEW_PROJECT_CLEANUP=ERROR project=${project} reason=unexpected_authorization_failure"
      unexpected_errors=$((unexpected_errors + 1))
    fi
    continue
  fi

  resource_count=$(( $(docker ps -aq --filter "label=com.docker.compose.project=${project}" | wc -l) + $(docker network ls -q --filter "label=com.docker.compose.project=${project}" | wc -l) + $(docker volume ls -q --filter "label=com.docker.compose.project=${project}" | wc -l) ))
  if [ "$resource_count" -eq 0 ]; then
    echo "PREVIEW_RESOURCE_CLEANUP=ALREADY_ABSENT project=${project}"
  elif [ -f "$preview_dir/docker-compose.yml" ] && [ -f "$preview_dir/docker-compose.preview.yml" ]; then
    (cd "$preview_dir" && docker compose -p "$project" -f docker-compose.yml -f docker-compose.preview.yml down -v --remove-orphans)
  else
    echo "PREVIEW_ORPHAN_CLEANUP=PRESERVED reason=trusted_compose_files_missing project=${project}"
    preserved_projects=$((preserved_projects + 1))
    echo "PREVIEW_PROJECT_CLEANUP=PRESERVED project=${project}"
    continue
  fi
  node "$CLEANUP_SCRIPT" cleanup "$manifest_path"
  rm -rf "$preview_dir"
  echo "PREVIEW_ORPHAN_CLEANUP=PASS project=${project}"
done < "$projects_file"

remaining_resources=$(( $(docker ps -aq --filter "label=com.gesto.preview.pr=${PR_NUMBER}" | wc -l) + $(docker network ls -q --filter "label=com.gesto.preview.pr=${PR_NUMBER}" | wc -l) + $(docker volume ls -q --filter "label=com.gesto.preview.pr=${PR_NUMBER}" | wc -l) ))
if [ "$remaining_resources" -gt 0 ] || [ "$preserved_projects" -gt 0 ]; then
  echo "PREVIEW_NGINX_ROUTE=PRESERVED reason=active_preview_resources_remain pr=${PR_NUMBER}"
else
  echo "PREVIEW_NGINX_ROUTE=REMOVED pr=${PR_NUMBER}"
  sudo rm -f "${NGINX_SITES_DIR}/sites-enabled/crm-preview-pr-${PR_NUMBER}" "${NGINX_SITES_DIR}/sites-available/crm-preview-pr-${PR_NUMBER}"
  sudo nginx -t
  sudo systemctl reload nginx
fi

if [ "$unexpected_errors" -gt 0 ]; then
  echo "PREVIEW_CLEANUP_RESULT=FAIL reason=unexpected_system_errors count=${unexpected_errors}"
  exit 1
fi
