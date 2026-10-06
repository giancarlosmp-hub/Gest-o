#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP:?}"' EXIT
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
 'cat-file -e') [[ "\$3" == '$SHA^{commit}' ]];;
 'show $SHA:'*) cat "$ROOT/\${2#*:}";;
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
path="${!#}"
if [[ "$*" == *'%u:%a'* ]]; then
  if [[ -d "$path" ]]; then printf '0:700\n'; else printf '0:600\n'; fi
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
grep -q 'backup_path_mismatch' "$TMP/out" "$TMP/err" && exit 1
grep -Eq 'docker .* (up|stop|rm|restart)|PRODUCTION_CUTOVER' "$COMMAND_LOG" && exit 1
[[ "$(grep -c '^DEPLOY_PREFLIGHT_SCRIPT_SOURCE=CHECKOUT_MAIN$' "$TMP/out")" -ge 2 ]]

# Cutover scenarios run against a stateful fake Docker Engine: images (tag/id/
# OCI labels), containers and port owners live in $STATE, so the real inventory,
# rollback-image resolution and rebaseline restore paths execute end to end.
cp "$ROOT/scripts/production-rollback.sh" "$APP/scripts/"
cp "$ROOT/scripts/lib/production-rebaseline-proof.sh" "$APP/scripts/lib/"
STATE="$TMP/docker-state"; mkdir -p "$STATE"
export FAKE_DOCKER_STATE="$STATE" FAKE_SHA="$SHA"
REAL_NODE=$(PATH=${PATH#"$BIN:"} command -v node); export REAL_NODE
OLD_SHA=$(printf 'd%.0s' {1..40})
LEGACY_API=sha256:$(printf 'a%.0s' {1..64}); LEGACY_WEB=sha256:$(printf 'b%.0s' {1..64})
TARGET_API=sha256:$(printf 'e%.0s' {1..64}); TARGET_WEB=sha256:$(printf 'f%.0s' {1..64})
API_CID=apiid0000001$(printf '0%.0s' {1..52}); WEB_CID=webid0000001$(printf '0%.0s' {1..52})

cat >"$BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
S=$FAKE_DOCKER_STATE
image_row(){ awk -F'\t' -v r="$1" '$1==r||$2==r{print; exit}' "$S/images"; }
container_row(){ awk -F'\t' -v r="$1" '$1==r||$2==r||substr($2,1,12)==r{print; exit}' "$S/containers"; }
label(){ if [[ "$1" == - ]]; then printf '<no value>\n'; else printf '%s\n' "$1"; fi; }
case "$1" in
 compose)
  case "$*" in
   *'config --services'*) printf 'api\nweb\n';;
   *' up '*) : >"$S/up";;
   *'ps -q api'*) printf 'newapi\n';;
   *'ps -q web'*) printf 'newweb\n';;
  esac;;
 image)
  [[ "$2" == inspect ]] || exit 0
  ref=${!#}; row=$(image_row "$ref"); [[ -n "$row" ]] || exit 1
  [[ "$3" == -f || "$3" == --format ]] || { printf '[{}]\n'; exit 0; }
  IFS=$'\t' read -r _ id rev ver created <<<"$row"
  case "$4" in
   *org.opencontainers.image.revision*) label "$rev";;
   *org.opencontainers.image.version*) label "$ver";;
   *org.opencontainers.image.created*) label "$created";;
   *.Id*) printf '%s\n' "$id";;
  esac;;
 tag)
  row=$(image_row "$2"); [[ -n "$row" ]] || exit 1
  printf '%s\t%s\n' "$3" "$(cut -f2- <<<"$row")" >>"$S/images";;
 load) cat "$S/loadable" >>"$S/images";;
 inspect)
  [[ "$2" == -f ]] || { printf '[{}]\n'; exit 0; }
  row=$(container_row "$4"); IFS=$'\t' read -r _ cid image config <<<"$row"
  case "$3" in
   *State.Health*) printf 'healthy\n';;
   *State.Running*) if [[ "$4" == production-postgres ]]; then printf 'true\n'; else cat "$S/running"; fi;;
   *Mounts*) printf 'production-pgdata /var/lib/postgresql/data\n';;
   '{{json .NetworkSettings.Networks}}') printf '{"gest-o_default":{}}\n';;
   *NetworkSettings.Networks*) printf 'gest-o_default,\n';;
   *RestartPolicy*) printf 'unless-stopped\n';;
   *Config.Env*) printf 'APP_COMMIT=%s\n' "$(cat "$S/runtime-env-commit")";;
   '{{.Id}}') [[ -n "$cid" ]] && printf '%s\n' "$cid";;
   '{{.Image}}') printf '%s\n' "$image";;
   '{{.Config.Image}}') printf '%s\n' "$config";;
  esac;;
 ps)
  if [[ "$*" == *'{{.ID}}'* ]]; then awk -F'|' '{print $2"|"$3}' "$S/ps"; else awk -F'|' '{print $1"|"$3}' "$S/ps"; fi;;
 *) exit 0;;
esac
EOF
cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *'/health/version'* ]]; then
  if [[ -e "$FAKE_DOCKER_STATE/up" ]]; then printf '{"commit":"%s"}\n' "$FAKE_SHA"; else printf '{"commit":"old-commit-1234"}\n'; fi
fi
exit 0
EOF
cat >"$BIN/node" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == *'new URL'* ]] && { printf 'prod-db.example 5432 salesforce_pro\n'; exit; }
[[ "$*" == *'package.json'* ]] && { printf '1.0.0\n'; exit; }
[[ "$*" == *'JSON.parse'* ]] && exec "$REAL_NODE" "$@"
[[ "$*" == *'managed.sql'* ]] && exit 0
cat >/dev/null
EOF
chmod +x "$BIN/docker" "$BIN/curl" "$BIN/node"

# reset_engine <legacy images: yes|no|unlabelled> <container running: true|false> <port owners: api,web>
reset_engine(){
  local rev=$OLD_SHA
  rm -f "${STATE:?}/up"; : >"$COMMAND_LOG"
  printf '%s\n' "$2" >"$STATE/running"
  printf '%s\n' "$OLD_SHA" >"$STATE/runtime-env-commit"
  printf 'gest-o-api:%s\t%s\t%s\t1.0.0\t2026-10-01T00:00:00Z\n' "$SHA" "$TARGET_API" "$SHA" >"$STATE/images"
  printf 'gest-o-web:%s\t%s\t%s\t1.0.0\t2026-10-01T00:00:00Z\n' "$SHA" "$TARGET_WEB" "$SHA" >>"$STATE/images"
  printf 'postgres:16\tsha256:%s\t-\t-\t-\n' "$(printf '9%.0s' {1..64})" >>"$STATE/images"
  [[ "$1" != unlabelled ]] || rev=-
  if [[ "$1" != no ]]; then
    printf 'gest-o-api:%s\t%s\t%s\t0.9.0\t2026-09-01T00:00:00Z\n' "$OLD_SHA" "$LEGACY_API" "$rev" >>"$STATE/images"
    printf 'gest-o-web:%s\t%s\t%s\t0.9.0\t2026-09-01T00:00:00Z\n' "$OLD_SHA" "$LEGACY_WEB" "$rev" >>"$STATE/images"
  fi
  : >"$STATE/loadable"
  printf 'api-container\t%s\t%s\tgest-o-api:%s\n' "$API_CID" "$LEGACY_API" "$OLD_SHA" >"$STATE/containers"
  printf 'web-container\t%s\t%s\tgest-o-web:%s\n' "$WEB_CID" "$LEGACY_WEB" "$OLD_SHA" >>"$STATE/containers"
  : >"$STATE/ps"
  [[ "$3" != *api* ]] || printf 'api-container|%s|0.0.0.0:4000->4000/tcp\n' "${API_CID:0:12}" >>"$STATE/ps"
  [[ "$3" != *web* ]] || printf 'web-container|%s|0.0.0.0:5173->5173/tcp\n' "${WEB_CID:0:12}" >>"$STATE/ps"
}
run_cutover(){
  local confirm=$1 name=$2
  APP_DIR="$APP" DEPLOY_MODE=cutover EXPECTED_SHA="$SHA" CONFIRM="$confirm" DEPLOY_EVIDENCE_DIR="$EVIDENCE_DIR" \
    SCHEMA_EVIDENCE_DIR="$SCHEMA_ROOT" REBASELINE_EVIDENCE_DIR="$REBASELINE_DIR" \
    bash "$APP/scripts/production-deploy-entrypoint.sh" >"$TMP/$name.out" 2>"$TMP/$name.err"
}
expect_cutover_ok(){ run_cutover "$@" || { cat "$TMP/$2.out"; cat "$TMP/$2.err" >&2; exit 1; }; }
expect_cutover_fail(){ if run_cutover "$@"; then cat "$TMP/$2.out"; printf 'cutover %s passou inesperadamente\n' "$2" >&2; exit 1; fi; }
no_runtime_change(){ ! grep -Eq '^docker (stop|rm|restart) |^docker compose .* up ' "$COMMAND_LOG"; }

EVIDENCE_DIR="$TMP/evidence"
REBASELINE_DIR="$TMP/rebaseline"
mkdir -p "$EVIDENCE_DIR/$SHA"
touch "$EVIDENCE_DIR/$SHA/cutover-started"

# Setup schema evidence mock
SCHEMA_ROOT="$TMP/schema"
mkdir -p "$SCHEMA_ROOT/$SHA"
migration="apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql"
migration_hash=$(sha256sum "$ROOT/$migration" | cut -d' ' -f1)
mkdir -p "$APP/${migration%/*}"
cp "$ROOT/$migration" "$APP/$migration"
printf '2026-08-27T19:00:00Z\t%s\t%s\n' "$SHA" "$migration" >"$SCHEMA_ROOT/$SHA/applied.tsv"
printf '%s  %s\n' "$migration_hash" "$migration" >"$SCHEMA_ROOT/$SHA/migration.sha256"
chmod 600 "$SCHEMA_ROOT/$SHA/applied.tsv" "$SCHEMA_ROOT/$SHA/migration.sha256"
chmod 700 "$SCHEMA_ROOT/$SHA"
chmod 700 "$SCHEMA_ROOT"

# 1. Marcador stale com CONFIRM=PRODUCTION_CUTOVER deve falhar
reset_engine yes true api,web
expect_cutover_fail PRODUCTION_CUTOVER stale
grep -q "evidência do SHA indica cutover iniciado; revisão manual obrigatória" "$TMP/stale.err"
no_runtime_change

# 2. Cutover parcialmente iniciado / container parado deve falhar na reautorização
reset_engine yes false api
expect_cutover_fail PRODUCTION_CUTOVER_REAUTHORIZED partial
grep -q "reautorização bloqueada: container anterior de api não está em execução" "$TMP/partial.err"
no_runtime_change

# 3. Marcador stale reautorizado com containers saudáveis deve arquivar a evidência e prosseguir.
# Os rótulos de rollback vêm da imagem resolvida (OLD_SHA, 0.9.0), que é a que o rollback sobe,
# e não do APP_COMMIT do ambiente do container.
reset_engine yes true api,web
printf 'not-the-image-label\n' >"$STATE/runtime-env-commit"
expect_cutover_ok PRODUCTION_CUTOVER_REAUTHORIZED reauth
grep -q "cutover reautorizado manualmente para $SHA" "$TMP/reauth.out"
ls "$EVIDENCE_DIR" | grep -q "$SHA.reauthorized-"
grep -q "method=runtime-identity verified_identity=$LEGACY_API artifact_id=$LEGACY_API" "$TMP/reauth.out"
grep -qx "ROLLBACK_APP_COMMIT=$OLD_SHA" "$EVIDENCE_DIR/$SHA/rollback-images.env"
grep -qx "ROLLBACK_APP_VERSION=0.9.0" "$EVIDENCE_DIR/$SHA/rollback-images.env"
grep -qx "ROLLBACK_APP_BUILT_AT=2026-09-01T00:00:00Z" "$EVIDENCE_DIR/$SHA/rollback-images.env"
[[ "$(awk -F'\t' '$1=="api"{print $10}' "$EVIDENCE_DIR/$SHA/previous-runtime.tsv")" == "$OLD_SHA" ]]
[[ "$(awk -F'\t' '$1=="web"{print $10}' "$EVIDENCE_DIR/$SHA/previous-runtime.tsv")" == "$OLD_SHA" ]]
grep -q '^docker compose .* up -d --no-build --no-deps api web' "$COMMAND_LOG"

# 4. Cutover concluído deve ser idempotente (runtime já serve $SHA)
touch "$EVIDENCE_DIR/$SHA/cutover-started" "$STATE/up"
expect_cutover_ok PRODUCTION_CUTOVER completed
grep -q "Cutover já concluído anteriormente para $SHA" "$TMP/completed.out"

# 5. Digest legado ausente com rebaseline válida deve restaurar OCI backup e concluir o cutover.
# O rollback sobe o artefato de rebaseline, então os rótulos gravados são os dele ($SHA),
# não os do runtime legado.
OCI_DIR="$TMP/oci-backups"
mkdir -p "$REBASELINE_DIR/$SHA" "$OCI_DIR/$SHA"
api_tar="$OCI_DIR/$SHA/gest-o-api.tar"
web_tar="$OCI_DIR/$SHA/gest-o-web.tar"
printf 'mock api tar' >"$api_tar"
printf 'mock web tar' >"$web_tar"
api_tar_sha=$(sha256sum "$api_tar" | cut -d' ' -f1)
web_tar_sha=$(sha256sum "$web_tar" | cut -d' ' -f1)
api_id="sha256:1111111111111111111111111111111111111111111111111111111111111111"
web_id="sha256:2222222222222222222222222222222222222222222222222222222222222222"

cat >"$REBASELINE_DIR/$SHA/result.tsv" <<EOF
result	PASS
rebaseline_commit	$SHA
rebaselined_at	2026-09-29T12:00:00Z
api_image_tag	gest-o-api:$SHA
api_image_id	$api_id
api_image_digest	$api_id
api_tar_path	$api_tar
api_tar_sha256	$api_tar_sha
web_image_tag	gest-o-web:$SHA
web_image_id	$web_id
web_image_digest	$web_id
web_tar_path	$web_tar
web_tar_sha256	$web_tar_sha
legacy_runtime_api_container_id	$API_CID
legacy_runtime_api_identity	$LEGACY_API
legacy_runtime_api_config_image	gest-o-api:$OLD_SHA
legacy_runtime_api_commit	$OLD_SHA
legacy_runtime_api_inspectable	no
unavailable_legacy_api_artifact	$OLD_SHA ($LEGACY_API)
unavailable_legacy_api_reason	runtime_image_not_inspectable_in_local_engine
legacy_runtime_web_container_id	$WEB_CID
legacy_runtime_web_identity	$LEGACY_WEB
legacy_runtime_web_config_image	gest-o-web:$OLD_SHA
legacy_runtime_web_commit	$OLD_SHA
legacy_runtime_web_inspectable	no
unavailable_legacy_web_artifact	$OLD_SHA ($LEGACY_WEB)
unavailable_legacy_web_reason	runtime_image_not_inspectable_in_local_engine
cutover_executed	NO
EOF
cat >"$REBASELINE_DIR/$SHA/manifest.tsv" <<EOF
role	image_tag	image_id	digest	tar_path	tar_sha256
api	gest-o-api:$SHA	$api_id	$api_id	$api_tar	$api_tar_sha
web	gest-o-web:$SHA	$web_id	$web_id	$web_tar	$web_tar_sha
EOF

rm -rf "${EVIDENCE_DIR:?}/${SHA:?}"*
reset_engine no true api,web
printf 'rebaseline-api\t%s\t%s\t1.0.0\t2026-09-29T11:00:00Z\n' "$api_id" "$SHA" >"$STATE/loadable"
printf 'rebaseline-web\t%s\t%s\t1.0.0\t2026-09-29T11:00:00Z\n' "$web_id" "$SHA" >>"$STATE/loadable"
expect_cutover_ok PRODUCTION_CUTOVER rebaseline_cutover
grep -q "method=authorized-rebaseline" "$TMP/rebaseline_cutover.out"
grep -q "verified_target_id=$api_id" "$TMP/rebaseline_cutover.out"
grep -q "^docker load -i $api_tar" "$COMMAND_LOG"
grep -qx "ROLLBACK_APP_COMMIT=$SHA" "$EVIDENCE_DIR/$SHA/rollback-images.env"
grep -qx "ROLLBACK_APP_VERSION=1.0.0" "$EVIDENCE_DIR/$SHA/rollback-images.env"
grep -qx "ROLLBACK_APP_BUILT_AT=2026-09-29T11:00:00Z" "$EVIDENCE_DIR/$SHA/rollback-images.env"
grep -q "$OLD_SHA" "$EVIDENCE_DIR/$SHA/rollback-images.env" && exit 1
[[ "$(awk -F'\t' '$1=="api"{print $10}' "$EVIDENCE_DIR/$SHA/previous-runtime.tsv")" == "$SHA" ]]

# 6. Digest legado ausente e sem rebaseline evidência deve falhar closed
rm -rf "${REBASELINE_DIR:?}" "${EVIDENCE_DIR:?}/${SHA:?}"*
reset_engine no true api,web
expect_cutover_fail PRODUCTION_CUTOVER no_rebaseline
grep -q "sem imagem anterior verificável" "$TMP/no_rebaseline.err"
no_runtime_change

# 7. Imagem de rollback verificável, mas sem rótulo de revisão: falha antes de parar qualquer container
rm -rf "${EVIDENCE_DIR:?}/${SHA:?}"*
reset_engine unlabelled true api,web
expect_cutover_fail PRODUCTION_CUTOVER unlabelled
grep -q "artefato de rollback $LEGACY_API de api sem rótulo org.opencontainers.image.revision" "$TMP/unlabelled.err"
no_runtime_change
[[ ! -e "$EVIDENCE_DIR/$SHA/cutover-started" ]]

printf 'production deploy real call graph safety passed\n'
