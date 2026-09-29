#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
APP="$TMP/app"; BIN="$TMP/bin"; AUTH="$TMP/authorized"; HIST="$TMP/historical"
SHA=$(git rev-parse HEAD)
mkdir -p "$APP/scripts/lib" "$BIN" "$AUTH" "$HIST"
cp "$ROOT/scripts/production-deploy-entrypoint.sh" "$ROOT/scripts/deploy-production.sh" \
  "$ROOT/scripts/production-preflight.sh" "$ROOT/scripts/schema-evidence-validation.sh" \
  "$ROOT/scripts/schema-diff-filter.mjs" "$APP/scripts/"
cp "$ROOT/scripts/lib/production-backup-common.sh" "$ROOT/scripts/lib/pr827-backup-proof.sh" "$ROOT/scripts/lib/production-preflight-proof.sh" "$APP/scripts/lib/"
cp "$ROOT/scripts/lib/production-rollback-image.sh" "$APP/scripts/lib/"
printf '{"version":"1.0.0"}\n' >"$APP/package.json"

cat >"$APP/scripts/resolve-production-env.sh" <<EOF
#!/usr/bin/env bash
if [[ "\${MODE:-}" == cutover ]]; then
  printf '%s\n' '$TMP/canonical.env'
else
  printf '%s\n' '$TMP/legacy.env'
fi
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
cp "$TMP/legacy.env" "$TMP/canonical.env"
printf 'canonical payload\n' >"$AUTH/production.sql.gz"
(cd "$AUTH" && sha256sum production.sql.gz >production.sql.gz.sha256)
export PR827_BACKUP_PROOF_ROOT="$TMP/protected-backup"
export PR827_BACKUP_PROOF_EXPECTED_OWNER="$(id -un):$(id -gn)"
export PRODUCTION_PREFLIGHT_PROOF_ROOT="$TMP/protected-preflight"
export PRODUCTION_PREFLIGHT_PROOF_EXPECTED_OWNER="$(id -un):$(id -gn)"
export PREFLIGHT_RESULT_FILE="$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest/result.tsv"
export BACKUP_RESULT_FILE="$PR827_BACKUP_PROOF_ROOT/latest/result.tsv"
source "$ROOT/scripts/lib/pr827-backup-proof.sh"
pr827_backup_proof_publish "$AUTH/production.sql.gz" "$SHA" "$BACKUP_RESULT_FILE" 3600

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
cat >"$BIN/stat" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *'%u:%a'* ]]; path="${!#}"; then
  printf '0:700\n'
  exit 0
elif [[ "$*" == *'%u'* ]]; then
  printf '0\n'
  exit 0
fi
exec /usr/bin/stat "$@"
EOF
chmod +x "$BIN/stat"

cat >"$BIN/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nmock 9 1 99999999 1%% /\n'
EOF
chmod +x "$BIN/"*

export PATH="$BIN:$PATH" COMMAND_LOG="$TMP/commands" PRODUCTION_LEGACY_ENV_FILE="$TMP/legacy.env"
APP_DIR="$APP" DEPLOY_MODE=build EXPECTED_SHA="$SHA" bash "$APP/scripts/production-deploy-entrypoint.sh" >"$TMP/out" 2>"$TMP/err" || {
  cat "$TMP/out"; cat "$TMP/err" >&2; exit 1
}
grep -qx 'LEGACY_VALUES_LOADED=PASS' "$TMP/out"
grep -qx 'PRODUCTION_BACKUP_AUTHORITATIVE_RESOLUTION=PASS' "$TMP/out"
grep -qx 'PRODUCTION_BACKUP_HINTS_OVERRIDDEN=PASS' "$TMP/out"
grep -qx 'PRODUCTION_PREFLIGHT=PASS' "$TMP/out"
! grep -q 'backup_path_mismatch' "$TMP/out" "$TMP/err"
! grep -Eq 'docker .* (up|stop|rm|restart)|PRODUCTION_CUTOVER' "$COMMAND_LOG"
[[ "$(grep -c '^DEPLOY_PREFLIGHT_SCRIPT_SOURCE=CHECKOUT_MAIN$' "$TMP/out")" -ge 2 ]]

# Test cutover marker behavior in end-to-end mocks
EVIDENCE_DIR="$TMP/evidence"
mkdir -p "$EVIDENCE_DIR/$SHA"
touch "$EVIDENCE_DIR/$SHA/cutover-started"

# Setup schema evidence mock
SCHEMA_ROOT="$TMP/schema"
mkdir -p "$SCHEMA_ROOT/$SHA"
migration="apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql"
migration_hash=$(sha256sum "$ROOT/$migration" | cut -d' ' -f1)
printf '2026-08-27T19:00:00Z\t%s\t%s\n' "$SHA" "$migration" >"$SCHEMA_ROOT/$SHA/applied.tsv"
printf '%s  %s\n' "$migration_hash" "$migration" >"$SCHEMA_ROOT/$SHA/migration.sha256"
chmod 600 "$SCHEMA_ROOT/$SHA/applied.tsv" "$SCHEMA_ROOT/$SHA/migration.sha256"
chmod 700 "$SCHEMA_ROOT/$SHA"
chmod 700 "$SCHEMA_ROOT"

# Mock curl to return older commit (not completed)
cat >"$BIN/curl" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *'/health/version'* ]]; then
  printf '{"commit":"old-commit-1234"}\n'
  exit 0
fi
exit 0
EOF
chmod +x "$BIN/curl"

# 1. Marcador stale com CONFIRM=PRODUCTION_CUTOVER deve falhar
set +e
APP_DIR="$APP" DEPLOY_MODE=cutover EXPECTED_SHA="$SHA" CONFIRM=PRODUCTION_CUTOVER DEPLOY_EVIDENCE_DIR="$EVIDENCE_DIR" SCHEMA_EVIDENCE_DIR="$SCHEMA_ROOT" bash "$APP/scripts/production-deploy-entrypoint.sh" >"$TMP/stale.out" 2>"$TMP/stale.err"
stale_rc=$?
set -e
[[ "$stale_rc" -ne 0 ]]
grep -q "evidência do SHA indica cutover iniciado; revisão manual obrigatória" "$TMP/stale.err" || {
  cat "$TMP/stale.err" >&2; exit 1
}

# 2. Cutover parcialmente iniciado / container parado deve falhar na reautorização
cat >"$BIN/docker" <<EOF
#!/usr/bin/env bash
printf 'docker %s\n' "\$*" >>"$COMMAND_LOG"
[[ "\$1 \$2 \$3" == 'compose --env-file '* ]] && [[ "\$*" == *'config --services'* ]] && { printf 'api\nweb\n'; exit; }
case "\$1 \$2" in
 'network inspect'|'volume inspect'|'image inspect') exit 0;;
 'inspect -f')
  case "\$3" in
   '{{.State.Running}}') printf 'false\n';;
   '{{json .NetworkSettings.Networks}}') printf '{"gest-o_default":{}}\n';;
   '{{range .Mounts}}{{println .Name .Destination}}{{end}}') printf 'production-pgdata /var/lib/postgresql/data\n';;
  esac;;
 'ps --format') printf 'api-container|:4000->4000\n';;
 *) exit 0;;
esac
EOF
chmod +x "$BIN/docker"

set +e
APP_DIR="$APP" DEPLOY_MODE=cutover EXPECTED_SHA="$SHA" CONFIRM=PRODUCTION_CUTOVER_REAUTHORIZED DEPLOY_EVIDENCE_DIR="$EVIDENCE_DIR" SCHEMA_EVIDENCE_DIR="$SCHEMA_ROOT" bash "$APP/scripts/production-deploy-entrypoint.sh" >"$TMP/partial.out" 2>"$TMP/partial.err"
partial_rc=$?
set -e
[[ "$partial_rc" -ne 0 ]]
grep -q "reautorização bloqueada: container anterior de api não está em execução" "$TMP/partial.err"

# 3. Marcador stale reautorizado com containers saudáveis deve arquivar a evidência e prosseguir
cat >"$BIN/docker" <<EOF
#!/usr/bin/env bash
printf 'docker %s\n' "\$*" >>"$COMMAND_LOG"
[[ "\$1 \$2 \$3" == 'compose --env-file '* ]] && [[ "\$*" == *'config --services'* ]] && { printf 'api\nweb\n'; exit; }
case "\$1 \$2" in
 'network inspect'|'volume inspect'|'image inspect') exit 0;;
 'inspect -f')
  case "\$3" in
   '{{.State.Running}}') printf 'true\n';;
   '{{json .NetworkSettings.Networks}}') printf '{"gest-o_default":{}}\n';;
   '{{range .Mounts}}{{println .Name .Destination}}{{end}}') printf 'production-pgdata /var/lib/postgresql/data\n';;
  esac;;
 'ps --format')
  printf 'api-container|:4000->4000\nweb-container|:5173->5173\n';;
 *) exit 0;;
esac
EOF
chmod +x "$BIN/docker"

cat >"$BIN/node" <<EOF
#!/usr/bin/env bash
[[ "\$*" == *'new URL'* ]] && { printf 'prod-db.example 5432 salesforce_pro\n'; exit; }
[[ "\$*" == *'package.json'* ]] && { printf '1.0.0\n'; exit; }
[[ "\$*" == *'prisma migrate diff'* ]] && exit 0
if [[ "\$*" == *'managed.sql'* ]]; then
  exit 0
fi
cat >/dev/null
EOF
chmod +x "$BIN/node"

APP_DIR="$APP" DEPLOY_MODE=cutover EXPECTED_SHA="$SHA" CONFIRM=PRODUCTION_CUTOVER_REAUTHORIZED DEPLOY_EVIDENCE_DIR="$EVIDENCE_DIR" SCHEMA_EVIDENCE_DIR="$SCHEMA_ROOT" bash "$APP/scripts/production-deploy-entrypoint.sh" >"$TMP/reauth.out" 2>"$TMP/reauth.err" || {
  cat "$TMP/reauth.out"; cat "$TMP/reauth.err" >&2; exit 1
}
grep -q "cutover reautorizado manualmente para $SHA" "$TMP/reauth.out"
ls "$EVIDENCE_DIR" | grep -q "$SHA.reauthorized-"

# 4. Cutover concluído deve ser idempotente
# Mock curl para retornar o SHA atual
cat >"$BIN/curl" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *'/health/version'* ]]; then
  printf '{"commit":"%s"}\n' "$SHA"
  exit 0
fi
exit 0
EOF
chmod +x "$BIN/curl"

# Recria marcador no diretório $EVIDENCE_DIR/$SHA (que foi recriado pelo cutover anterior)
touch "$EVIDENCE_DIR/$SHA/cutover-started"

APP_DIR="$APP" DEPLOY_MODE=cutover EXPECTED_SHA="$SHA" CONFIRM=PRODUCTION_CUTOVER DEPLOY_EVIDENCE_DIR="$EVIDENCE_DIR" SCHEMA_EVIDENCE_DIR="$SCHEMA_ROOT" bash "$APP/scripts/production-deploy-entrypoint.sh" >"$TMP/done.out" 2>"$TMP/done.err"
grep -q "Cutover já concluído anteriormente para $SHA" "$TMP/done.out"

printf 'production deploy real call graph safety passed\n'
