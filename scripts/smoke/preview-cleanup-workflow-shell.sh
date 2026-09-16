#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/provenance" "$tmp/preview/pr-42" "$tmp/nginx/sites-enabled" "$tmp/nginx/sites-available" "$tmp/copied/scripts"
for project in gesto-pr-42-100-1 gesto-pr-42-101-1; do
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
  printf '%s\n' gesto-pr-42-100-1 gesto-pr-42-101-1; exit
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
    *preview.run-attempt*) printf '1\n';;
    *preview.workflow*) printf 'Preview-Deploy\n';;
  esac
  exit
fi
if [[ $1 == network && $2 == ls ]]; then exit; fi
if [[ $1 == volume && $2 == ls ]]; then exit; fi
if [[ $1 == compose ]]; then exit; fi
echo "unexpected docker command: $*" >&2; exit 2
SH
cat >"$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '{"status":"completed","head_sha":"%040d"}\n' 0
SH
cat >"$tmp/bin/node" <<'SH'
#!/usr/bin/env bash
if [[ $1 == -e && $# -gt 2 ]]; then
  project=${4:-}; run=${project#gesto-pr-42-}; run=${run%-1}
  printf '42\t%s\t1\tPreview-Deploy\t%040d' "$run" 0
elif [[ $1 == -e ]]; then
  cat | sed -n 's/.*"status":"\([^"]*\)".*/\1/p'
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
for run in 100 101 102; do
  printf '{"format":1,"project":"gesto-pr-42-%s-1","images":[{"labels":{"pr":"42","run-id":"%s","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}},{"labels":{"pr":"42","run-id":"%s","run-attempt":"1","workflow":"Preview-Deploy","commit":"0000000000000000000000000000000000000000"}}]}\n' "$run" "$run" "$run" >"$tmp/provenance/gesto-pr-42-$run-1.json"
done

if ! PATH="$tmp/bin:$PATH" PR_NUMBER=42 GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=synthetic \
  CLEANUP_SCRIPT="$tmp/copied/scripts/lifecycle.mjs" PREVIEW_PROVENANCE_DIR="$tmp/provenance" \
  PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
  bash "$tmp/copied/scripts/runner.sh" >"$tmp/out" 2>"$tmp/err"; then
  cat "$tmp/out" "$tmp/err" >&2
  exit 1
fi
grep -Fq 'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-100-1' "$tmp/out"
grep -Fq 'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-101-1' "$tmp/out"
grep -Fq 'PREVIEW_RESOURCE_CLEANUP=ALREADY_ABSENT project=gesto-pr-42-102-1' "$tmp/out"
grep -Fq 'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-102-1' "$tmp/out"
grep -Fq NGINX_RELOAD=PASS "$tmp/out"
echo 'PREVIEW_CLEANUP_WORKFLOW_SHELL=PASS legacy_head_exit=141 projects=3 large_output_lines=20000 manifest_without_runtime=PASS'
