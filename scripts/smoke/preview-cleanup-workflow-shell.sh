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
  project=${*: -1}; project=${project##*=}
  [[ $project != gesto-pr-42-102-1 ]] || exit 0
  for i in $(seq 1 20000); do printf '%s-container-%05d\n' "$project" "$i"; done
  exit
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
if [[ $1 == compose ]]; then [[ -z "${MUTATION_LOG:-}" ]] || printf 'compose\n' >>"$MUTATION_LOG"; exit; fi
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
elif [[ -n "${FAKE_UNSUCCESSFUL_PROJECT:-}" && "$*" == *"${FAKE_UNSUCCESSFUL_PROJECT}"* && "$*" == *"authorize"* ]]; then
  echo "PREVIEW_IMAGE_RESULT=PRESERVED reason=producer_run_not_successful" >&2
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

if ! PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic \
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

# A conflicting authenticated attempt must stop before compose down or any
# later nginx/image mutation. This uses only disposable fakes.
rm -f "$tmp/provenance"/*.json "$tmp/mutations"
mkdir -p "$tmp/copied/scripts"
cp "$root/scripts/preview-cleanup-remote.sh" "$tmp/copied/scripts/runner.sh"
: >"$tmp/copied/scripts/lifecycle.mjs"
mkdir -p "$tmp/preview/pr-42/gesto-pr-42-100-1"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.yml"
: >"$tmp/preview/pr-42/gesto-pr-42-100-1/docker-compose.preview.yml"
printf '{"format":1,"project":"gesto-pr-42-100-1","images":[{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' >"$tmp/provenance/gesto-pr-42-100-1.json"
set +e
PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic FAKE_DISCOVERY_PROJECTS=gesto-pr-42-100-1 FAKE_API_ATTEMPT_OFFSET=1 MUTATION_LOG="$tmp/mutations" \
  CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
  PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
  bash "$tmp/copied/scripts/runner.sh" >"$tmp/diverged.out" 2>"$tmp/diverged.err"
diverged_rc=$?
set -e
test "$diverged_rc" -ne 0
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
: >"$tmp/preview/pr-42/gesto-pr-42-100-2/docker-compose.yml"
: >"$tmp/preview/pr-42/gesto-pr-42-100-2/docker-compose.preview.yml"
printf '{"format":1,"project":"gesto-pr-42-100-1","images":[{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"100","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' >"$tmp/provenance/gesto-pr-42-100-1.json"
printf '{"format":1,"project":"gesto-pr-42-100-2","images":[{"labels":{"pr":"42","run-id":"100","run-attempt":"2","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"100","run-attempt":"2","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' >"$tmp/provenance/gesto-pr-42-100-2.json"

if ! PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic FAKE_DISCOVERY_PROJECTS="gesto-pr-42-100-1 gesto-pr-42-100-2" FAKE_UNSUCCESSFUL_PROJECT="gesto-pr-42-100-1" MUTATION_LOG="$tmp/mutations" \
  CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
  PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
  bash "$tmp/copied/scripts/runner.sh" >"$tmp/unsuccessful.out" 2>"$tmp/unsuccessful.err"; then
  cat "$tmp/unsuccessful.out" "$tmp/unsuccessful.err" >&2
  exit 1
fi
grep -Fq 'PREVIEW_IMAGE_RESULT=PRESERVED reason=producer_run_not_successful' "$tmp/unsuccessful.err"
grep -Fq 'PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-42-100-1' "$tmp/unsuccessful.out"
grep -Fq 'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-100-2' "$tmp/unsuccessful.out"
grep -Fq NGINX_RELOAD=PASS "$tmp/unsuccessful.out"
# 100-1 compose down was never invoked; only 100-2 was dismantled.
test "$(grep -c compose "$tmp/mutations")" -eq 1

echo 'PREVIEW_CLEANUP_WORKFLOW_SHELL=PASS legacy_head_exit=141 projects=4 same_run_multiple_attempts=PASS manifest_without_runtime=PASS pre_teardown_failure_mutations=0 unsuccessful_producer_candidate_preserved=PASS'
