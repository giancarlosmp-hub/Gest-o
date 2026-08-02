#!/usr/bin/env bash
set -Eeuo pipefail

# Coleta somente metadados de runtime e respostas HTTP. Este validador não realiza mudanças.
umask 077

EXPECTED_SHA="${EXPECTED_SHA:?EXPECTED_SHA is required}"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || { printf 'ERRO: EXPECTED_SHA deve ser completo.\n' >&2; exit 2; }
[[ "${CONFIRM:-}" == PRODUCTION_HEALTH_VALIDATE ]] || {
  printf 'ERRO: use CONFIRM=PRODUCTION_HEALTH_VALIDATE.\n' >&2; exit 2;
}
: "${AUTH_TEST_EMAIL:?AUTH_TEST_EMAIL is required from protected input}"
: "${AUTH_TEST_PASSWORD:?AUTH_TEST_PASSWORD is required from protected input}"

APP_DIR="${APP_DIR:-/apps/gest-o}"
API_CONTAINER="${API_CONTAINER:-gest-o-production-api-1}"
WEB_CONTAINER="${WEB_CONTAINER:-gest-o-production-web-1}"
DB_CONTAINER="${DB_CONTAINER:-gest-o-db-clean-v2-20260717}"
DB_VOLUME="${DB_VOLUME:?DB_VOLUME is required}"
API_BASE="${API_BASE:-http://127.0.0.1:4000}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:5173}"
PUBLIC_BASE="${PUBLIC_BASE:-https://crm.demetraagronegocios.com.br}"
PROTECTED_PATH="${PROTECTED_PATH:-/auth/me}"
SCHEMA_EVIDENCE_FILE="${SCHEMA_EVIDENCE_FILE:?SCHEMA_EVIDENCE_FILE is required}"
EVIDENCE_DIR="${HEALTH_EVIDENCE_ROOT:-/var/log/gest-o/health}/$EXPECTED_SHA"
STARTED_AT="$(date -u +%FT%TZ)"
START_EPOCH="$(date +%s)"
FAILURES=0

die(){ printf '[production-health] ERRO: %s\n' "$*" >&2; exit 2; }
need(){ command -v "$1" >/dev/null 2>&1 || die "comando obrigatório ausente: $1"; }
for cmd in awk curl df docker free git jq node openssl stat; do need "$cmd"; done
[[ "$PROTECTED_PATH" == /* && "$PROTECTED_PATH" != *'?'* ]] || die 'PROTECTED_PATH inválido'
[[ ! -e "$EVIDENCE_DIR" ]] || die 'diretório de evidência já existe'
install -d -m 700 "$EVIDENCE_DIR"
trap 'rm -f "$EVIDENCE_DIR/result.tsv"' ERR INT TERM

for file in health runtime containers images network storage system security erp summary; do
  printf 'check\tstatus\tdetail\n' >"$EVIDENCE_DIR/$file.tsv"
done

record(){
  local file="$1" check="$2" status="$3" detail="${4:-none}"
  detail="${detail//$'\t'/ }"; detail="${detail//$'\n'/ }"
  printf '%s\t%s\t%s\n' "$check" "$status" "$detail" >>"$EVIDENCE_DIR/$file.tsv"
  [[ "$status" == PASS ]] || FAILURES=$((FAILURES+1))
}
check(){
  local file="$1" name="$2" detail="$3"; shift 3
  if "$@"; then record "$file" "$name" PASS "$detail"; else record "$file" "$name" FAIL "$detail"; fi
}

cd "$APP_DIR"
check runtime checkout_sha "$EXPECTED_SHA" test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
check runtime worktree_clean required test -z "$(git status --porcelain)"

api_version="$(curl -fsS --max-time 15 "$API_BASE/health/version" 2>/dev/null || true)"
web_version="$(curl -fsS --max-time 15 "$WEB_BASE/build-info.json" 2>/dev/null || true)"
health="$(curl -fsS --max-time 15 "$API_BASE/health" 2>/dev/null || true)"
check health api_sha expected jq -e --arg sha "$EXPECTED_SHA" '.commit==$sha' <<<"$api_version" >/dev/null
check health web_sha expected jq -e --arg sha "$EXPECTED_SHA" '.commit==$sha' <<<"$web_version" >/dev/null
check health build_info sanitized jq -e '.version and .builtAt and .commit' <<<"$web_version" >/dev/null
check health api_health http_200 test -n "$health"

container_state(){ docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$1" 2>/dev/null; }
for pair in api:$API_CONTAINER web:$WEB_CONTAINER postgres:$DB_CONTAINER; do
  role="${pair%%:*}"; container="${pair#*:}"; state="$(container_state "$container" || true)"
  check containers "$role" "$state" test "${state%%/*}" = running
  image="$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)"
  check images "${role}_image" "${image:-missing}" test -n "$image"
  restart="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$container" 2>/dev/null || true)"
  check containers "${role}_restart_policy" "$restart" sh -c 'test "$1" = always || test "$1" = unless-stopped' _ "$restart"
done

api_image_sha="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$API_CONTAINER" 2>/dev/null || true)"
web_image_sha="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$WEB_CONTAINER" 2>/dev/null || true)"
check images api_image_sha "$api_image_sha" test "$api_image_sha" = "$EXPECTED_SHA"
check images web_image_sha "$web_image_sha" test "$web_image_sha" = "$EXPECTED_SHA"

mounts="$(docker inspect -f '{{range .Mounts}}{{printf "%s:%s " .Name .Destination}}{{end}}' "$DB_CONTAINER" 2>/dev/null || true)"
check storage postgres_volume "$DB_VOLUME" sh -c 'case "$1" in *"$2:/var/lib/postgresql/data"*) exit 0;; *) exit 1;; esac' _ "$mounts" "$DB_VOLUME"
network_names="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{printf "%s " $name}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
check network production_network gest-o_default sh -c 'case "$1" in *gest-o_default*) exit 0;; *) exit 1;; esac' _ "$network_names"
check network api_to_postgres same_network docker inspect "$DB_CONTAINER" >/dev/null 2>&1

check health nginx_public_health tls_http curl -fsS --max-time 15 "$PUBLIC_BASE/api/health" >/dev/null
check health nginx_public_build_info tls_http curl -fsS --max-time 15 "$PUBLIC_BASE/build-info.json" >/dev/null
host="${PUBLIC_BASE#https://}"; host="${host%%/*}"; host="${host%%:*}"
cert="$(printf '' | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null || true)"
check security ssl_certificate "$host" test -n "$cert"
check security certificate_valid_14d "$host" sh -c 'printf "" | openssl s_client -connect "$1:443" -servername "$1" 2>/dev/null | openssl x509 -checkend 1209600 -noout >/dev/null' _ "$host"

api_env_names="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$API_CONTAINER" 2>/dev/null | sed 's/=.*//' || true)"
for var in NODE_ENV JWT_SECRET JWT_ACCESS_SECRET JWT_REFRESH_SECRET ULTRAFV3_BASE_URL ERP_CREDENTIAL_ENCRYPTION_KEY ERP_SYNC_SCHEDULER_ENABLED; do
  check security "required_var_$var" configured grep -qx "$var" <<<"$api_env_names"
done
check security app_dir_permissions no_world_write sh -c 'test $(( $(stat -c %a "$1") % 10 )) -lt 2' _ "$APP_DIR"
check security evidence_permissions mode_700 test "$(stat -c %a "$EVIDENCE_DIR")" = 700
check security debug_admin_absent local sh -c 'test "$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$1/debug/admin")" = 404' _ "$API_BASE"

# Credenciais e token ficam somente na memória do processo; a evidência contém apenas status.
if API_BASE="$API_BASE" PROTECTED_PATH="$PROTECTED_PATH" AUTH_TEST_EMAIL="$AUTH_TEST_EMAIL" AUTH_TEST_PASSWORD="$AUTH_TEST_PASSWORD" \
node <<'NODE' >"$EVIDENCE_DIR/.auth-result"
const request=(path,options={})=>fetch(process.env.API_BASE+path,options);
(async()=>{
 const login=await request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:process.env.AUTH_TEST_EMAIL,password:process.env.AUTH_TEST_PASSWORD})});
 let body={}; try{body=await login.json()}catch{}
 const token=body.accessToken;
 const authenticated=token?await request(process.env.PROTECTED_PATH,{headers:{authorization:`Bearer ${token}`}}):{status:0};
 const anonymous=await request(process.env.PROTECTED_PATH);
 console.log(`${login.status}\t${authenticated.status}\t${anonymous.status}`);
 if(login.status!==200||authenticated.status!==200||anonymous.status!==401)process.exitCode=1;
})().catch(()=>process.exit(1));
NODE
then auth_rc=0; else auth_rc=$?; fi
auth_status="$(cat "$EVIDENCE_DIR/.auth-result" 2>/dev/null || true)"; rm -f "$EVIDENCE_DIR/.auth-result"
check security login_and_protected "$auth_status" test "$auth_rc" = 0

logs="$(docker logs --tail 2000 "$API_CONTAINER" 2>&1 || true)"
check security sanitized_logs recent_window sh -c '! printf "%s" "$1" | grep -Eqi "password(Hash|Matches)?|hashPrefix|authorization:|access.?token|refresh.?token"' _ "$logs"
check erp erp_communication_recent log_signal grep -Eqi 'erp.*(health|sync|finished|success)|ultrafv3.*(health|finished|success)' <<<"$logs"
check erp scheduler_initialized log_signal grep -Eqi 'scheduler.*(initialized|registered|tick|waiting-for-configuration)' <<<"$logs"
check erp queues_no_failure no_error sh -c '! printf "%s" "$1" | grep -Eqi "queue.*(stalled|failed|fatal)"' _ "$logs"

check system docker_daemon available docker info >/dev/null 2>&1
docker_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
check system docker_version "$docker_version" test -n "$docker_version"
node_version="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$API_CONTAINER" 2>/dev/null | awk -F= '$1=="NODE_VERSION"{print $2}' || true)"
check system node_version "${node_version:-not-exposed}" test -n "$node_version"
postgres_version="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CONTAINER" 2>/dev/null | awk -F= '$1=="PG_MAJOR"{print $2}' || true)"
check system postgresql_version "${postgres_version:-not-exposed}" test -n "$postgres_version"
prisma_version="$(node -p "require('./apps/api/node_modules/prisma/package.json').version" 2>/dev/null || node -p "require('./node_modules/prisma/package.json').version" 2>/dev/null || true)"
check system prisma_version "${prisma_version:-not-installed}" test -n "$prisma_version"
disk_use="$(df -P "$APP_DIR" | awk 'NR==2{gsub(/%/,"",$5);print $5}')"
check system disk_space "${disk_use}% used" test "$disk_use" -lt "${MAX_DISK_PERCENT:-90}"
mem_available="$(free -m | awk '/^Mem:/{print $7}')"
check system memory_available "${mem_available}MiB" test "$mem_available" -ge "${MIN_MEMORY_MB:-256}"
cpu_load="$(awk '{print $1}' /proc/loadavg)"; cpu_count="$(getconf _NPROCESSORS_ONLN)"
check system cpu_load "$cpu_load/$cpu_count" awk -v l="$cpu_load" -v c="$cpu_count" 'BEGIN{exit !(l<c*2)}'

check storage backup_configured executable test -x "$APP_DIR/backup.sh"
check storage restore_configured executable test -x "$APP_DIR/restore.sh"
check storage schema_evidence readable test -r "$SCHEMA_EVIDENCE_FILE"
schema_text="$(cat "$SCHEMA_EVIDENCE_FILE" 2>/dev/null || true)"
check storage incident_tables_preserved eight_entries awk 'BEGIN{n=0}/incident_/{n++}END{exit !(n>=8)}' <<<"$schema_text"
check storage schema_release_compatible applied_and_checksum grep -Eqi 'applied|checksum|post-apply-diff' <<<"$schema_text"

for file in health runtime containers images network storage system security erp; do
  pass="$(awk -F'\t' '$2=="PASS"{n++}END{print n+0}' "$EVIDENCE_DIR/$file.tsv")"
  fail="$(awk -F'\t' '$2=="FAIL"{n++}END{print n+0}' "$EVIDENCE_DIR/$file.tsv")"
  printf '%s\t%s\tpass=%s fail=%s\n' "$file" "$([[ "$fail" == 0 ]] && echo PASS || echo FAIL)" "$pass" "$fail" >>"$EVIDENCE_DIR/summary.tsv"
done

FINISHED_AT="$(date -u +%FT%TZ)"
result=PASS; [[ "$FAILURES" == 0 ]] || result=FAIL
printf 'timestamp_utc\texpected_sha\tstarted_at_utc\tduration_seconds\tchecks_failed\tresult\n' >"$EVIDENCE_DIR/result.tsv"
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$FINISHED_AT" "$EXPECTED_SHA" "$STARTED_AT" "$(( $(date +%s)-START_EPOCH ))" "$FAILURES" "$result" >>"$EVIDENCE_DIR/result.tsv"
printf '[production-health] %s: %s\n' "$result" "$EVIDENCE_DIR" >&2
[[ "$result" == PASS ]]
