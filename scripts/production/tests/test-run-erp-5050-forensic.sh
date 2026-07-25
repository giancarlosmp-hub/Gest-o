#!/usr/bin/env bash

set -Eeuo pipefail

readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
readonly RUNNER="$ROOT/scripts/production/run-erp-5050-forensic.sh"
readonly SQL="$ROOT/docs/investigations/evidence/erp-5050-read-only.sql"

[[ -x "$RUNNER" ]]

# Static checks only: this test must never invoke psql or the runner.
if sed 's/^[[:space:]]*#.*$//' "$RUNNER" | grep -Eiq '(^|[[:space:];])(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)[[:space:]]'; then
  printf 'runner contains a database-writing command\n' >&2
  exit 1
fi
if sed 's/^[[:space:]]*--.*$//' "$SQL" | grep -Eiq '^[[:space:]]*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)[[:space:]]'; then
  printf 'versioned SQL contains a database-writing command\n' >&2
  exit 1
fi

grep -Fq "CONFIRM:-" "$RUNNER"
grep -Fq "FORENSIC5050" "$RUNNER"
grep -Eiq '^BEGIN( TRANSACTION)? READ ONLY;' "$SQL"
grep -Fq "SET LOCAL statement_timeout = '60s';" "$SQL"
grep -Fq "SET LOCAL lock_timeout = '5s';" "$SQL"
grep -Fq -- "-f \"\$EVIDENCE_DIR/consultas.sql\"" "$RUNNER"
grep -Fq "manifest.json" "$RUNNER"
grep -Fq "quantidade_linhas_produzidas" "$RUNNER"
grep -Fq 'sha256sum consultas.sql >consultas.sql.sha256' "$RUNNER"
grep -Fq 'sha256sum stdout.txt >stdout.txt.sha256' "$RUNNER"
grep -Fq 'sha256sum manifest.json >manifest.json.sha256' "$RUNNER"

if grep -Eq '(^|[[:space:]])(tee|eval)([[:space:]]|$)' "$RUNNER"; then
  printf 'runner uses a forbidden command\n' >&2
  exit 1
fi

printf 'static forensic runner checks passed\n'
