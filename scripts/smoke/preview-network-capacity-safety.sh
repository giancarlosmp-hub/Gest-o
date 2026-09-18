#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat >"$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$DOCKER_CALLS"
if [[ $1 == network && $2 == create ]]; then
  if [[ ${FAKE_NETWORK_MODE:-ok} == exhausted ]]; then echo 'all predefined address pools have been fully subnetted' >&2; exit 1; fi
  printf '%064d\n' 1; exit
fi
if [[ $1 == network && $2 == inspect ]]; then printf '%064d true 100 0\n' 1; exit; fi
if [[ $1 == network && $2 == rm ]]; then exit; fi
exit 2
SH
chmod +x "$tmp/bin/docker"
common=(PREVIEW_OWNER_PR=877 PREVIEW_OWNER_RUN_ID=100 PREVIEW_OWNER_RUN_ATTEMPT=3 PREVIEW_OWNER_WORKFLOW=Preview-Deploy DOCKER_CALLS="$tmp/calls")
env PATH="$tmp/bin:$PATH" "${common[@]}" bash "$root/scripts/preview-network-capacity-preflight.sh" >"$tmp/out"
grep -Fqx 'PREVIEW_NETWORK_CAPACITY=PASS probe=isolated_bridge' "$tmp/out"
grep -Eq '^network create .*com.gesto.preview.run-attempt=3' "$tmp/calls"
grep -Eq '^network inspect ' "$tmp/calls"
grep -Eq '^network rm [a-f0-9]{64}$' "$tmp/calls"
: >"$tmp/calls"
set +e
env PATH="$tmp/bin:$PATH" "${common[@]}" FAKE_NETWORK_MODE=exhausted bash "$root/scripts/preview-network-capacity-preflight.sh" >"$tmp/fail.out" 2>"$tmp/fail.err"
rc=$?
set -e
test "$rc" -ne 0
grep -Fqx 'PREVIEW_NETWORK_CAPACITY=FAIL reason=predefined_address_pools_exhausted' "$tmp/fail.err"
! grep -Eq '^network rm ' "$tmp/calls"
echo 'PREVIEW_NETWORK_CAPACITY_SAFETY=PASS success_cleanup=exact exhausted=fail_closed generic_cleanup=absent'
