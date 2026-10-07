#!/usr/bin/env bash
# Opt-in check of the release artifact cycle against a real Docker engine with
# the containerd image store (npm run test:production-release:docker).
# Exit 77 = skipped (no engine, classic image store or base image absent).
# Creates only objects named gesto-relprobe-<pid> plus release tags of the image
# it builds itself, and removes them on exit.  Never pulls: the base image must
# already be local (PRODUCTION_RELEASE_DOCKER_BASE, default busybox:1.36).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
skip(){ printf 'PRODUCTION_RELEASE_DOCKER=SKIP reason=%s\n' "$1"; exit 77; }
if ! { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }; then skip docker_unavailable; fi
[[ "$(docker info -f '{{json .DriverStatus}}')" == *io.containerd.snapshotter.v1* ]] || skip classic_image_store
BASE=${PRODUCTION_RELEASE_DOCKER_BASE:-busybox:1.36}
docker image inspect "$BASE" >/dev/null 2>&1 || skip "base_image_absent:$BASE"
docker compose version >/dev/null 2>&1 || skip compose_unavailable

P="gesto-relprobe-$$"; TMP="$(mktemp -d)"; ID=''
cleanup(){
  set +e
  IMG=x docker compose -p "$P" -f "$TMP/compose.yml" down >/dev/null 2>&1
  docker ps -aq --filter "name=^$P" | xargs -r docker rm -f >/dev/null 2>&1
  if [[ -n "$ID" ]]; then
    docker rmi "$P-api:v1" "gest-o-api-release:sha256-${ID#sha256:}" >/dev/null 2>&1
    docker rmi "$ID" >/dev/null 2>&1
  fi
  rm -rf "${TMP:?}"
}
trap 'status=$?; cleanup; exit "$status"' EXIT
fail(){ printf 'FALHA: %s\n' "$*" >&2; exit 1; }

REV=$(printf '%s' "$P" | sha1sum | cut -d' ' -f1); BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$TMP/ctx"
cat >"$TMP/ctx/Dockerfile" <<EOF
FROM $BASE
ARG REV
ARG BUILT_AT
LABEL org.opencontainers.image.revision=\$REV org.opencontainers.image.created=\$BUILT_AT org.opencontainers.image.version=1.0.0
RUN mkdir -p /app/apps/api/dist && printf '{"commit":"%s","builtAt":"%s"}\n' "\$REV" "\$BUILT_AT" >/app/apps/api/dist/build-info.json
ENTRYPOINT []
CMD ["sleep","3600"]
EOF
# shellcheck disable=SC2016 # ${IMG} is interpolated by compose, not by the shell
printf 'services:\n  app:\n    image: "${IMG:?IMG required}"\n' >"$TMP/compose.yml"
docker build -q --pull=false --build-arg REV="$REV" --build-arg BUILT_AT="$BUILT_AT" -t "$P-api:v1" "$TMP/ctx" >/dev/null
ID=$(docker image inspect -f '{{.Id}}' "$P-api:v1")

export RELEASE_ARTIFACT_ROOT="$TMP/oci-backups" RELEASE_ARTIFACT_MIN_FREE_BYTES=0
RELEASE_ARTIFACT_EXPECTED_OWNER="$(id -un):$(id -gn)"; export RELEASE_ARTIFACT_EXPECTED_OWNER
# shellcheck source=scripts/lib/production-build-evidence.sh
source "$ROOT/scripts/lib/production-build-evidence.sh"
# shellcheck source=scripts/lib/production-release-artifact.sh
source "$ROOT/scripts/lib/production-release-artifact.sh"
# shellcheck source=scripts/lib/production-rollback-image.sh
source "$ROOT/scripts/lib/production-rollback-image.sh"

# 1. The image built here passes the cutover's image validation.
build_image_validate api "$ID" "$REV" "$BUILT_AT" || fail "build_image_validate: $BUILD_EVIDENCE_ERROR"
# 2. Pin: created, then accepted as existing.
release_pin api "$ID" | grep -q 'state=created$' || fail "pin: $RELEASE_ERROR"
release_pin api "$ID" | grep -q 'state=existing$' || fail "pin existente: $RELEASE_ERROR"
# 3. Save + gzip -1 + offline verification of the real OCI layout.
release_save api "$ID" "$REV" "$BUILT_AT" "$ID" >"$TMP/save.out" || fail "save: $RELEASE_ERROR"
tar_file="$RELEASE_ARTIFACT_ROOT/$REV/api.${ID#sha256:}.tar.gz"
gzip -dc "$tar_file" | tar -xOf - index.json | grep -q "\"digest\":\"$ID\"" || fail 'index.json sem o ID'
printf 'image_size=%s tar_gz_bytes=%s\n' "$(docker image inspect -f '{{.Size}}' "$ID")" "$(stat -c '%s' "$tar_file")"
# 4. Engine loses the image: no tag, no container, not inspectable.
docker rmi "$P-api:v1" "gest-o-api-release:sha256-${ID#sha256:}" >/dev/null
if docker image inspect "$ID" >/dev/null 2>&1; then fail 'imagem ainda presente antes do restore'; fi
# 5. Restore: digest checked before load, exact ID and release tag after.
release_restore api "$ID" | grep -q 'state=loaded$' || fail "restore: $RELEASE_ERROR"
[[ "$(docker image inspect -f '{{.Id}}' "gest-o-api-release:sha256-${ID#sha256:}")" == "$ID" ]] || fail 'tag de release não voltou'
build_image_validate api "$ID" "$REV" "$BUILT_AT" || fail "imagem restaurada inválida: $BUILD_EVIDENCE_ERROR"
# 6. Compose starts it by ID without pulling.
IMG="$ID" docker compose -p "$P" -f "$TMP/compose.yml" up -d --no-build --no-deps --pull never app >/dev/null 2>&1 || fail 'compose up por ID'
cid=$(IMG="$ID" docker compose -p "$P" -f "$TMP/compose.yml" ps -q app)
[[ "$(docker inspect -f '{{.Image}}' "$cid")" == "$ID" ]] || fail 'container não usa o ID'
# 6b. The rollback predicate, with the real CLI, proves the running container's
# image (the bootstrap and the cutover inventory depend on it).
rollback_image_identities "$ID" | grep -Fxq "$ID" || fail "rollback_image_identities não lista $ID com o CLI real"
resolve_rollback_image api "$(docker inspect -f '{{.Image}}' "$cid")" "$(docker inspect -f '{{.Config.Image}}' "$cid")" ||
  fail "resolve_rollback_image: $ROLLBACK_BLOCK_REASON"
[[ "$ROLLBACK_RESOLUTION_METHOD" == runtime-identity && "$ROLLBACK_ARTIFACT_ID" == "$ID" ]] ||
  fail "resolve_rollback_image: method=$ROLLBACK_RESOLUTION_METHOD artifact=$ROLLBACK_ARTIFACT_ID"
# 7. A tampered copy is rejected offline.
cp "$tar_file" "$TMP/tampered.tar.gz"; printf 'x' >>"$TMP/tampered.tar.gz"
if release_verify_tar "$TMP/tampered.tar.gz" "$ID" "gest-o-api-release:sha256-${ID#sha256:}"; then fail 'tar adulterado aceito'; fi

printf 'PRODUCTION_RELEASE_DOCKER=PASS engine=%s compose=%s id=%s\n' "$(docker version -f '{{.Server.Version}}')" "$(docker compose version --short)" "$ID"
