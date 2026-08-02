#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
EXPECTED_SHA="${EXPECTED_SHA:?EXPECTED_SHA is required}"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || { printf 'ERRO: EXPECTED_SHA deve ser SHA completo.\n' >&2; exit 1; }
[[ "${CONFIRM:-}" == PRODUCTION_AUTH_SECURITY_VALIDATE ]] || {
  printf 'ERRO: use CONFIRM=PRODUCTION_AUTH_SECURITY_VALIDATE.\n' >&2; exit 1;
}
: "${AUTH_TEST_EMAIL:?AUTH_TEST_EMAIL is required from a protected variable}"
: "${AUTH_TEST_PASSWORD:?AUTH_TEST_PASSWORD is required from a protected variable}"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_VOLUME_EXPECTED:?PRODUCTION_DB_VOLUME_EXPECTED is required}"

APP_DIR="${APP_DIR:-/apps/gest-o}"
API_CONTAINER="${API_CONTAINER:-gest-o-production-api-1}"
WEB_CONTAINER="${WEB_CONTAINER:-gest-o-production-web-1}"
API_LOCAL_BASE="${API_LOCAL_BASE:-http://127.0.0.1:4000}"
WEB_LOCAL_BASE="${WEB_LOCAL_BASE:-http://127.0.0.1:5173}"
PUBLIC_BASE="${PUBLIC_BASE:-https://crm.demetraagronegocios.com.br}"
PROTECTED_PATH="${AUTH_PROTECTED_PATH:-/auth/me}"
EVIDENCE_DIR="${SECURITY_EVIDENCE_ROOT:-/var/log/gest-o/security}/$EXPECTED_SHA"
STARTED_AT="$(date -u +%FT%TZ)"
START_EPOCH="$(date +%s)"

die(){ printf '[auth-security-validate] ERRO: %s\n' "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || die "comando obrigatório ausente: $1"; }
for command_name in curl docker git jq node; do need "$command_name"; done
[[ "$PROTECTED_PATH" == /* && "$PROTECTED_PATH" != *'?'* ]] || die 'AUTH_PROTECTED_PATH deve ser um GET sem query string'
[[ ! -e "$EVIDENCE_DIR" ]] || die 'diretório de evidência já existe; revisão manual obrigatória'
install -d -m 700 "$EVIDENCE_DIR"
trap 'rm -f "$EVIDENCE_DIR/result.tsv"' ERR INT TERM

cd "$APP_DIR"
[[ "$(git rev-parse HEAD)" == "$EXPECTED_SHA" ]] || die 'checkout difere do EXPECTED_SHA'
git fetch origin main --quiet
[[ "$(git rev-parse origin/main)" == "$EXPECTED_SHA" ]] || die 'origin/main difere do EXPECTED_SHA'
[[ -z "$(git status --porcelain)" ]] || die 'worktree não está limpa'
printf 'key\tvalue\nexpected_sha\t%s\nstarted_at_utc\t%s\ncheckout\tPASS\norigin_main\tPASS\nworktree_clean\tPASS\n' \
  "$EXPECTED_SHA" "$STARTED_AT" >"$EVIDENCE_DIR/metadata.tsv"

container_state(){ docker inspect -f '{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$1"; }
api_state="$(container_state "$API_CONTAINER")"
web_state="$(container_state "$WEB_CONTAINER")"
db_state="$(container_state "$PRODUCTION_DB_CONTAINER_EXPECTED")"
[[ "${api_state%%$'\t'*}" == running && "${api_state#*$'\t'}" == healthy ]] || die 'API não está running/healthy'
[[ "${web_state%%$'\t'*}" == running && "${web_state#*$'\t'}" == healthy ]] || die 'WEB não está running/healthy'
[[ "${db_state%%$'\t'*}" == running ]] || die 'PostgreSQL esperado não está running'
docker inspect -f '{{range .Mounts}}{{printf "%s\t%s\n" .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" |
  awk -F'\t' -v volume="$PRODUCTION_DB_VOLUME_EXPECTED" '$1 == volume && $2 == "/var/lib/postgresql/data" { ok=1 } END { exit !ok }' ||
  die 'volume PostgreSQL esperado não está preservado no mount esperado'
printf 'component\tstatus\thealth\tidentity\napi\t%s\t%s\texpected\nweb\t%s\t%s\texpected\npostgresql\t%s\t%s\texpected-volume-preserved\n' \
  "${api_state%%$'\t'*}" "${api_state#*$'\t'}" "${web_state%%$'\t'*}" "${web_state#*$'\t'}" \
  "${db_state%%$'\t'*}" "${db_state#*$'\t'}" >"$EVIDENCE_DIR/runtime.tsv"

sanitize_version(){ jq -ce '{commit,version,builtAt} | if (.commit|type)!="string" then error("commit ausente") else . end'; }
api_local="$(curl -fsS "$API_LOCAL_BASE/health/version" | sanitize_version)" || die 'versão local da API inválida'
api_public="$(curl -fsS "$PUBLIC_BASE/api/health/version" | sanitize_version)" || die 'versão pública da API inválida'
web_local="$(curl -fsS "$WEB_LOCAL_BASE/build-info.json" | sanitize_version)" || die 'build-info local da WEB inválido'
web_public="$(curl -fsS "$PUBLIC_BASE/build-info.json" | sanitize_version)" || die 'build-info público da WEB inválido'
for version_json in "$api_local" "$api_public" "$web_local" "$web_public"; do
  [[ "$(jq -r .commit <<<"$version_json")" == "$EXPECTED_SHA" ]] || die 'SHA de runtime divergente'
done
jq -cn --argjson local "$api_local" --argjson public "$api_public" '{local:$local,public:$public}' >"$EVIDENCE_DIR/api-version.json"
jq -cn --argjson local "$web_local" --argjson public "$web_public" '{local:$local,public:$public}' >"$EVIDENCE_DIR/web-build-info.json"

printf 'surface\tpath\tstatus\tforbidden_fields\tresult\n' >"$EVIDENCE_DIR/endpoint-results.tsv"
check_debug(){
  local surface="$1" url="$2" path="$3" output status body
  output="$(mktemp)"; status="$(curl -sS -o "$output" -w '%{http_code}' "$url$path")" || { rm -f "$output"; die "requisição $surface falhou"; }
  body="$(cat "$output")"; rm -f "$output"
  [[ "$status" == 404 ]] || die "$surface $path não retornou 404"
  fields="$(BODY="$body" node -e '
    const body=(process.env.BODY||"").toLowerCase();
    const terms=["email","password","hash","credential","role","isactive","user","token"];
    process.stdout.write(terms.filter(term=>body.includes(term)).join(","));
  ')"
  [[ -z "$fields" ]] || die "$surface $path contém campos proibidos"
  printf '%s\t%s\t%s\tnone\tPASS\n' "$surface" "$path" "$status" >>"$EVIDENCE_DIR/endpoint-results.tsv"
}
for path in /debug/admin /debug/admin/; do
  check_debug local "$API_LOCAL_BASE" "$path"
  check_debug public "$PUBLIC_BASE/api" "$path"
done

# Os corpos de login existem apenas na memória deste processo Node. Somente status e hash da
# resposta pública inválida normalizada saem do processo; cookies e headers nunca são persistidos.
API_BASE="$API_LOCAL_BASE" PROTECTED_PATH="$PROTECTED_PATH" AUTH_TEST_EMAIL="$AUTH_TEST_EMAIL" \
  AUTH_TEST_PASSWORD="$AUTH_TEST_PASSWORD" node <<'NODE' >"$EVIDENCE_DIR/login-results.tsv"
const crypto = require("node:crypto");
const base = process.env.API_BASE;
const email = process.env.AUTH_TEST_EMAIL;
const password = process.env.AUTH_TEST_PASSWORD;
const protectedPath = process.env.PROTECTED_PATH;
const fictitious = `nonexistent-${crypto.randomUUID()}@invalid.example`;
const request = async (path, options={}) => {
  const response = await fetch(base + path, {redirect:"error", ...options});
  return {status:response.status, text:await response.text()};
};
const normalize = text => {
  try { return JSON.stringify(JSON.parse(text)); } catch { return text.trim(); }
};
const login = (loginEmail, loginPassword) => request("/auth/login", {
  method:"POST", headers:{"content-type":"application/json"},
  body:JSON.stringify({email:loginEmail,password:loginPassword}),
});
(async()=>{
  const valid = await login(email,password);
  if (valid.status !== 200) throw new Error("login válido não retornou 200");
  let token;
  try { token=JSON.parse(valid.text).accessToken; } catch {}
  if (!token || typeof token !== "string") throw new Error("login válido sem accessToken");
  const authenticated = await request(protectedPath,{headers:{authorization:`Bearer ${token}`}});
  if (authenticated.status !== 200) throw new Error("GET autenticado seguro falhou");
  token=undefined; valid.text="";
  const wrong = await login(email,`${password}-invalid`);
  const absent = await login(fictitious,`${password}-invalid`);
  const unauthenticated = await request(protectedPath);
  const wrongNormalized=normalize(wrong.text), absentNormalized=normalize(absent.text);
  if (wrong.status !== absent.status || wrongNormalized !== absentNormalized) throw new Error("respostas inválidas permitem enumeração");
  if (wrong.status !== 401 || unauthenticated.status !== 401) throw new Error("status de autenticação inesperado");
  const digest=crypto.createHash("sha256").update(wrongNormalized).digest("hex");
  console.log("scenario\tstatus\tnormalized_response_sha256\tresult");
  console.log(`valid\t${valid.status}\tnot-recorded\tPASS`);
  console.log(`invalid-password\t${wrong.status}\t${digest}\tPASS`);
  console.log(`fictitious-user\t${absent.status}\t${digest}\tPASS`);
  console.log(`protected-authenticated-read\t${authenticated.status}\tnot-recorded\tPASS`);
  console.log(`protected-without-token\t${unauthenticated.status}\tnot-recorded\tPASS`);
})().catch(error=>{ console.error(`ERRO: ${error.message}`); process.exit(1); });
NODE

# A janela começa antes da primeira requisição. Logs passam por stdin e só o sumário é gravado.
docker logs --since "$STARTED_AT" "$API_CONTAINER" 2>&1 |
  TEST_EMAIL="$AUTH_TEST_EMAIL" TEST_PASSWORD="$AUTH_TEST_PASSWORD" node /dev/fd/3 \
  3<<'NODE' >"$EVIDENCE_DIR/log-scan-results.tsv"
const readline=require("node:readline");
const counts={auth_login_success:0,auth_login_failure:0};
const found=new Set();
const email=(process.env.TEST_EMAIL||"").toLowerCase(), password=process.env.TEST_PASSWORD||"";
const patterns=[
  ["test_email", line=>email && line.toLowerCase().includes(email)],
  ["test_password", line=>password && line.includes(password)],
  ["access_token", line=>/access.?token/i.test(line)], ["refresh_token", line=>/refresh.?token/i.test(line)],
  ["authorization", line=>/authorization/i.test(line)], ["cookie", line=>/cookie/i.test(line)],
  ["passwordHash", line=>/passwordHash/i.test(line)], ["hashPrefix", line=>/hashPrefix/i.test(line)],
  ["hashLength", line=>/hashLength/i.test(line)], ["passwordMatches", line=>/passwordMatches/i.test(line)],
  ["BCRYPT_COMPARE_RESULT", line=>/BCRYPT_COMPARE_RESULT/i.test(line)],
];
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on("line",line=>{
  for(const event of Object.keys(counts)) if(line.includes(event)) counts[event]++;
  for(const [name,test] of patterns) if(test(line)) found.add(name);
});
rl.on("close",()=>{
  console.log("check\tcount\tfields_found\tresult");
  for(const [event,count] of Object.entries(counts)) console.log(`${event}\t${count}\tnone\t${count>0?"PASS":"FAIL"}`);
  console.log(`sensitive_fields\t${found.size}\t${found.size?[...found].join(","):"none"}\t${found.size?"FAIL":"PASS"}`);
  if(found.size || counts.auth_login_success<1 || counts.auth_login_failure<2) process.exitCode=1;
});
NODE

FINISHED_AT="$(date -u +%FT%TZ)"
printf 'timestamp_utc\texpected_sha\tduration_seconds\tresult\n%s\t%s\t%s\tPASS\n' \
  "$FINISHED_AT" "$EXPECTED_SHA" "$(( $(date +%s)-START_EPOCH ))" >"$EVIDENCE_DIR/result.tsv"
printf '[auth-security-validate] PASS: evidências sanitizadas em %s\n' "$EVIDENCE_DIR" >&2
