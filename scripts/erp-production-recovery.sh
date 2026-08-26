#!/usr/bin/env bash
set -Eeuo pipefail

# Recuperação operacional fail-closed. Somente metadados e checkpoints
# sanitizados são enviados ao log do GitHub Actions.
umask 077
APP_DIR="${APP_DIR:-/apps/gest-o}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Produção usa exclusivamente /root/demetra-env/.env e a fonte legado
# /root/demetra-env/production.env; o override existe somente para o harness isolado.
ENV_DIR="${ERP_RECOVERY_ENV_DIR:-/root/demetra-env}"
ENV_FILE="$ENV_DIR/.env"
LEGACY_ENV_FILE="$ENV_DIR/production.env"
COMPOSE_FILE="docker-compose.production.yml"
EXPECTED_SHA="${EXPECTED_SHA:?EXPECTED_SHA is required}"
MAX_WAIT_SECONDS="${ERP_RECOVERY_MAX_WAIT_SECONDS:-5400}"
POLL_SECONDS="${ERP_RECOVERY_POLL_SECONDS:-30}"
EVIDENCE_ROOT="${ERP_RECOVERY_EVIDENCE_ROOT:-/var/log/gest-o/erp-recovery}"
EVIDENCE_DIR="$EVIDENCE_ROOT/$EXPECTED_SHA-$(date -u +%Y%m%dT%H%M%SZ)"

log(){ printf '[erp-recovery] %s\n' "$*"; }
die(){ log "FAIL_STAGE=${STAGE:-initial}: $*" >&2; return 1; }
need(){ command -v "$1" >/dev/null 2>&1 || die "required command unavailable: $1"; }
# FASE 0 — confirmação e checkout (somente leitura)
[[ "${CONFIRM:-}" == RESTORE_ERP_AUTOMATIC_SYNC ]] || die 'literal confirmation is required'
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'EXPECTED_SHA must be a full lowercase SHA'
[[ "$MAX_WAIT_SECONDS" =~ ^[0-9]+$ && "$POLL_SECONDS" =~ ^[0-9]+$ ]] || die 'bounded wait settings are invalid'
for command in awk bash curl docker git install jq mktemp node sed stat; do need "$command"; done
cd "$APP_DIR"
[[ "$(git branch --show-current)" == main ]] || die 'checkout is not main'
[[ "$(git rev-parse HEAD)" == "$EXPECTED_SHA" ]] || die 'main SHA differs from approved SHA'
[[ -z "$(git status --porcelain)" ]] || die 'production checkout is not clean'

valid_protected_env(){
  local file=$1
  [[ -f "$file" && ! -L "$file" ]] || return 1
  [[ "$(stat -c '%U:%G' "$file")" == root:root ]] || return 1
  [[ "$(stat -c '%a' "$file")" == 600 ]] || return 1
}

# FASE 1 — descoberta e inventário integralmente read-only
STAGE=environment_source
if valid_protected_env "$ENV_FILE"; then
  ENV_SOURCE=canonical; SOURCE_ENV_FILE="$ENV_FILE"; CANONICAL_EXISTED=true
elif [[ ! -e "$ENV_FILE" && ! -L "$ENV_FILE" ]] && valid_protected_env "$LEGACY_ENV_FILE"; then
  ENV_SOURCE=legacy_copy; SOURCE_ENV_FILE="$LEGACY_ENV_FILE"; CANONICAL_EXISTED=false
else
  log 'ERP_ENV_RECOVERY_SOURCE=NOT_AVAILABLE'
  die 'canonical and authorized legacy environment sources are unavailable or invalid'
fi
log "ERP_ENV_SOURCE=$ENV_SOURCE"
log 'ERP_ENV_METADATA=REGULAR_NON_SYMLINK_ROOT_ROOT_600'

STAGE=protected_inputs
: "${AUTH_TEST_EMAIL:?AUTH_TEST_EMAIL is required from the protected GitHub environment secret}"
: "${AUTH_TEST_PASSWORD:?AUTH_TEST_PASSWORD is required from the protected GitHub environment secret}"
readonly AUTH_VALIDATION_EMAIL="$AUTH_TEST_EMAIL" AUTH_VALIDATION_PASSWORD="$AUTH_TEST_PASSWORD"
unset AUTH_TEST_EMAIL AUTH_TEST_PASSWORD
log 'ERP_RECOVERY_AUTH_INPUT=AVAILABLE'

# O env empresarial fornece apenas configuração persistente. Metadados de release são
# reconstruídos nesta nova sessão e nunca são gravados no arquivo protegido.
# Validate syntax before trusted operator input is loaded. The closed-gate
# duplicate validation is repeated by the candidate primitive for legacy input.
awk '/^[[:space:]]*($|#)/{next} /^[A-Za-z_][A-Za-z0-9_]*=/{next} {exit 1}' "$SOURCE_ENV_FILE" || die 'protected environment contains a malformed line'
set -a; source "$SOURCE_ENV_FILE"; set +a
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_VOLUME_EXPECTED:?PRODUCTION_DB_VOLUME_EXPECTED is required}"

STAGE=runtime_derivation
unique_container(){
  local service=$1 ids count
  ids="$(docker ps --filter label=com.docker.compose.project=gest-o-production --filter label=com.docker.compose.service="$service" -q)"
  count="$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l)"
  [[ "$count" -eq 1 ]] || { die "$service instance count differs from one"; return 1; }
  printf '%s' "$ids"
}
api_id="$(unique_container api)" || exit $?
web_id="$(unique_container web)" || exit $?
[[ "$(docker inspect -f '{{.State.Running}}' "$api_id")" == true ]] || die 'API is not running'
[[ "$(docker inspect -f '{{.State.Running}}' "$web_id")" == true ]] || die 'WEB is not running'
CURRENT_WEB_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$web_id")"
[[ -n "$CURRENT_WEB_IMAGE" && "$CURRENT_WEB_IMAGE" != *:latest ]] || die 'current WEB image is not an immutable runtime reference'
export APP_COMMIT="$EXPECTED_SHA"
export APP_VERSION="$(node -p "require('./package.json').version")"
export APP_BUILT_AT="$(date -u +%FT%TZ)"
export API_IMAGE="gest-o-api:$EXPECTED_SHA"
export WEB_IMAGE="$CURRENT_WEB_IMAGE"
[[ "$APP_COMMIT" == "$(git rev-parse HEAD)" ]] || die 'derived APP_COMMIT differs from checkout'
docker image inspect "$API_IMAGE" >/dev/null 2>&1 || die 'approved API image is not available locally; build phase is required first'
if ! target_revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$API_IMAGE" 2>/dev/null)"; then
  die 'approved API image revision label cannot be read'
fi
[[ "$target_revision" == "$EXPECTED_SHA" ]] || die 'approved API image revision label differs from EXPECTED_SHA'
COMPOSE=(docker compose --env-file "$SOURCE_ENV_FILE" -f "$COMPOSE_FILE")
"${COMPOSE[@]}" config >/dev/null

STAGE=readonly_inventory
[[ "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")" == true ]] || die 'PostgreSQL is not running'
db_mounts_before="$(docker inspect -f '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")"
grep -Fq "$PRODUCTION_DB_VOLUME_EXPECTED /var/lib/postgresql/data" <<<"$db_mounts_before" || die 'approved PostgreSQL volume is not mounted'
web_identity_before="$(docker inspect -f '{{.Id}}|{{.Image}}' "$web_id")"
db_identity_before="$(docker inspect -f '{{.Id}}|{{.Image}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")"
old_api_image_id="$(docker inspect -f '{{.Image}}' "$api_id")"
old_api_commit="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$api_id" | sed -n 's/^APP_COMMIT=//p' | head -1)"
if ! old_api_version="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$old_api_image_id" 2>/dev/null)"; then
  die 'previous API version label cannot be read'
fi
if ! old_api_built_at="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.created"}}' "$old_api_image_id" 2>/dev/null)"; then
  die 'previous API creation label cannot be read'
fi
[[ -n "$old_api_commit" && -n "$old_api_version" && -n "$old_api_built_at" ]] || die 'previous API rollback metadata cannot be resolved'
ROLLBACK_API_IMAGE="gest-o-api-recovery-rollback:${old_api_image_id#sha256:}"
ROLLBACK_APP_COMMIT="$old_api_commit"; ROLLBACK_APP_VERSION="$old_api_version"; ROLLBACK_APP_BUILT_AT="$old_api_built_at"
runtime_sha="$(curl -fsS http://127.0.0.1:4000/health/version | jq -r '.commit // empty')"
restart_before="$(docker inspect -f '{{.RestartCount}}' "$api_id")"
health_before="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$api_id")"
technical_snapshot(){
  docker exec -i "$1" node <<'NODE'
const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient();
(async()=>{const c=await p.appConfig.findUnique({where:{key:'erp.automaticSync.config'},select:{value:true}});
let enabled=false;try{enabled=JSON.parse(c?.value||'{}').enabled===true}catch{}
const locks=await p.erpSyncLock.findMany({select:{lockedUntil:true}});const now=Date.now();
const active=locks.some(x=>x.lockedUntil.getTime()>=now),expired=locks.some(x=>x.lockedUntil.getTime()<now);
console.log(`APP_CONFIG=${enabled?'enabled':'disabled'}`);console.log(`LOCK_STATE=${active?'active':expired?'expired_recoverable':'free'}`);
})().finally(()=>p.$disconnect()).catch(()=>process.exit(1));
NODE
}
technical_state="$(technical_snapshot "$api_id")"
app_config="$(sed -n 's/^APP_CONFIG=//p' <<<"$technical_state")"; lock_state="$(sed -n 's/^LOCK_STATE=//p' <<<"$technical_state")"
[[ "$app_config" == enabled ]] || die 'persisted AppConfig does not enable the scheduler'
[[ "$lock_state" != active ]] || die 'a legitimate active ERP lock blocks API recreation'
log "PRODUCTION_MAIN_SHA=$EXPECTED_SHA"
log "API_RUNTIME_SHA=${runtime_sha:-not_proven}"
log "API_CONTAINER_ID_PREFIX=${api_id:0:12}"
log "API_IMAGE_ID_PREFIX=${old_api_image_id:7:12}"
log "API_RESTART_COUNT=$restart_before"
log "API_HEALTH=$health_before"
log 'API_INSTANCE_COUNT=1'
log "ERP_APP_CONFIG=$app_config"; log "ERP_LOCK_STATE=$lock_state"

# FASE 2 — preparação reversível. Todos os gates anteriores são read-only.
STAGE=candidate_preparation
install -d -o root -g root -m 700 "$ENV_DIR/backups" "$EVIDENCE_DIR"
env_backup="$ENV_DIR/backups/erp-scheduler-before-$EXPECTED_SHA-$(date -u +%Y%m%dT%H%M%SZ).backup"
install -o root -g root -m 600 "$SOURCE_ENV_FILE" "$env_backup"
[[ "$ENV_SOURCE" == canonical ]] || install -o root -g root -m 600 "$LEGACY_ENV_FILE" "$ENV_DIR/backups/legacy-source-$(date -u +%Y%m%dT%H%M%SZ).backup"
tmp_env="$(mktemp "$ENV_DIR/.env.recovery.XXXXXX")"
cleanup(){ local rc=$?; rm -f "${tmp_env:-}" "${preflight_output:-}" "${rendered:-}" "${technical_file:-}"; return "$rc"; }
trap cleanup EXIT
if [[ "$ENV_SOURCE" == legacy_copy ]]; then
  # This is the sole runtime caller authorized to request recovery_legacy, and
  # it runs only after confirmation, SHA/image/auth checks and read-only inventory.
  # shellcheck source=scripts/production-env-reconcile.sh
  source "$SCRIPT_DIR/production-env-reconcile.sh"
  reconcile_production_env recovery_legacy "$SOURCE_ENV_FILE" "$tmp_env" >/dev/null
else
  gate_count="$(awk -F= '$1=="ERP_SYNC_SCHEDULER_ENABLED"{n++} END{print n+0}' "$SOURCE_ENV_FILE")"
  [[ "$gate_count" -eq 1 ]] || die 'scheduler gate must exist exactly once before recovery'
  awk -F= 'BEGIN{OFS="="} $1=="ERP_SYNC_SCHEDULER_ENABLED"{$0="ERP_SYNC_SCHEDULER_ENABLED=true"} {print}' "$SOURCE_ENV_FILE" >"$tmp_env"
fi
chown root:root "$tmp_env"; chmod 600 "$tmp_env"; bash -n "$tmp_env"
[[ "$(awk -F= '$1=="ERP_SYNC_SCHEDULER_ENABLED"{n++; if($2=="true")ok++} END{print n":"ok}' "$tmp_env")" == 1:1 ]] || die 'candidate scheduler gate is invalid'

restore_env(){
  if [[ "$CANONICAL_EXISTED" == true ]]; then install -o root -g root -m 600 "$env_backup" "$ENV_FILE";
  else rm -f "$ENV_FILE"; fi
}
API_CHANGED=false
rollback(){
  local failed_stage=$STAGE
  trap - ERR
  set +e
  log "ERP_RECOVERY_ROLLBACK=STARTED stage=$failed_stage"
  restore_env
  unset ERP_SYNC_SCHEDULER_ENABLED
  set -a; source "$env_backup"; set +a
  export ERP_SYNC_SCHEDULER_ENABLED="${ERP_SYNC_SCHEDULER_ENABLED:-false}"
  if [[ "$API_CHANGED" == true ]]; then
    export API_IMAGE="$ROLLBACK_API_IMAGE" WEB_IMAGE="$CURRENT_WEB_IMAGE"
    export APP_COMMIT="$ROLLBACK_APP_COMMIT" APP_VERSION="$ROLLBACK_APP_VERSION" APP_BUILT_AT="$ROLLBACK_APP_BUILT_AT"
    COMPOSE=(docker compose --env-file "$env_backup" -f "$COMPOSE_FILE")
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
if ! PRODUCTION_ENV_FILE="$tmp_env" ERP_ENV_EXPECTED_OWNER=root:root bash scripts/erp-production-env-preflight.sh >"$preflight_output" 2>&1; then
  failure_code="$(sed -n 's/^ERP_ENV_PREFLIGHT_FAILURE=//p' "$preflight_output" | head -1)"
  [[ "$failure_code" =~ ^(ERP_SYNC_SCHEDULER_ENABLED|TENANCY_MODE|TENANT_READ_PILOT_ENABLED|DATABASE_SCHEMA_MODE|SEED_ON_BOOTSTRAP|ENABLE_PREVIEW_SEED|ENABLE_SMOKE_BOOTSTRAP)_POLICY$ ]] && log "ERP_RECOVERY_PREFLIGHT_FAILURE=$failure_code"
  die 'ERP environment preflight failed; protected output omitted'
fi
for marker in 'ERP_EXTERNAL_ENV=PRESENT' 'ERP_SCHEDULER_ENV=ENABLED' 'PASS: protected production ERP environment contract is valid; values omitted'; do
  grep -Fq "$marker" "$preflight_output" || die 'ERP environment preflight omitted a required marker'
done
rm -f "$preflight_output"; preflight_output=''
set -a; source "$tmp_env"; set +a
# production-preflight owns canonical resolution for every consumer. Legacy
# artifact paths loaded above remain non-authoritative hints.
PRODUCTION_PREFLIGHT_MODE=cutover bash scripts/production-preflight.sh >/dev/null
COMPOSE=(docker compose --env-file "$tmp_env" -f "$COMPOSE_FILE")
rendered="$(mktemp)"; "${COMPOSE[@]}" config >"$rendered"; rm -f "$rendered"; rendered=''
log 'ERP_PRODUCTION_ENV_PREFLIGHT=PASS'
if [[ "${ERP_RECOVERY_TEST_STOP_AFTER_COMPOSE:-false}" == true ]]; then
  log 'ERP_RECOVERY_TEST_PREPARED=PASS'
  exit 0
fi

technical_file="$(mktemp)"
log 'ERP_SCHEDULER_ENV=enabled'; log 'ERP_NEXT_RUN_AT=not_proven'

# FASE 3 — primeiro efeito persistente
STAGE=environment_commit
install -o root -g root -m 600 "$tmp_env" "$ENV_FILE"
valid_protected_env "$ENV_FILE" || die 'committed environment metadata is invalid'
[[ "$(awk -F= '$1=="ERP_SYNC_SCHEDULER_ENABLED"{n++; if($2=="true")ok++} END{print n":"ok}' "$ENV_FILE")" == 1:1 ]] || die 'committed scheduler gate is invalid'
docker tag "$old_api_image_id" "$ROLLBACK_API_IMAGE"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

API_CHANGED=true
STAGE=api_recreate
"${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate api
if [[ "${ERP_RECOVERY_TEST_FAIL_AFTER_RECREATE:-false}" == true ]]; then
  die 'injected post-recreate failure'
fi
new_api_id="$("${COMPOSE[@]}" ps -q api)"
# FASE 4 — validação imediata e prova automática bounded
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
API_BASE=http://127.0.0.1:4000 AUTH_TEST_EMAIL="$AUTH_VALIDATION_EMAIL" AUTH_TEST_PASSWORD="$AUTH_VALIDATION_PASSWORD" node >"$technical_file" <<'NODE'
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
log 'ERP_PROTECTED_ENDPOINT=PASS'; log 'ERP_SCHEDULER_INITIALIZED=PASS'; log 'ERP_NEXT_RUN_AT=PRESENT'

STAGE=automatic_proof
deadline=$(( $(date +%s) + MAX_WAIT_SECONDS )); automatic_proven=false
while (( $(date +%s) < deadline )); do
  docker exec -i "$new_api_id" env RECREATED_AT="$recreated_at" node >"$technical_file" <<'NODE'
const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
(async()=>{const since=new Date(process.env.RECREATED_AT);const runs=await p.erpSyncRun.findMany({where:{scope:'automatic',trigger:'scheduler',startedAt:{gt:since}},orderBy:{startedAt:'desc'},select:{status:true,startedAt:true,finishedAt:true,correlationId:true,errorMessage:true,syncedCount:true,metrics:true}});
const latest=runs[0],success=latest?.status==='success'&&latest.finishedAt&&latest.correlationId?latest:null;const concurrent=runs.filter(r=>r.status==='running').length;
const locks=await p.erpSyncLock.findMany({select:{lockedUntil:true}});const now=new Date(),active=locks.some(l=>l.lockedUntil>=now),expired=locks.some(l=>l.lockedUntil<now);
const completed=Array.isArray(success?.metrics?.completedSteps)?success.metrics.completedSteps.length:0;
console.log(`SUCCESS=${Boolean(success)}`);console.log(`DUPLICATE=${concurrent>1}`);console.log(`LOCK=${active?'active':expired?'expired_recoverable':'free'}`);if(success){console.log(`STARTED_AT=${success.startedAt.toISOString()}`);console.log(`FINISHED_AT=${success.finishedAt.toISOString()}`);console.log(`CORRELATION_ID=${success.correlationId}`);console.log(`LOCK_ACQUIRED=${success.syncedCount>0&&completed>0}`)}
})().finally(()=>p.$disconnect()).catch(()=>process.exit(1));
NODE
  [[ "$(sed -n 's/^DUPLICATE=//p' "$technical_file")" == false ]] || die 'duplicate automatic scheduler executions detected'
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
final_lock_state="$(technical_snapshot "$new_api_id")"; [[ "$(sed -n 's/^LOCK_STATE=//p' <<<"$final_lock_state")" == free ]] || die 'ERP sync lock was not released'
API_BASE=http://127.0.0.1:4000 AUTH_TEST_EMAIL="$AUTH_VALIDATION_EMAIL" AUTH_TEST_PASSWORD="$AUTH_VALIDATION_PASSWORD" node >"$technical_file" <<'NODE'
(async()=>{const login=await fetch(process.env.API_BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:process.env.AUTH_TEST_EMAIL,password:process.env.AUTH_TEST_PASSWORD})});let b={};try{b=await login.json()}catch{};if(login.status!==200||!b.accessToken)process.exit(1);const r=await fetch(process.env.API_BASE+'/erp/ultrafv3/sync/status',{headers:{authorization:`Bearer ${b.accessToken}`}});if(r.status!==200)process.exit(1);const a=(await r.json()).automaticSync||{};console.log(`NEXT_RUN_AT=${a.nextRunAt||''}`);console.log(`ACTIVE_ERROR=${Boolean(a.lastError)}`)})().catch(()=>process.exit(1));
NODE
[[ -n "$(sed -n 's/^NEXT_RUN_AT=//p' "$technical_file")" ]] || die 'nextRunAt was not recalculated after the automatic run'
[[ "$(sed -n 's/^ACTIVE_ERROR=//p' "$technical_file")" == false ]] || die 'an active automatic scheduler error remains'
# FASE 5 — persistência final (qualquer falha anterior percorre rollback)
install -o root -g root -m 600 "$ENV_FILE" "$ENV_DIR/backups/erp-scheduler-proven-$EXPECTED_SHA-$(date -u +%Y%m%dT%H%M%SZ).backup"
valid_protected_env "$ENV_FILE" || die 'protected environment metadata did not persist'
log 'ERP_AUTOMATIC_TRIGGER=scheduler'; log 'ERP_AUTOMATIC_SYNC=PASS'; log 'ERP_SYNC_LOCK=RELEASED'; log 'ERP_SYNC_ENV_PERSISTENCE=PASS'
log 'INC_ERP_5050=RESOLVED_CANDIDATE_REQUIRES_DOCUMENTATION_UPDATE'
trap - ERR
