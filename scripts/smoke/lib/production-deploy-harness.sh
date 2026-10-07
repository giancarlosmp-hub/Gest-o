#!/usr/bin/env bash
# Shared harness for end-to-end deploy safety tests: copies the real entrypoint,
# deploy, preflight and rollback scripts into a scratch app, provides fake git,
# node (pass-through for JSON work), curl, sleep and the stateful fake OCI engine
# (fake-oci-docker.sh), and keeps every evidence root inside $TMP.
# Caller defines ROOT and TMP and then runs: source ...; harness_init
# shellcheck disable=SC2034 # variables are consumed by the sourcing test

harness_init(){
  : "${ROOT:?ROOT must be defined by the caller}" "${TMP:?TMP must be defined by the caller}"
  APP="$TMP/app"; BIN="$TMP/bin"; AUTH="$TMP/authorized"; HIST="$TMP/historical"
  SHA=$(git -C "$ROOT" rev-parse HEAD)
  mkdir -p "$APP/scripts/lib" "$BIN" "$AUTH" "$HIST"
  cp "$ROOT/scripts/production-deploy-entrypoint.sh" "$ROOT/scripts/deploy-production.sh" \
    "$ROOT/scripts/production-preflight.sh" "$ROOT/scripts/schema-evidence-validation.sh" \
    "$ROOT/scripts/schema-diff-filter.mjs" "$ROOT/scripts/production-rollback.sh" "$APP/scripts/"
  cp "$ROOT/scripts/lib/production-backup-common.sh" "$ROOT/scripts/lib/pr827-backup-proof.sh" \
    "$ROOT/scripts/lib/production-preflight-proof.sh" "$ROOT/scripts/lib/production-rollback-image.sh" \
    "$ROOT/scripts/lib/production-rebaseline-proof.sh" "$ROOT/scripts/lib/production-build-evidence.sh" \
    "$ROOT/scripts/lib/production-release-artifact.sh" "$APP/scripts/lib/"
  printf '{"version":"1.0.0"}\n' >"$APP/package.json"
  printf 'services: {}\n' >"$APP/docker-compose.production.yml"

  cat >"$APP/scripts/resolve-production-env.sh" <<EOF
#!/usr/bin/env bash
if [[ "\${MODE:-}" == cutover ]]; then printf '%s\n' '$TMP/canonical.env'; else printf '%s\n' '$TMP/legacy.env'; fi
EOF
  cat >"$APP/scripts/legacy-build-env-overlay.sh" <<'EOF'
create_legacy_build_env_overlay(){ cp "$1" "$2"; printf 'LEGACY_VALUES_LOADED=PASS\n'; }
EOF
  cat >"$APP/scripts/erp-production-env-preflight.sh" <<'EOF'
#!/usr/bin/env bash
printf 'ERP_ENV_PREFLIGHT_REAL_POSITION=PASS\n'
EOF
  chmod +x "$APP/scripts/"*.sh

  cat >"$TMP/legacy.env" <<EOF
DATABASE_URL=postgresql://user:secret@prod-db.example:5432/salesforce_pro
PRODUCTION_DB_HOST_EXPECTED=prod-db.example
PRODUCTION_DB_CONTAINER_EXPECTED=production-postgres
PRODUCTION_DB_VOLUME_EXPECTED=production-pgdata
PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY=$AUTH
PRODUCTION_BACKUP_FILE=$HIST/old.sql.gz
PRODUCTION_BACKUP_SHA256_FILE=$HIST/old.sql.gz.sha256
EOF
  cp "$TMP/legacy.env" "$TMP/canonical.env"
  printf 'canonical payload\n' >"$AUTH/production.sql.gz"
  (cd "$AUTH" && sha256sum production.sql.gz >production.sql.gz.sha256)
  local owner; owner="$(id -un):$(id -gn)"
  export PR827_BACKUP_PROOF_ROOT="$TMP/protected-backup" PR827_BACKUP_PROOF_EXPECTED_OWNER="$owner"
  export PRODUCTION_PREFLIGHT_PROOF_ROOT="$TMP/protected-preflight" PRODUCTION_PREFLIGHT_PROOF_EXPECTED_OWNER="$owner"
  export PREFLIGHT_RESULT_FILE="$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest/result.tsv"
  export BACKUP_RESULT_FILE="$PR827_BACKUP_PROOF_ROOT/latest/result.tsv"
  export PRODUCTION_BUILD_EVIDENCE_EXPECTED_OWNER="$owner" RELEASE_ARTIFACT_EXPECTED_OWNER="$owner"
  export BUILD_EVIDENCE_DIR="$TMP/deploy-builds" RELEASE_ARTIFACT_ROOT="$TMP/oci-backups"
  export RELEASE_RETENTION_REPORT_DIR="$TMP/release-retention" DEPLOY_EVIDENCE_DIR="$TMP/deploy"
  export REBASELINE_EVIDENCE_DIR="$TMP/rebaseline" SCHEMA_EVIDENCE_DIR="$TMP/schema"
  # shellcheck source=scripts/lib/pr827-backup-proof.sh
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
 'cat-file -e') [[ "\$3" == '$SHA^{commit}' ]];;
 'show $SHA:'*) cat "$ROOT/\${2#*:}";;
 *) exit 90;;
esac
EOF
  REAL_NODE=$(command -v node); export REAL_NODE FAKE_REAL_NODE=$REAL_NODE
  cat >"$BIN/node" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == *'new URL'* ]] && { printf 'prod-db.example 5432 salesforce_pro\n'; exit; }
[[ "$*" == *'package.json'* ]] && { printf '1.0.0\n'; exit; }
[[ "$*" == *'JSON.parse'* ]] && exec "$REAL_NODE" "$@"
[[ "$*" == *'managed.sql'* ]] && exit 0
cat >/dev/null
EOF
  # /health/version reports what the container listening on 4000 was started with.
  cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
S=$FAKE_DOCKER_STATE
if [[ "$*" == *':4000/health/version'* ]]; then
  row=$(awk -F'\t' '$5=="true" && $6 ~ /:4000->/{print; exit}' "$S/containers")
  [[ -n "$row" ]] || exit 7
  printf '{"commit":"%s","builtAt":"%s","version":"1.0.0","status":"ok"}\n' "$(cut -f7 <<<"$row")" "$(cut -f8 <<<"$row")"
elif [[ "$*" == *':4000/health'* ]]; then
  awk -F'\t' '$5=="true" && $6 ~ /:4000->/{f=1} END{exit !f}' "$S/containers" || exit 7
  printf '{"status":"ok"}\n'
elif [[ "$*" == *':5173/'* ]]; then
  awk -F'\t' '$5=="true" && $6 ~ /:5173->/{f=1} END{exit !f}' "$S/containers" || exit 7
  printf '<html>gest-o</html>\n'
fi
EOF
  printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$ROOT/scripts/smoke/lib/fake-oci-docker.sh" >"$BIN/docker"
  printf '#!/usr/bin/env bash\nshift; "$@"\n' >"$BIN/timeout"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/sleep"
  cat >"$BIN/stat" <<'EOF'
#!/usr/bin/env bash
path="${!#}"
if [[ "$*" == *'%u:%a'* ]]; then
  if [[ -d "$path" ]]; then printf '0:700\n'; else printf '0:600\n'; fi
  exit 0
elif [[ "$*" == *'%u'* ]]; then
  printf '0\n'; exit 0
fi
exec /usr/bin/stat "$@"
EOF
  cat >"$BIN/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nmock 9 1 99999999 1%% /\n'
EOF
  chmod +x "$BIN/"*
  export PATH="$BIN:$PATH" COMMAND_LOG="$TMP/commands" PRODUCTION_LEGACY_ENV_FILE="$TMP/legacy.env"
  export FAKE_DOCKER_STATE="$TMP/engine"
  ENGINE=(bash "$ROOT/scripts/smoke/lib/fake-oci-engine.sh")

  # Schema evidence for the deployed SHA (cutover gate).
  local migration migration_hash
  mkdir -p "$SCHEMA_EVIDENCE_DIR/$SHA"
  migration="apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql"
  migration_hash=$(sha256sum "$ROOT/$migration" | cut -d' ' -f1)
  mkdir -p "$APP/${migration%/*}"; cp "$ROOT/$migration" "$APP/$migration"
  printf '2026-08-27T19:00:00Z\t%s\t%s\n' "$SHA" "$migration" >"$SCHEMA_EVIDENCE_DIR/$SHA/applied.tsv"
  printf '%s  %s\n' "$migration_hash" "$migration" >"$SCHEMA_EVIDENCE_DIR/$SHA/migration.sha256"
  chmod 600 "$SCHEMA_EVIDENCE_DIR/$SHA/applied.tsv" "$SCHEMA_EVIDENCE_DIR/$SHA/migration.sha256"
  chmod 700 "$SCHEMA_EVIDENCE_DIR/$SHA" "$SCHEMA_EVIDENCE_DIR"
}

# runtime_reset <old_commit> [old_version] [old_built_at]: production as it runs
# before a deploy: PostgreSQL plus api/web started by compose from <old_commit>.
runtime_reset(){
  local old=$1 version=${2:-0.9.0} built_at=${3:-2026-09-01T00:00:00Z}
  "${ENGINE[@]}" init; : >"$COMMAND_LOG"
  rm -rf "${BUILD_EVIDENCE_DIR:?}" "${RELEASE_ARTIFACT_ROOT:?}" "${RELEASE_RETENTION_REPORT_DIR:?}" "${DEPLOY_EVIDENCE_DIR:?}" "${REBASELINE_EVIDENCE_DIR:?}"
  "${ENGINE[@]}" image postgres:16 - - - api >/dev/null
  "${ENGINE[@]}" container production-postgres postgres:16 true -
  OLD_API=$("${ENGINE[@]}" image "gest-o-api:$old" "$old" "$version" "$built_at" api)
  OLD_WEB=$("${ENGINE[@]}" image "gest-o-web:$old" "$old" "$version" "$built_at" web)
  "${ENGINE[@]}" container gest-o-production-api-1 "gest-o-api:$old" true '127.0.0.1:4000->4000/tcp' "$old" "$built_at"
  "${ENGINE[@]}" container gest-o-production-web-1 "gest-o-web:$old" true '127.0.0.1:5173->80/tcp' "$old" "$built_at"
}

# run_deploy <build|cutover> <name> [CONFIRM]
run_deploy(){
  local mode=$1 name=$2 confirm=${3:-PRODUCTION_CUTOVER}
  APP_DIR="$APP" DEPLOY_MODE="$mode" EXPECTED_SHA="$SHA" CONFIRM="$confirm" \
    bash "$APP/scripts/production-deploy-entrypoint.sh" >"$TMP/$name.out" 2>"$TMP/$name.err"
}
expect_deploy_ok(){ run_deploy "$@" || { cat "$TMP/$2.out"; cat "$TMP/$2.err" >&2; printf 'deploy %s falhou inesperadamente\n' "$2" >&2; exit 1; }; }
expect_deploy_fail(){ if run_deploy "$@"; then cat "$TMP/$2.out"; printf 'deploy %s passou inesperadamente\n' "$2" >&2; exit 1; fi; }
no_runtime_change(){ ! grep -Eq '^docker (stop|start|rm) |^docker compose .* (up|stop|rm) ' "$COMMAND_LOG"; }
container_image(){ awk -F'\t' -v n="$1" '$1==n{print $3; exit}' "$FAKE_DOCKER_STATE/containers"; }
container_running(){ awk -F'\t' -v n="$1" '$1==n{print $5; exit}' "$FAKE_DOCKER_STATE/containers"; }
