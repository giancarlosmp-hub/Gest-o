#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
RUNTIME=sha256:$(printf 'a%.0s' {1..64}); CONFIG=sha256:$(printf 'b%.0s' {1..64}); OTHER=sha256:$(printf 'c%.0s' {1..64})
cat >"$TMP/docker" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == 'image inspect' ]] || exit 90
ref=${!#}
if [[ "${4:-}" == '{{.Id}}' ]]; then
  case "$SCENARIO:$ref" in direct:sha256:a*) printf '%s\n' "$RUNTIME";; linked:gest-o-api:old) printf '%s\n' "$CONFIG";; *) exit 1;; esac
  exit
fi
case "$SCENARIO:$ref" in
 direct:sha256:a*) printf '%s\n' "$RUNTIME";;
 linked:sha256:a*) exit 1;;
 linked:gest-o-api:old) printf '%s\n%s\n' "$CONFIG" "$RUNTIME";;
 wrong:sha256:a*) exit 1;;
 wrong:gest-o-api:old) printf '%s\n' "$OTHER";;
 divergent:sha256:a*) exit 1;;
 divergent:gest-o-api:old) printf '%s\n' "$OTHER";; # same Git label is intentionally irrelevant
 *) exit 1;;
esac
EOF
chmod +x "$TMP/docker"
export PATH="$TMP:$PATH" RUNTIME CONFIG OTHER
# shellcheck source=scripts/lib/production-rollback-image.sh
source "$ROOT/scripts/lib/production-rollback-image.sh"
SCENARIO=direct; export SCENARIO
resolve_rollback_image api "$RUNTIME" gest-o-api:old
[[ "$ROLLBACK_RESOLUTION_METHOD:$ROLLBACK_ARTIFACT_ID" == "runtime-identity:$RUNTIME" ]]
SCENARIO=linked; export SCENARIO
resolve_rollback_image api "$RUNTIME" gest-o-api:old
[[ "$ROLLBACK_RESOLUTION_METHOD:$ROLLBACK_ARTIFACT_ID" == "config-reference-oci-link:$CONFIG" ]]
for SCENARIO in wrong divergent missing; do
  export SCENARIO
  ! resolve_rollback_image api "$RUNTIME" gest-o-api:old
  [[ "$ROLLBACK_BLOCK_REASON" == *'nenhuma imagem local demonstra vínculo criptográfico'* ]]
done
printf 'production rollback image identity safety passed\n'
