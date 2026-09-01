#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
APP="$TMP/checkout"; CANONICAL="$TMP/.env"; LEGACY="$TMP/production.env"
mkdir -p "$APP/scripts"
cp "$ROOT/scripts/resolve-production-env.sh" "$ROOT/scripts/run-production-tenancy-expand-roots.sh" "$APP/scripts/"
cat >"$APP/scripts/tenancy-expand-roots-runner.sh" <<'RUNNER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ ${DATABASE_URL+x} == x && -n "$DATABASE_URL" ]]
printf 'RUNNER_DATABASE_URL_SHA256=%s\n' "$(printf %s "$DATABASE_URL" | sha256sum | awk '{print $1}')"
printf 'RUNNER_MODE=%s\n' "${MODE:?}"
RUNNER
chmod +x "$APP/scripts/"*.sh

run_case() {
  local label=$1 expected=$2; shift 2
  local out="$TMP/$label.out" rc
  set +e
  APP_DIR="$APP" PRODUCTION_CANONICAL_ENV_FILE="$CANONICAL" \
    PRODUCTION_LEGACY_ENV_FILE="$LEGACY" ERP_ENV_EXPECTED_OWNER="$(id -un):$(id -gn)" \
    MODE=preview bash "$APP/scripts/run-production-tenancy-expand-roots.sh" >"$out" 2>&1
  rc=$?
  set -e
  [[ "$expected" == pass && $rc == 0 || "$expected" == fail && $rc != 0 ]]
  ! grep -Fq 'postgresql://' "$out"
  if [[ "$expected" == fail ]]; then ! grep -Fq 'RUNNER_' "$out"; fi
}

write_value() { printf 'DATABASE_URL=%s\n' "$1" >"$CANONICAL"; chmod 600 "$CANONICAL"; }
rm -f "$LEGACY"
write_value 'postgresql://user:secret@db.invalid/salesforce_pro'; run_case unquoted pass
write_value "'postgresql://user:secret@db.invalid/salesforce_pro'"; run_case single-quoted pass
write_value '"postgresql://user:secret@db.invalid/salesforce_pro"'; run_case double-quoted pass
printf 'TENANCY_MODE=disabled\n' >"$CANONICAL"; chmod 600 "$CANONICAL"; run_case absent fail
write_value "''"; run_case empty fail
write_value 'postgresql://user:secret@db.invalid/salesforce_pro'; chmod 640 "$CANONICAL"; run_case metadata fail
chmod 600 "$CANONICAL"; mv "$CANONICAL" "$TMP/target"; ln -s "$TMP/target" "$CANONICAL"; run_case symlink fail
rm -f "$CANONICAL"; cp "$TMP/target" "$LEGACY"; chmod 600 "$LEGACY"; run_case legacy fail

printf '%s\n' 'Production tenancy canonical environment: PASS'
