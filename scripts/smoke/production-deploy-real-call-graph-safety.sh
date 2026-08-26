#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
APP="$TMP/app"; BIN="$TMP/bin"; AUTH="$TMP/authorized"; HIST="$TMP/historical"
SHA=443be81e35a15e37158a93161b105c1aa81690b2
mkdir -p "$APP/scripts/lib" "$BIN" "$AUTH" "$HIST"
cp "$ROOT/scripts/production-deploy-entrypoint.sh" "$ROOT/scripts/deploy-production.sh" \
  "$ROOT/scripts/production-preflight.sh" "$APP/scripts/"
cp "$ROOT/scripts/lib/production-backup-common.sh" "$APP/scripts/lib/"
printf '{"version":"1.0.0"}\n' >"$APP/package.json"

cat >"$APP/scripts/resolve-production-env.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' '$TMP/legacy.env'
EOF
cat >"$APP/scripts/legacy-build-env-overlay.sh" <<'EOF'
create_legacy_build_env_overlay(){ cp "$1" "$2"; printf 'LEGACY_VALUES_LOADED=PASS\n'; }
EOF
cat >"$APP/scripts/erp-production-env-preflight.sh" <<'EOF'
#!/usr/bin/env bash
printf 'ERP_ENV_PREFLIGHT_REAL_POSITION=PASS\n'
EOF
chmod +x "$APP/scripts/"*.sh

cat >"TMP_ENV" <<EOF
DATABASE_URL=postgresql://user:secret@prod-db.example:5432/salesforce_pro
PRODUCTION_DB_HOST_EXPECTED=prod-db.example
PRODUCTION_DB_CONTAINER_EXPECTED=production-postgres
PRODUCTION_DB_VOLUME_EXPECTED=production-pgdata
PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY=$AUTH
PRODUCTION_BACKUP_FILE=$HIST/old.sql.gz
PRODUCTION_BACKUP_SHA256_FILE=$HIST/old.sql.gz.sha256
EOF
mv TMP_ENV "$TMP/legacy.env"
printf 'canonical payload\n' >"$AUTH/production.sql.gz"
(cd "$AUTH" && sha256sum production.sql.gz >production.sql.gz.sha256)

cat >"$BIN/git" <<EOF
#!/usr/bin/env bash
case "\$1 \${2:-}" in
 'fetch origin'|'switch main'|'pull --ff-only') exit 0;;
 'rev-parse HEAD'|'rev-parse origin/main') printf '%s\n' '$SHA';;
 'status --porcelain') exit 0;;
 'branch --show-current') printf 'main\n';;
 'show-ref --verify') exit 0;;
 *) exit 90;;
esac
EOF
cat >"$BIN/node" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == *'new URL'* ]] && { printf 'prod-db.example 5432 salesforce_pro\n'; exit; }
[[ "$*" == *'package.json'* ]] && { printf '1.0.0\n'; exit; }
cat >/dev/null
EOF
cat >"$BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
[[ "$1 $2 $3" == 'compose --env-file '* ]] && [[ "$*" == *'config --services'* ]] && { printf 'api\nweb\n'; exit; }
case "$1 $2" in
 'network inspect'|'volume inspect'|'image inspect') exit 0;;
 'inspect -f')
  case "$3" in
   '{{.State.Running}}') printf 'true\n';;
   '{{json .NetworkSettings.Networks}}') printf '{"gest-o_default":{}}\n';;
   '{{range .Mounts}}{{println .Name .Destination}}{{end}}') printf 'production-pgdata /var/lib/postgresql/data\n';;
  esac;;
 'ps --format') exit 0;;
 *) exit 0;;
esac
EOF
cat >"$BIN/timeout" <<'EOF'
#!/usr/bin/env bash
shift; "$@"
EOF
cat >"$BIN/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nmock 9 1 99999999 1%% /\n'
EOF
chmod +x "$BIN/"*

export PATH="$BIN:$PATH" COMMAND_LOG="$TMP/commands" PRODUCTION_LEGACY_ENV_FILE="$TMP/legacy.env"
APP_DIR="$APP" DEPLOY_MODE=build EXPECTED_SHA="$SHA" bash "$APP/scripts/production-deploy-entrypoint.sh" >"$TMP/out" 2>"$TMP/err"
grep -qx 'LEGACY_VALUES_LOADED=PASS' "$TMP/out"
grep -qx 'PRODUCTION_BACKUP_CANONICAL_RESOLUTION=PASS' "$TMP/out"
grep -qx 'PRODUCTION_BACKUP_HINTS_OVERRIDDEN=PASS' "$TMP/out"
grep -qx 'PRODUCTION_BACKUP_CANONICAL_PAIR=VALIDATED' "$TMP/out"
grep -qx 'PRODUCTION_PREFLIGHT=PASS' "$TMP/out"
! grep -q 'backup_path_mismatch' "$TMP/out" "$TMP/err"
! grep -Eq 'docker .* (up|stop|rm|restart)|PRODUCTION_CUTOVER' "$COMMAND_LOG"
[[ "$(grep -c '^DEPLOY_PREFLIGHT_SCRIPT_SOURCE=CHECKOUT_MAIN$' "$TMP/out")" -ge 2 ]]
printf 'production deploy real call graph safety passed\n'
