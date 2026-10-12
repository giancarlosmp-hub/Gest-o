#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/provenance" "$tmp/preview/pr-42" "$tmp/nginx/sites-enabled" "$tmp/nginx/sites-available" "$tmp/copied/scripts"
for project in gesto-pr-42-100-1 gesto-pr-42-100-2 gesto-pr-42-101-1; do
  mkdir -p "$tmp/preview/pr-42/$project"
  : >"$tmp/preview/pr-42/$project/docker-compose.yml"
  : >"$tmp/preview/pr-42/$project/docker-compose.preview.yml"
done
cp "$root/scripts/preview-cleanup-remote.sh" "$tmp/copied/scripts/runner.sh"
: >"$tmp/copied/scripts/lifecycle.mjs"
write_env() { # gesto-pr-42-<run>-<attempt> [volume]
  local rest=${1#gesto-pr-42-}
  printf 'COMPOSE_PROJECT_NAME=%s\nPOSTGRES_VOLUME_NAME=%s\n' "$1" "${2:-gesto_pgdata_pr_42_${rest%-*}_${rest##*-}}" >"$tmp/preview/pr-42/$1/.env"
}
for project in gesto-pr-42-100-1 gesto-pr-42-100-2 gesto-pr-42-101-1; do write_env "$project"; done

cat >"$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ $1 == ps && $2 == -a && "$*" == *'com.gesto.preview=true'* ]]; then
  printf '%s\n' ${FAKE_DISCOVERY_PROJECTS:-gesto-pr-42-100-1 gesto-pr-42-100-2 gesto-pr-42-101-1}; exit
fi
if [[ $1 == network && $2 == ls && "$*" == *'com.gesto.preview=true'* ]]; then exit; fi
if [[ $1 == volume && $2 == ls && "$*" == *'com.gesto.preview=true'* ]]; then exit; fi
if [[ $1 == ps && $2 == -aq ]]; then
  # Output well beyond a pipe buffer: a head consumer reliably kills this
  # producer with SIGPIPE. The real runner must consume all of it.
  if [[ "$*" == *'label=com.docker.compose.project='* ]]; then
    project=${*: -1}; project=${project##*=}
    [[ $project != gesto-pr-42-102-1 ]] || exit 0
    for i in $(seq 1 20000); do printf '%s-container-%05d\n' "$project" "$i"; done
    exit
  fi
  exit 0
fi
if [[ $1 == inspect ]]; then
  case "$*" in
    *preview.pr*) printf '42\n';;
    *preview.run-id*) [[ ${*: -1} == *100* ]] && printf '100\n' || printf '101\n';;
    *preview.run-attempt*) [[ ${*: -1} == *-2-container* ]] && printf '2\n' || printf '1\n';;
    *preview.workflow*) printf 'Preview-Deploy\n';;
  esac
  exit
fi
if [[ $1 == network && $2 == ls ]]; then exit; fi
if [[ $1 == volume && $2 == ls ]]; then exit; fi
if [[ $1 == compose ]]; then
  base=$(cd "$(dirname "$0")/.." && pwd)
  volume=${POSTGRES_VOLUME_NAME:-}
  if [[ -z $volume && -f .env ]]; then volume=$(sed -n 's/^POSTGRES_VOLUME_NAME=//p' .env); fi
  printf 'compose %s volume=%s secret=%s\n' "$3" "${volume:-gest-o_pgdata}" "${ADMIN_BOOTSTRAP_PASSWORD:-}" >>"$base/mutations"
  exit
fi
echo "unexpected docker command: $*" >&2; exit 2
SH
cat >"$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url=${*: -1}; attempt=${url##*/}; attempt=$((attempt + ${FAKE_API_ATTEMPT_OFFSET:-0}))
printf '{"status":"completed","run_attempt":%s,"head_sha":"%040d"}\n' "$attempt" 0
SH
cat >"$tmp/bin/node" <<'SH'
#!/usr/bin/env bash
if [[ $1 == -e && $# -gt 2 ]]; then
  project=${4:-}; run=${project#gesto-pr-42-}; run=${run%-*}; attempt=${project##*-}
  printf '42\t%s\t%s\tPreview-Deploy\t%040d' "$run" "$attempt" 0
elif [[ $1 == -e ]]; then
  payload=$(cat)
  status=$(printf '%s' "$payload" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  attempt=$(printf '%s' "$payload" | sed -n 's/.*"run_attempt":\([0-9][0-9]*\).*/\1/p')
  printf '%s\t%s' "$status" "$attempt"
elif [[ "$*" == *"gesto-pr-42-100-1"* && "$*" == *"authorize"* && "${FAKE_MODE:-}" == "unsuccessful" ]]; then
  echo "PREVIEW_IMAGE_RESULT=PRESERVED reason=producer_run_not_successful"
  exit 1
elif [[ "$*" == *"gesto-pr-42-100-1"* && "$*" == *"authorize"* && "${FAKE_MODE:-}" == "run_pr_missing" ]]; then
  echo "PREVIEW_IMAGE_RESULT=PRESERVED reason=run_pr_correlation_missing"
  exit 1
elif [[ "$*" == *"gesto-pr-42-100-1"* && "$*" == *"authorize"* && "${FAKE_MODE:-}" == "commit_not_in_pr" ]]; then
  echo "PREVIEW_IMAGE_RESULT=PRESERVED reason=pr_commit_not_in_pull_request pr=42 run_id=100"
  exit 1
elif [[ "$*" == *"gesto-pr-42-100-1"* && "$*" == *"authorize"* && "${FAKE_MODE:-}" == "unexpected_fail" ]]; then
  echo "PREVIEW_IMAGE_RESULT=PRESERVED reason=github_query_failed_500"
  exit 1
else
  printf 'LIFECYCLE_CALLED=%s\n' "$(basename "$3")"
fi
SH
cat >"$tmp/bin/sudo" <<'SH'
#!/usr/bin/env bash
"$@"
SH
cat >"$tmp/bin/nginx" <<'SH'
#!/usr/bin/env bash
echo NGINX_TEST=PASS
SH
cat >"$tmp/bin/systemctl" <<'SH'
#!/usr/bin/env bash
echo NGINX_RELOAD=PASS
SH
chmod +x "$tmp/bin/"*

# Reproduce the removed command before exercising the correction. This is
# disposable fake output and does not contact a Docker daemon.
set +e
set -o pipefail
PATH="$tmp/bin:$PATH" docker ps -aq --filter label=com.docker.compose.project=gesto-pr-42-100-1 | head -n 1 >/dev/null
legacy_rc=$?
set -e
test "$legacy_rc" -eq 141

# Every project has immutable provenance; 102 proves discovery after runtime vanished.
for producer in 100:1 100:2 101:1 102:1; do
  run=${producer%:*}; attempt=${producer#*:}
  printf '{"format":1,"project":"gesto-pr-42-%s-%s","images":[{"labels":{"pr":"42","run-id":"%s","run-attempt":"%s","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"%s","run-attempt":"%s","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' "$run" "$attempt" "$run" "$attempt" "$run" "$attempt" >"$tmp/provenance/gesto-pr-42-$run-$attempt.json"
done

rm -f "$tmp/mutations"
if ! PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic \
  POSTGRES_VOLUME_NAME=gest-o_pgdata ADMIN_BOOTSTRAP_PASSWORD=synthetic-outer-secret \
  CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
  PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
  bash "$tmp/copied/scripts/runner.sh" >"$tmp/out" 2>"$tmp/err"; then
  cat "$tmp/out" "$tmp/err" >&2
  exit 1
fi
grep -Fq 'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-100-1' "$tmp/out"
grep -Fq 'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-100-2' "$tmp/out"
grep -Fq 'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-101-1' "$tmp/out"
grep -Fq 'PREVIEW_RESOURCE_CLEANUP=ALREADY_ABSENT project=gesto-pr-42-102-1' "$tmp/out"
grep -Fq 'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-102-1' "$tmp/out"
grep -Fq NGINX_RELOAD=PASS "$tmp/out"
grep -Fxq 'PREVIEW_CLEANUP_RESULT=PASS removed=4 preserved=0' "$tmp/out"
grep -Fxq 'compose gesto-pr-42-100-1 volume=gesto_pgdata_pr_42_100_1 secret=' "$tmp/mutations"
grep -Fxq 'compose gesto-pr-42-100-2 volume=gesto_pgdata_pr_42_100_2 secret=' "$tmp/mutations"
grep -Fxq 'compose gesto-pr-42-101-1 volume=gesto_pgdata_pr_42_101_1 secret=' "$tmp/mutations"
test "$(grep -c '^compose ' "$tmp/mutations")" -eq 3
! grep -Eq 'volume=gest-o|secret=synthetic' "$tmp/mutations"

# A conflicting authenticated attempt must stop before compose down or any
# later nginx/image mutation. This uses only disposable fakes.
rm -f "$tmp/provenance"/*.json "$tmp/mutations"
mkdir -p "$tmp/copied/scripts"
cp "$root/scripts/preview-cleanup-remote.sh" "$tmp/copied/scripts/runner.sh"
: >"$tmp/copied/scripts/lifecycle.mjs"
mkdir -p "$tmp/preview/pr-42/gesto-pr-42-100-1"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.yml"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.preview.yml"
write_env "gesto-pr-42-100-1"
printf '{"format":1,"project":"gesto-pr-42-100-1","images":[{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' >"$tmp/provenance/gesto-pr-42-100-1.json"
set +e
PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic FAKE_DISCOVERY_PROJECTS=gesto-pr-42-100-1 FAKE_API_ATTEMPT_OFFSET=1 MUTATION_LOG="$tmp/mutations" \
  CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
  PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
  bash "$tmp/copied/scripts/runner.sh" >"$tmp/diverged.out" 2>"$tmp/diverged.err"
diverged_rc=$?
set -e
test "$diverged_rc" -eq 0
test ! -e "$tmp/mutations"
grep -Fq 'field=run_attempt pr=42 run_id=100 expected=1 observed=2' "$tmp/diverged.out"

# An unsuccessful producer candidate must be preserved without stopping valid candidates
# or preventing Nginx reload for the closed PR.
rm -f "$tmp/provenance"/*.json "$tmp/mutations"
mkdir -p "$tmp/copied/scripts" "$tmp/preview/pr-42/gesto-pr-42-100-1" "$tmp/preview/pr-42/gesto-pr-42-100-2"
cp "$root/scripts/preview-cleanup-remote.sh" "$tmp/copied/scripts/runner.sh"
: >"$tmp/copied/scripts/lifecycle.mjs"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.yml"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.preview.yml"
write_env "gesto-pr-42-100-1"
: >"$tmp/preview/pr-42/gesto-pr-42-100-2/docker-compose.yml"
: >"$tmp/preview/pr-42/gesto-pr-42-100-2/docker-compose.preview.yml"
write_env "gesto-pr-42-100-2"
printf '{"format":1,"project":"gesto-pr-42-100-1","images":[{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' >"$tmp/provenance/gesto-pr-42-100-1.json"
printf '{"format":1,"project":"gesto-pr-42-100-2","images":[{"labels":{"pr":"42","run-id":"100","run-attempt":"2","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"100","run-attempt":"2","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' >"$tmp/provenance/gesto-pr-42-100-2.json"

export FAKE_MODE="unsuccessful"
if ! PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic FAKE_DISCOVERY_PROJECTS="gesto-pr-42-100-1 gesto-pr-42-100-2" MUTATION_LOG="$tmp/mutations" \
  CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
  PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
  bash "$tmp/copied/scripts/runner.sh" >"$tmp/unsuccessful.out" 2>"$tmp/unsuccessful.err"; then
  cat "$tmp/unsuccessful.out" "$tmp/unsuccessful.err" >&2
  exit 1
fi
unset FAKE_MODE
grep -Fq 'PREVIEW_IMAGE_RESULT=PRESERVED reason=producer_run_not_successful' "$tmp/unsuccessful.out"
grep -Fq 'PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-42-100-1' "$tmp/unsuccessful.out"
grep -Fq 'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-100-2' "$tmp/unsuccessful.out"
grep -Fq 'PREVIEW_NGINX_ROUTE=PRESERVED reason=active_preview_resources_or_errors_remain pr=42' "$tmp/unsuccessful.out"
# 100-1 compose down was never invoked; only 100-2 was dismantled.
test "$(grep -c compose "$tmp/mutations")" -eq 1
grep -Fxq 'PREVIEW_CLEANUP_RESULT=PRESERVED removed=1 preserved=1' "$tmp/unsuccessful.out"

# A candidate preserved due to run_pr_correlation_missing must be preserved without Nginx route removal.
rm -f "$tmp/provenance"/*.json "$tmp/mutations"
mkdir -p "$tmp/copied/scripts" "$tmp/preview/pr-42/gesto-pr-42-100-1"
cp "$root/scripts/preview-cleanup-remote.sh" "$tmp/copied/scripts/runner.sh"
: >"$tmp/copied/scripts/lifecycle.mjs"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.yml"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.preview.yml"
write_env "gesto-pr-42-100-1"
printf '{"format":1,"project":"gesto-pr-42-100-1","images":[{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' >"$tmp/provenance/gesto-pr-42-100-1.json"

export FAKE_MODE="run_pr_missing"
if ! PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic FAKE_DISCOVERY_PROJECTS="gesto-pr-42-100-1" MUTATION_LOG="$tmp/mutations" \
  CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
  PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
  bash "$tmp/copied/scripts/runner.sh" >"$tmp/run_pr_missing.out" 2>"$tmp/run_pr_missing.err"; then
  cat "$tmp/run_pr_missing.out" "$tmp/run_pr_missing.err" >&2
  exit 1
fi
unset FAKE_MODE
grep -Fq 'PREVIEW_IMAGE_RESULT=PRESERVED reason=run_pr_correlation_missing' "$tmp/run_pr_missing.out"
grep -Fq 'PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-42-100-1' "$tmp/run_pr_missing.out"
grep -Fq 'PREVIEW_NGINX_ROUTE=PRESERVED reason=active_preview_resources_or_errors_remain pr=42' "$tmp/run_pr_missing.out"

# An unexpected infrastructure failure must not be hidden in a success result.
rm -f "$tmp/provenance"/*.json "$tmp/mutations"
mkdir -p "$tmp/copied/scripts" "$tmp/preview/pr-42/gesto-pr-42-100-1"
cp "$root/scripts/preview-cleanup-remote.sh" "$tmp/copied/scripts/runner.sh"
: >"$tmp/copied/scripts/lifecycle.mjs"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.yml"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.preview.yml"
write_env "gesto-pr-42-100-1"
printf '{"format":1,"project":"gesto-pr-42-100-1","images":[{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' >"$tmp/provenance/gesto-pr-42-100-1.json"

set +e
export FAKE_MODE="unexpected_fail"
PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic FAKE_DISCOVERY_PROJECTS="gesto-pr-42-100-1" MUTATION_LOG="$tmp/mutations" \
  CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
  PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
  bash "$tmp/copied/scripts/runner.sh" >"$tmp/unexpected.out" 2>"$tmp/unexpected.err"
unexpected_rc=$?
set -e
test "$unexpected_rc" -ne 0
grep -Fq 'PREVIEW_PROJECT_CLEANUP=ERROR project=gesto-pr-42-100-1 reason=unexpected_authorization_failure' "$tmp/unexpected.out"
grep -Fq 'PREVIEW_CLEANUP_RESULT=FAIL reason=unexpected_system_errors count=1' "$tmp/unexpected.out"

# A commit that is no longer part of the PR history is preserved (yellow warning), not an
# unexpected error, and nothing is torn down for it.
rm -f "$tmp/provenance"/*.json "$tmp/mutations"
mkdir -p "$tmp/copied/scripts" "$tmp/preview/pr-42/gesto-pr-42-100-1"
cp "$root/scripts/preview-cleanup-remote.sh" "$tmp/copied/scripts/runner.sh"
: >"$tmp/copied/scripts/lifecycle.mjs"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.yml"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.preview.yml"
write_env "gesto-pr-42-100-1"
printf '{"format":1,"project":"gesto-pr-42-100-1","images":[{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' >"$tmp/provenance/gesto-pr-42-100-1.json"
export FAKE_MODE="commit_not_in_pr"
if ! PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic FAKE_DISCOVERY_PROJECTS="gesto-pr-42-100-1" MUTATION_LOG="$tmp/mutations" \
  CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
  PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
  bash "$tmp/copied/scripts/runner.sh" >"$tmp/not_in_pr.out" 2>"$tmp/not_in_pr.err"; then
  cat "$tmp/not_in_pr.out" "$tmp/not_in_pr.err" >&2
  exit 1
fi
unset FAKE_MODE
grep -Fq 'PREVIEW_IMAGE_RESULT=PRESERVED reason=pr_commit_not_in_pull_request' "$tmp/not_in_pr.out"
grep -Fq 'PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-42-100-1' "$tmp/not_in_pr.out"
grep -Fxq 'PREVIEW_CLEANUP_RESULT=PRESERVED removed=0 preserved=1' "$tmp/not_in_pr.out"
! grep -Fq 'PREVIEW_PROJECT_CLEANUP=ERROR' "$tmp/not_in_pr.out"
test ! -e "$tmp/mutations"

# Scope: whatever discovery returns, a project of another PR or of production makes the runner
# stop before any mutation (no compose down, no nginx change).
for foreign in gesto-pr-99-100-1 gest-o gest-o-production gesto-pr-420-100-1; do
  rm -f "$tmp/provenance"/*.json "$tmp/mutations" "$tmp/scope.out"
  mkdir -p "$tmp/copied/scripts"
  cp "$root/scripts/preview-cleanup-remote.sh" "$tmp/copied/scripts/runner.sh"
  : >"$tmp/copied/scripts/lifecycle.mjs"
  set +e
  PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic FAKE_DISCOVERY_PROJECTS="$foreign" MUTATION_LOG="$tmp/mutations" \
    CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
    PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
    bash "$tmp/copied/scripts/runner.sh" >"$tmp/scope.out" 2>&1
  scope_rc=$?
  set -e
  test "$scope_rc" -ne 0
  grep -Fxq 'PREVIEW_ORPHAN_SCOPE=REJECTED_PROJECT' "$tmp/scope.out"
  test ! -e "$tmp/mutations"
  ! grep -Eq 'NGINX_(TEST|RELOAD)=PASS|PREVIEW_ORPHAN_CLEANUP=PASS' "$tmp/scope.out"
done

# Unlabeled networks/containers (legacy previews, production) are never discovered: every
# discovery command filters by both the preview label and this PR's label.
runner_text=$(cat "$root/scripts/preview-cleanup-remote.sh")
discovery_lines=$(grep -E 'docker (ps -a|network ls|volume ls) --filter "label=com\.gesto\.preview=true"' "$root/scripts/preview-cleanup-remote.sh" | wc -l)
test "$discovery_lines" -eq 3
test "$(grep -Ec 'docker (ps -a|network ls|volume ls) --filter "label=com\.gesto\.preview=true" --filter "label=com\.gesto\.preview\.pr=\$\{PR_NUMBER\}"' "$root/scripts/preview-cleanup-remote.sh")" -eq 3
grep -Fq 'case "$project" in "gesto-pr-${PR_NUMBER}-"*) ;; *) echo '"'"'PREVIEW_ORPHAN_SCOPE=REJECTED_PROJECT'"'"'; exit 1;; esac' <<<"$runner_text"
! grep -Eq 'docker (system|network|volume|image|container) prune|network rm' <<<"$runner_text"

# Folder .env guard: without it, or pointing anywhere but this project's own volume, nothing is
# torn down and the project is preserved (yellow warning).
guard_case() { # reason [.env volume | "none" for no .env]
  rm -f "$tmp/provenance"/*.json "$tmp/mutations"
  rm -rf "$tmp/preview/pr-42/gesto-pr-42-100-1"
  mkdir -p "$tmp/copied/scripts" "$tmp/preview/pr-42/gesto-pr-42-100-1"
  cp "${GUARD_RUNNER:-$root/scripts/preview-cleanup-remote.sh}" "$tmp/copied/scripts/runner.sh"
  : >"$tmp/copied/scripts/lifecycle.mjs"
  : >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.yml"
  : >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.preview.yml"
  case "$2" in
    none) ;;
    double) write_env gesto-pr-42-100-1; printf 'POSTGRES_VOLUME_NAME=gest-o_pgdata\n' >>"$tmp/preview/pr-42/gesto-pr-42-100-1/.env";;
    *) write_env gesto-pr-42-100-1 "$2";;
  esac
  printf '{"format":1,"project":"gesto-pr-42-100-1","images":[{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' >"$tmp/provenance/gesto-pr-42-100-1.json"
  set +e
  PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic FAKE_DISCOVERY_PROJECTS="gesto-pr-42-100-1" \
    CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
    PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
    bash "$tmp/copied/scripts/runner.sh" >"$tmp/guard.out" 2>&1
  guard_rc=$?
  set -e
}
for spec in env_file_missing:none env_volume_mismatch:gest-o_pgdata env_volume_mismatch:gesto_pgdata_pr_42_101_1 env_volume_mismatch:double; do
  reason=${spec%%:*}; guard_case "$reason" "${spec#*:}"
  test "$guard_rc" -eq 0 || { cat "$tmp/guard.out" >&2; exit 1; }
  grep -Fxq "PREVIEW_ORPHAN_CLEANUP=PRESERVED reason=${reason} project=gesto-pr-42-100-1" "$tmp/guard.out"
  grep -Fxq 'PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-42-100-1' "$tmp/guard.out"
  grep -Fxq 'PREVIEW_CLEANUP_RESULT=PRESERVED removed=0 preserved=1' "$tmp/guard.out"
  test ! -e "$tmp/mutations"
  test -d "$tmp/preview/pr-42/gesto-pr-42-100-1"
done

# Mutation test: the same "no .env" case run against the old unguarded teardown targets the
# production volume gest-o_pgdata. The real runner above never did; this proves the check bites.
awk '/# volume-guard:begin/{print "    (cd \"$preview_dir\" && docker compose -p \"$project\" -f docker-compose.yml -f docker-compose.preview.yml down -v --remove-orphans)"; skip=1; next} /# volume-guard:end/{skip=0; next} !skip' \
  "$root/scripts/preview-cleanup-remote.sh" >"$tmp/unguarded-runner.sh"
! grep -Fq 'env -i' "$tmp/unguarded-runner.sh"
GUARD_RUNNER="$tmp/unguarded-runner.sh" guard_case env_file_missing none
grep -Fxq 'compose gesto-pr-42-100-1 volume=gest-o_pgdata secret=' "$tmp/mutations"

echo 'PREVIEW_CLEANUP_WORKFLOW_SHELL=PASS legacy_head_exit=141 projects=4 same_run_multiple_attempts=PASS manifest_without_runtime=PASS pre_teardown_failure_mutations=0 unsuccessful_producer_candidate_preserved=PASS nginx_route_authorization=PASS unexpected_error_reported=PASS final_marker=PASS commit_not_in_pr_preserved=PASS foreign_scope_rejected=PASS unlabeled_never_discovered=PASS env_guard=PASS clean_env=PASS unguarded_mutation_targets_production=DETECTED'
