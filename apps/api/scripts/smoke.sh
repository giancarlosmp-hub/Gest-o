#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:4000}"

for i in {1..30}; do
  if curl -sf "${API_BASE_URL}/health" >/dev/null; then
    break
  fi

  if [ "$i" -eq 30 ]; then
    echo "API healthcheck failed after 30 attempts"
    exit 1
  fi

  sleep 1
done

curl -sf "${API_BASE_URL}/technical-cultures" >/dev/null

echo "Smoke test passed"
