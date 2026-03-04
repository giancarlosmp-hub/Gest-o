#!/bin/bash
set -e
echo "Waiting for API health..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:4000/health > /dev/null; then
    echo "API is healthy"
    break
  fi
  echo "Attempt $i/30..."
  sleep 1
  if [ $i -eq 30 ]; then
    echo "ERROR: API did not become healthy"
    exit 1
  fi
done

echo "Testing /technical-cultures..."
if curl -sf http://localhost:4000/technical-cultures > /dev/null; then
  echo "OK: /technical-cultures returned 200"
else
  echo "ERROR: /technical-cultures failed"
  exit 1
fi
