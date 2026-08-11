#!/usr/bin/env bash
set -Eeuo pipefail

# Recuperação operacional fail-closed. Somente metadados e checkpoints
# sanitizados são enviados ao log do GitHub Actions.
umask 077
APP_DIR="${APP_DIR:-/apps/gest-o}"
ENV_DIR="/root/demetra-env"
ENV_FILE="/root/demetra-env/.env"
LEGACY_ENV_FILE="/root/demetra-env/production.env"
COMPOSE_FILE="docker-compose.production.yml"
EXPECTED_SHA="${EXPECTED_SHA:?EXPECTED_SHA is required}"
MAX_WAIT_SECONDS="${ERP_RECOVERY_MAX_WAIT_SECONDS:-5400}"
POLL_SECONDS="${ERP_RECOVERY_POLL_SECONDS:-30}"
EVIDENCE_DIR="${ERP_RECOVERY_EVIDENCE_ROOT:-/var/log/gest-o/erp-recovery}/$EXPECTED_SHA-$(date -u +%Y%m%dT%H%M%SZ)"

log(){ printf '[erp-recovery] %s\n' "$*"; }
die(){ log "FAIL_STAGE=${STAGE:-initial}: $*" >&2; return 1; }
need(){ command -v "$1" >/dev/null 2>&1 || die "required command unavailable: $1"; }
[[ "${CONFIRM:-}" == RESTORE_ERP_AUTOMATIC_SYNC ]] || die 'literal confirmation is required'
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'EXPECTED_SHA must be a full lowercase SHA'
[[ "$MAX_WAIT_SECONDS" =~ ^[0-9]+$ && "$POLL_SECONDS" =~ ^[0-9]+$ ]] || die 'bounded wait settings are invalid'
for command in awk bash curl docker git install jq mktemp node sed stat; do need "$command"; done
cd "$APP_DIR"
[[ "$(git branch --show-current)" == main ]] || die 'checkout is not main'
[[ "$(git rev-parse HEAD)" == "$EXPECTED_SHA" ]] || die 'main SHA differs from approved SHA'
[[ -z "$(git status --porcelain)" ]] || die 'production checkout is not clean'
install -d -o root -g root -m 700 "$ENV_DIR" "$ENV_DIR/backups" "$EVIDENCE_DIR"

valid_protected_env(){
  local file=$1
  [[ -f "$file" && ! -L "$file" ]] || return 1
  [[ "$(stat -c '%U:%G' "$file")" == root:root ]] || return 1
  [[ "$(stat -c '%a' "$file")" == 600 ]] || return 1
}

STAGE=environment_source
if valid_protected_env "$ENV_FILE"; then
  ENV_SOURCE=canonical
elif [[ ! -e "$ENV_FILE" && ! -L "$ENV_FILE" ]] && valid_protected_env "$LEGACY_ENV_FILE"; then
  source_backup="$ENV_DIR/backups/legacy-source-$(date -u +%Y%m%dT%H%M%SZ).backup"
  install -o root -g root -m 600 "$LEGACY_ENV_FILE" "$source_backup"
  install -o root -g root -m 600 "$LEGACY_ENV_FILE" "$ENV_FILE"
  ENV_SOURCE=legacy_copy
else
  log 'ERP_ENV_RECOVERY_SOURCE=NOT_AVAILABLE'
  die 'canonical and authorized legacy environment sources are unavailable or invalid'
fi
log "ERP_ENV_SOURCE=$ENV_SOURCE"
log 'ERP_ENV_METADATA=REGULAR_NON_SYMLINK_ROOT_ROOT_600'

STAGE=scheduler_gate
gate_count="$(awk -F= '$1=="ERP_SYNC_SCHEDULER_ENABLED"{n++} END{print n+0}' "$ENV_FILE")"
[[ "$gate_count" -le 1 ]] || die 'duplicate scheduler gate definition'
env_backup="$ENV_DIR/backups/erp-scheduler-before-$EXPECTED_SHA-$(date -u +%Y%m%dT%H%M%SZ).backup"
install -o root -g root -m 600 "$ENV_FILE" "$env_backup"
tmp_env="$(mktemp "$ENV_DIR/.env.recovery.XXXXXX")"
cleanup(){ rm -f "${tmp_env:-}" "${preflight_output:-}" "${rendered:-}" "${technical_file:-}"; }
trap cleanup EXIT
if [[ "$gate_count" -eq 1 ]]; then
  awk -F= 'BEGIN{OFS="="} $1=="ERP_SYNC_SCHEDULER_ENABLED"{$0="ERP_SYNC_SCHEDULER_ENABLED=true"} {print}' "$ENV_FILE" >"$tmp_env"
else
  cat "$ENV_FILE" >"$tmp_env"
  printf '\nERP_SYNC_SCHEDULER_ENABLED=true\n' >>"$tmp_env"
fi
chown root:root "$tmp_env"; chmod 600 "$tmp_env"
bash -n "$tmp_env" || die 'candidate environment syntax is invalid'
[[ "$(awk -F= '$1=="ERP_SYNC_SCHEDULER_ENABLED"{n++; if($2=="true")ok++} END{print n":"ok}' "$tmp_env")" == 1:1 ]] || die 'candidate scheduler gate is invalid'
install -o root -g root -m 600 "$tmp_env" "$ENV_FILE"
rm -f "$tmp_env"; tmp_env=''

restore_env(){ install -o root -g root -m 600 "$env_backup" "$ENV_FILE"; }
API_CHANGED=false
rollback(){
  local failed_stage=$STAGE
  trap - ERR
  set +e
  log "ERP_RECOVERY_ROLLBACK=STARTED stage=$failed_stage"
  restore_env
  unset ERP_SYNC_SCHEDULER_ENABLED
  set -a; source "$ENV_FILE"; set +a
  export ERP_SYNC_SCHEDULER_ENABLED="${ERP_SYNC_SCHEDULER_ENABLED:-false}"
  if [[ "$API_CHANGED" == true ]]; then
    export API_IMAGE="$ROLLBACK_API_IMAGE" WEB_IMAGE="$CURRENT_WEB_IMAGE"
    export APP_COMMIT="$ROLLBACK_APP_COMMIT" APP_VERSION="$ROLLBACK_APP_VERSION" APP_BUILT_AT="$ROLLBACK_APP_BUILT_AT"
    "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate api
    rollback_id="$("${COMPOSE[@]}" ps -q api)"
    for _ in {1..36}; do [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$rollback_id")" == healthy ]] && break; sleep 5; done
    if [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$rollback_id")" == healthy ]] && curl -fsS http://127.0.0.1:4000/health >/dev/null; then
      log 'ERP_ROLLBACK_API_HEALTH=PASS'
    else
      log 'ERP_ROLLBACK_API_HEALTH=FAIL'
    fi
  fi
  log 'ERP_RECOVERY_ROLLBACK=COMPLETED'
  log 'INC_ERP_5050=INVESTIGATING'
  exit 1
}
trap rollback ERR

STAGE=preflight
preflight_output="$(mktemp)"
if ! PRODUCTION_ENV_FILE="$ENV_FILE" bash scripts/erp-production-env-preflight.sh >"$preflight_output" 2>&1; then
  restore_env; die 'ERP environment preflight failed; protected output omitted'
fi
for marker in 'ERP_EXTERNAL_ENV=PRESENT' 'ERP_SCHEDULER_ENV=ENABLED' 'PASS: protected production ERP environment contract is valid; values omitted'; do
  grep -Fq "$marker" "$preflight_output" || { restore_env; die 'ERP environment preflight omitted a required marker'; }
done
rm -f "$preflight_output"; preflight_output=''
set -a; source "$ENV_FILE"; set +a
bash scripts/production-preflight.sh >/dev/null
: "${API_IMAGE:?API_IMAGE must identify the approved API release}"
: "${WEB_IMAGE:?WEB_IMAGE must identify the current WEB release}"
: "${APP_COMMIT:?APP_COMMIT is required}"
: "${APP_VERSION:?APP_VERSION is required}"
: "${APP_BUILT_AT:?APP_BUILT_AT is required}"
: "${AUTH_TEST_EMAIL:?AUTH_TEST_EMAIL must be present in the protected environment}"
: "${AUTH_TEST_PASSWORD:?AUTH_TEST_PASSWORD must be present in the protected environment}"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_VOLUME_EXPECTED:?PRODUCTION_DB_VOLUME_EXPECTED is required}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
rendered="$(mktemp)"; "${COMPOSE[@]}" config >"$rendered"; rm -f "$rendered"; rendered=''
log 'ERP_PRODUCTION_ENV_PREFLIGHT=PASS'

STAGE=inventory
api_id="$("${COMPOSE[@]}" ps -q api)"; web_id="$("${COMPOSE[@]}" ps -q web)"
[[ -n "$api_id" && -n "$web_id" ]] || die 'API or WEB container is absent'
api_count="$(docker ps --filter label=com.docker.compose.project=gest-o-production --filter label=com.docker.compose.service=api -q | wc -l)"
[[ "$api_count" -eq 1 ]] || die 'API instance count differs from one'
[[ "$(docker inspect -f '{{.State.Running}}' "$web_id")" == true ]] || die 'WEB is not running'
[[ "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")" == true ]] || die 'PostgreSQL is not running'
db_mounts_before="$(docker inspect -f '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")"
grep -Fq "$PRODUCTION_DB_VOLUME_EXPECTED /var/lib/postgresql/data" <<<"$db_mounts_before" || die 'approved PostgreSQL volume is not mounted'
web_identity_before="$(docker inspect -f '{{.Id}}|{{.Image}}' "$web_id")"
db_identity_before="$(docker inspect -f '{{.Id}}|{{.Image}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")"
old_api_image_id="$(docker inspect -f '{{.Image}}' "$api_id")"
old_api_image_ref="$(docker inspect -f '{{.Config.Image}}' "$api_id")"
old_api_commit="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$api_id" | sed -n 's/^APP_COMMIT=//p' | head -1)"
old_api_version="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$old_api_image_id" 2>/dev/null || true)"
old_api_built_at="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.created"}}' "$old_api_image_id" 2>/dev/null || true)"
[[ -n "$old_api_commit" && -n "$old_api_version" && -n "$old_api_built_at" ]] || die 'previous API rollback metadata cannot be resolved'
ROLLBACK_API_IMAGE="gest-o-api-recovery-rollback:${old_api_image_id#sha256:}"
docker tag "$old_api_image_id" "$ROLLBACK_API_IMAGE"
ROLLBACK_APP_COMMIT="$old_api_commit"; ROLLBACK_APP_VERSION="$old_api_version"; ROLLBACK_APP_BUILT_AT="$old_api_built_at"
CURRENT_WEB_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$web_id")"
target_api_image="gest-o-api:$EXPECTED_SHA"
docker image inspect "$target_api_image" >/dev/null 2>&1 || die 'approved API image is not available locally; build phase is required first'
runtime_sha="$(curl -fsS http://127.0.0.1:4000/health/version | jq -r '.commit // empty')"
restart_before="$(docker inspect -f '{{.RestartCount}}' "$api_id")"
health_before="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$api_id")"
log "PRODUCTION_MAIN_SHA=$EXPECTED_SHA"
log "API_RUNTIME_SHA=${runtime_sha:-not_proven}"
log "API_CONTAINER_ID_PREFIX=${api_id:0:12}"
log "API_IMAGE_ID_PREFIX=${old_api_image_id:7:12}"
log "API_RESTART_COUNT=$restart_before"
log "API_HEALTH=$health_before"
log "API_INSTANCE_COUNT=$api_count"
log "ERP_SCHEDULER_ENV=enabled"

technical_file="$(mktemp)"
technical_snapshot(){
  docker exec -i "$1" node >"$technical_file" <<'NODE'
const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient();
(async()=>{const c=await p.appConfig.findUnique({where:{key:'erp.automaticSync.config'},select:{value:true}});
let enabled=false;try{enabled=JSON.parse(c?.value||'{}').enabled===true}catch{}
const locks=await p.erpSyncLock.findMany({select:{lockedUntil:true}});const now=Date.now();
const active=locks.some(x=>x.lockedUntil.getTime()>now),orphan=locks.some(x=>x.lockedUntil.getTime()<=now);
console.log(`APP_CONFIG=${enabled?'enabled':'disabled'}`);console.log(`LOCK_STATE=${orphan?'orphan':active?'active':'free'}`);
})().finally(()=>p.$disconnect()).catch(()=>process.exit(1));
NODE
}
technical_snapshot "$api_id"
app_config="$(sed -n 's/^APP_CONFIG=//p' "$technical_file")"; lock_state="$(sed -n 's/^LOCK_STATE=//p' "$technical_file")"
[[ "$app_config" == enabled ]] || die 'persisted AppConfig does not enable the scheduler'
[[ "$lock_state" != orphan ]] || die 'orphan ERP lock detected'
log "ERP_APP_CONFIG=$app_config"; log "ERP_LOCK_STATE=$lock_state"; log 'ERP_NEXT_RUN_AT=not_proven'

STAGE=api_recreate
export API_IMAGE="$target_api_image" WEB_IMAGE="$CURRENT_WEB_IMAGE"
export APP_COMMIT="$EXPECTED_SHA" APP_VERSION="$(node -p "require('./package.json').version")" APP_BUILT_AT="$(date -u +%FT%TZ)"
"${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate api
API_CHANGED=true
new_api_id="$("${COMPOSE[@]}" ps -q api)"
for _ in {1..36}; do [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$new_api_id")" == healthy ]] && break; sleep 5; done
[[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$new_api_id")" == healthy ]] || die 'recreated API did not become healthy'
[[ "$(curl -fsS http://127.0.0.1:4000/health/version | jq -r '.commit')" == "$EXPECTED_SHA" ]] || die 'API runtime SHA differs from expected SHA'
[[ "$(docker inspect -f '{{.RestartCount}}' "$new_api_id")" == 0 ]] || die 'recreated API restart count is not stable'
[[ "$(docker ps --filter label=com.docker.compose.project=gest-o-production --filter label=com.docker.compose.service=api -q | wc -l)" -eq 1 ]] || die 'multiple API instances detected after recreation'
[[ "$(docker inspect -f '{{.Id}}|{{.Image}}' "$web_id")" == "$web_identity_before" ]] || die 'WEB identity changed'
[[ "$(docker inspect -f '{{.Id}}|{{.Image}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")" == "$db_identity_before" ]] || die 'PostgreSQL identity changed'
[[ "$(docker inspect -f '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")" == "$db_mounts_before" ]] || die 'PostgreSQL mounts changed'
curl -fsS http://127.0.0.1:4000/health >/dev/null

STAGE=authenticated_validation
API_BASE=http://127.0.0.1:4000 AUTH_TEST_EMAIL="$AUTH_TEST_EMAIL" AUTH_TEST_PASSWORD="$AUTH_TEST_PASSWORD" node >"$technical_file" <<'NODE'
(async()=>{const login=await fetch(process.env.API_BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:process.env.AUTH_TEST_EMAIL,password:process.env.AUTH_TEST_PASSWORD})});
let b={};try{b=await login.json()}catch{};if(login.status!==200||!b.accessToken)process.exit(1);const h={authorization:`Bearer ${b.accessToken}`};
const [me,s]=await Promise.all([fetch(process.env.API_BASE+'/auth/me',{headers:h}),fetch(process.env.API_BASE+'/erp/ultrafv3/sync/status',{headers:h})]);if(me.status!==200||s.status!==200)process.exit(1);
const j=await s.json(),a=j.automaticSync||{};console.log(`INITIALIZED=${a.initialized===true}`);console.log(`ENABLED=${a.enabled===true&&a.enabledByEnv===true}`);console.log(`CONFIG_OK=${a.configurationOk===true}`);console.log(`AUTH_MODE=${a.authMode||'none'}`);console.log(`NEXT_RUN_AT=${a.nextRunAt||''}`);
})().catch(()=>process.exit(1));
NODE
initialized="$(sed -n 's/^INITIALIZED=//p' "$technical_file")"; enabled="$(sed -n 's/^ENABLED=//p' "$technical_file")"
config_ok="$(sed -n 's/^CONFIG_OK=//p' "$technical_file")"; auth_mode="$(sed -n 's/^AUTH_MODE=//p' "$technical_file")"; next_run_at="$(sed -n 's/^NEXT_RUN_AT=//p' "$technical_file")"
[[ "$initialized" == true && "$enabled" == true && "$config_ok" == true ]] || die 'scheduler did not initialize with a valid configuration'
[[ "$auth_mode" == global || "$auth_mode" == seller_reference ]] || die 'global or decryptable seller-reference credentials were not proven'
[[ -n "$next_run_at" ]] || die 'nextRunAt is absent'
recreated_at="$(date -u +%FT%TZ)"
log 'ERP_API_RECREATE=PASS'; log 'ERP_API_HEALTH=PASS'; log 'ERP_PRODUCTION_LOGIN=PASS'
log 'ERP_SCHEDULER_INITIALIZED=PASS'; log 'ERP_NEXT_RUN_AT=PRESENT'

STAGE=automatic_proof
deadline=$(( $(date +%s) + MAX_WAIT_SECONDS )); automatic_proven=false
while (( $(date +%s) < deadline )); do
  docker exec -i "$new_api_id" env RECREATED_AT="$recreated_at" node >"$technical_file" <<'NODE'
const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
(async()=>{const since=new Date(process.env.RECREATED_AT);const runs=await p.erpSyncRun.findMany({where:{scope:'automatic',trigger:'scheduler',startedAt:{gt:since}},orderBy:{startedAt:'desc'},select:{status:true,startedAt:true,finishedAt:true,correlationId:true,errorMessage:true,syncedCount:true,metrics:true}});
const latest=runs[0],success=latest?.status==='success'&&latest.finishedAt&&latest.correlationId?latest:null;const concurrent=runs.filter(r=>r.status==='running').length;
const locks=await p.erpSyncLock.findMany({select:{lockedUntil:true}});const orphan=locks.some(l=>l.lockedUntil<=new Date());
const completed=Array.isArray(success?.metrics?.completedSteps)?success.metrics.completedSteps.length:0;
console.log(`SUCCESS=${Boolean(success)}`);console.log(`DUPLICATE=${concurrent>1}`);console.log(`LOCK=${orphan?'orphan':locks.length?'active':'free'}`);if(success){console.log(`STARTED_AT=${success.startedAt.toISOString()}`);console.log(`FINISHED_AT=${success.finishedAt.toISOString()}`);console.log(`CORRELATION_ID=${success.correlationId}`);console.log(`LOCK_ACQUIRED=${success.syncedCount>0&&completed>0}`)}
})().finally(()=>p.$disconnect()).catch(()=>process.exit(1));
NODE
  [[ "$(sed -n 's/^DUPLICATE=//p' "$technical_file")" == false ]] || die 'duplicate automatic scheduler executions detected'
  [[ "$(sed -n 's/^LOCK=//p' "$technical_file")" != orphan ]] || die 'orphan lock detected during automatic proof'
  if [[ "$(sed -n 's/^SUCCESS=//p' "$technical_file")" == true ]]; then automatic_proven=true; break; fi
  sleep "$POLL_SECONDS"
done
[[ "$automatic_proven" == true ]] || die 'bounded window expired without a successful automatic scheduler run'
[[ "$(sed -n 's/^LOCK_ACQUIRED=//p' "$technical_file")" == true ]] || die 'successful run did not prove execution through locked sync steps'
log "ERP_AUTOMATIC_STARTED_AT=$(sed -n 's/^STARTED_AT=//p' "$technical_file")"
log "ERP_AUTOMATIC_FINISHED_AT=$(sed -n 's/^FINISHED_AT=//p' "$technical_file")"
log "ERP_AUTOMATIC_CORRELATION_ID=$(sed -n 's/^CORRELATION_ID=//p' "$technical_file")"
logs="$(docker logs --since "$recreated_at" "$new_api_id" 2>&1)"
! grep -Fq 'scheduler_disabled' <<<"$logs" || die 'scheduler_disabled was emitted after recreation'
grep -Fq '[ultrafv3 scheduler] run started' <<<"$logs" || die 'scheduler start log is absent'
grep -Fq '[ultrafv3 scheduler] run finished' <<<"$logs" || die 'scheduler finish log is absent'
technical_snapshot "$new_api_id"; [[ "$(sed -n 's/^LOCK_STATE=//p' "$technical_file")" == free ]] || die 'ERP sync lock was not released'
API_BASE=http://127.0.0.1:4000 AUTH_TEST_EMAIL="$AUTH_TEST_EMAIL" AUTH_TEST_PASSWORD="$AUTH_TEST_PASSWORD" node >"$technical_file" <<'NODE'
(async()=>{const login=await fetch(process.env.API_BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:process.env.AUTH_TEST_EMAIL,password:process.env.AUTH_TEST_PASSWORD})});let b={};try{b=await login.json()}catch{};if(login.status!==200||!b.accessToken)process.exit(1);const r=await fetch(process.env.API_BASE+'/erp/ultrafv3/sync/status',{headers:{authorization:`Bearer ${b.accessToken}`}});if(r.status!==200)process.exit(1);const a=(await r.json()).automaticSync||{};console.log(`NEXT_RUN_AT=${a.nextRunAt||''}`);console.log(`ACTIVE_ERROR=${Boolean(a.lastError)}`)})().catch(()=>process.exit(1));
NODE
[[ -n "$(sed -n 's/^NEXT_RUN_AT=//p' "$technical_file")" ]] || die 'nextRunAt was not recalculated after the automatic run'
[[ "$(sed -n 's/^ACTIVE_ERROR=//p' "$technical_file")" == false ]] || die 'an active automatic scheduler error remains'
install -o root -g root -m 600 "$ENV_FILE" "$ENV_DIR/backups/erp-scheduler-proven-$EXPECTED_SHA-$(date -u +%Y%m%dT%H%M%SZ).backup"
valid_protected_env "$ENV_FILE" || die 'protected environment metadata did not persist'
log 'ERP_AUTOMATIC_TRIGGER=scheduler'; log 'ERP_AUTOMATIC_SYNC=PASS'; log 'ERP_SYNC_LOCK=RELEASED'; log 'ERP_SYNC_ENV_PERSISTENCE=PASS'
log 'INC_ERP_5050=RESOLVED_CANDIDATE_REQUIRES_DOCUMENTATION_UPDATE'
trap - ERR
