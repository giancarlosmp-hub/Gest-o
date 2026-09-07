#!/usr/bin/env bash
set -euo pipefail
command -v docker >/dev/null 2>&1 || { echo 'SKIP: docker unavailable'; exit 77; }
docker info >/dev/null 2>&1 || { echo 'SKIP: docker daemon unavailable'; exit 77; }
expected=0123456789abcdef0123456789abcdef01234567
image="gesto-preview-web-sha-test:$$"
cleanup() { docker image rm -f "$image" >/dev/null 2>&1 || :; }
trap cleanup EXIT
docker build --pull=false -f apps/web/Dockerfile \
  --build-arg VITE_API_URL=/api \
  --build-arg APP_COMMIT="$expected" \
  --build-arg APP_VERSION=preview-test \
  --build-arg APP_BUILT_AT=synthetic \
  -t "$image" . >/dev/null
image_sha=$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
runtime_sha=$(docker run --rm --entrypoint cat "$image" /usr/share/nginx/html/build-info.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).commit))')
test "$image_sha" = "$expected"
test "$runtime_sha" = "$expected"
echo "WEB_IMAGE_SHA=$image_sha"
echo "WEB_RUNTIME_SHA=$runtime_sha"
echo 'PREVIEW_WEB_SHA_PROVENANCE=PASS'
