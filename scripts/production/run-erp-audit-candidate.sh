#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/apps/gest-o}"
ERP_CODE="${ERP_CODE:-}"
DRY_RUN="${DRY_RUN:-0}"
CONFIRM="${CONFIRM:-}"
OLD_API="${OLD_API:-gest-o-api-recovery-20260718}"
DB_CONTAINER="${DB_CONTAINER:-gest-o-db-clean-v2-20260717}"
DB_NAME="${DB_NAME:-}"
WEB_CONTAINER="${WEB_CONTAINER:-gest-o-web-1}"
NETWORK="${NETWORK:-gest-o_default}"
CANDIDATE=""
CANDIDATE_CREATED=0

log() { printf '[erp-audit-candidate] %s\n' "$*"; }
die() { log "ERRO: $*" >&2; exit 1; }
cleanup() {
  if [[ "$CANDIDATE_CREATED" == 1 ]] && docker inspect "$CANDIDATE" >/dev/null 2>&1; then
    [[ "$(docker inspect --format '{{.State.Running}}' "$CANDIDATE" 2>/dev/null)" == true ]] && docker stop -t 15 "$CANDIDATE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT ERR INT TERM

for command in docker git jq sha256sum node install flock grep sed wc date; do
  command -v "$command" >/dev/null || die "dependência ausente: $command"
done
[[ "$ERP_CODE" == "5050" ]] || die "execute explicitamente com ERP_CODE=5050"
[[ -d "$APP_DIR/.git" ]] || die "repositório não encontrado: $APP_DIR"
cd "$APP_DIR"

git status --short --branch
git rev-parse HEAD
git log -3 --oneline
[[ -z "$(git status --porcelain)" ]] || die "working tree suja; não prossiga"

APP_COMMIT="$(git rev-parse HEAD)"
APP_VERSION="$(node -p "require('./package.json').version")"
APP_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%S%N)-$$}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "RUN_ID contém caracteres inválidos"
SAFE_ROOT="${SAFE_ROOT:-/root/gest-o-safe}"
SAFE_DIR="$SAFE_ROOT/$RUN_ID"
IMAGE="gest-o-api:candidate-$RUN_ID"
CANDIDATE="gest-o-api-candidate-$RUN_ID"

if [[ "$DRY_RUN" == 1 ]]; then
  log "DRY_RUN: checkout=$APP_COMMIT imagem=$IMAGE container=$CANDIDATE evidências=$SAFE_DIR"
  log "DRY_RUN: faria inspect + pg_dump + build identificado + testes sem rede + CLI read-only efêmera; não iniciaria server.js"
  exit 0
fi
[[ "$CONFIRM" == "ETAPA1" ]] || die "confirmação obrigatória: execute com CONFIRM=ETAPA1"

install -d -m 700 "$SAFE_ROOT"
exec 9>/run/lock/gest-o-erp-audit-candidate.lock
flock -n 9 || die "outra Etapa 1 está em execução"
mkdir -m 700 "$SAFE_DIR" || die "SAFE_DIR já existe: $SAFE_DIR"

docker inspect "$OLD_API" >"$SAFE_DIR/api-old.inspect.json"
docker inspect "$DB_CONTAINER" >"$SAFE_DIR/db.inspect.json"
docker inspect "$WEB_CONTAINER" >"$SAFE_DIR/web.inspect.json"
docker network inspect "$NETWORK" >"$SAFE_DIR/network.inspect.json"
docker image ls --digests --no-trunc >"$SAFE_DIR/images.txt"
docker inspect --format '{{json .NetworkSettings.Ports}} {{json .NetworkSettings.Networks}}' "$OLD_API" >"$SAFE_DIR/api-old-connectivity.txt"
jq -r '.[0].Config.Env[]' "$SAFE_DIR/api-old.inspect.json" >"$SAFE_DIR/api.env"
chmod 600 "$SAFE_DIR"/*

if [[ -z "$DB_NAME" ]]; then
  DB_NAME="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CONTAINER" \
    | sed -n 's/^POSTGRES_DB=//p' | sed -n '1p')"
fi
DB_NAME="${DB_NAME:-salesforce_pro}"
log "validando acesso administrativo local peer ao banco: $DB_NAME"
docker exec -u postgres "$DB_CONTAINER" \
  psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -tAc 'SELECT 1' >/dev/null \
  || die "conexão administrativa local peer falhou"
docker exec -u postgres "$DB_CONTAINER" \
  pg_dump -U postgres -d "$DB_NAME" --format=custom --no-owner --no-acl \
  >"$SAFE_DIR/postgres.dump"
test -s "$SAFE_DIR/postgres.dump" || die "dump vazio"
docker exec -i "$DB_CONTAINER" pg_restore --list <"$SAFE_DIR/postgres.dump" >"$SAFE_DIR/postgres.dump.list"
test -s "$SAFE_DIR/postgres.dump.list" || die "pg_restore não validou o dump"
wc -c <"$SAFE_DIR/postgres.dump" >"$SAFE_DIR/postgres.dump.size"
sha256sum "$SAFE_DIR/postgres.dump" >"$SAFE_DIR/postgres.dump.sha256"

docker build --build-arg APP_COMMIT="$APP_COMMIT" --build-arg APP_VERSION="$APP_VERSION" --build-arg APP_BUILT_AT="$APP_BUILT_AT" -f apps/api/Dockerfile -t "$IMAGE" .
docker image inspect "$IMAGE" >"$SAFE_DIR/candidate-image.inspect.json"
IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
IN_IMAGE_COMMIT="$(docker run --rm --network none "$IMAGE" node -p "require('./apps/api/dist/build-info.json').commit")"
[[ "$IN_IMAGE_COMMIT" == "$APP_COMMIT" ]] || die "commit da imagem difere do checkout"
docker run --rm --network none "$IMAGE" test -f apps/api/dist/scripts/crmAuditErpClient.js
docker run --rm --network none "$IMAGE" node -e "const p=require('./apps/api/package.json');if(p.scripts['crm:audit-erp-client:prod']!=='node dist/scripts/crmAuditErpClient.js')process.exit(1)"
if docker run --rm --network none "$IMAGE" npm run --silent crm:audit-erp-client:prod -w @salesforce-pro/api -- >"$SAFE_DIR/missing-code.stdout" 2>"$SAFE_DIR/missing-code.stderr"; then
  die "CLI sem código deveria falhar"
fi
grep -q 'Informe --erp-code=<codigo>' "$SAFE_DIR/missing-code.stderr" || die "erro amigável ausente"

[[ -z "$(docker ps -aq --filter "name=^/${CANDIDATE}$")" ]] || die "container candidato já existe: $CANDIDATE"
docker create --name "$CANDIDATE" --restart=no --env-file "$SAFE_DIR/api.env" \
  -e APP_COMMIT="$APP_COMMIT" -e APP_VERSION="$APP_VERSION" -e APP_BUILT_AT="$APP_BUILT_AT" \
  -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000' \
  -e AUDIT_ERP_CODE="$ERP_CODE" --network "$NETWORK" "$IMAGE" sh -c \
  'npm run --silent crm:audit-erp-client:prod -w @salesforce-pro/api -- --erp-code="$AUDIT_ERP_CODE" >/tmp/erp-audit.json 2>/tmp/erp-audit.stderr' >/dev/null
CANDIDATE_CREATED=1
[[ "$(docker inspect --format '{{.Image}}' "$CANDIDATE")" == "$IMAGE_ID" ]] || die "image ID inesperado"
[[ -z "$(docker inspect --format '{{range $p,$v := .NetworkSettings.Ports}}{{if $v}}{{$p}}{{end}}{{end}}' "$CANDIDATE")" ]] || die "candidato publicou porta"
ALIASES="$(docker inspect --format "{{json (index .NetworkSettings.Networks \"$NETWORK\").Aliases}}" "$CANDIDATE")"
! jq -e 'index("api")' <<<"$ALIASES" >/dev/null || die "candidato recebeu alias api"
[[ "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$CANDIDATE")" == no ]] || die "restart policy inesperada"

set +e
docker start -a "$CANDIDATE" >/dev/null
AUDIT_STATUS=$?
set -e
docker cp "$CANDIDATE:/tmp/erp-audit.stderr" "$SAFE_DIR/candidate.stderr.raw" 2>/dev/null || :
sed -E \
  -e 's#(postgres(ql)?://)[^[:space:]]+#\1[REDACTED]#gi' \
  -e 's#(Bearer[[:space:]]+)[A-Za-z0-9._~+/=-]+#\1[REDACTED]#gi' \
  -e 's#((password|senha|token|secret|api[_-]?key|authorization)[[:space:]]*[:=][[:space:]]*)[^,;[:space:]]+#\1[REDACTED]#gi' \
  "$SAFE_DIR/candidate.stderr.raw" >"$SAFE_DIR/candidate.stderr.log" 2>/dev/null || :
rm -f "$SAFE_DIR/candidate.stderr.raw"
[[ "$AUDIT_STATUS" == 0 ]] || die "CLI de auditoria falhou; consulte candidate.stderr.log"
[[ "$(docker inspect --format '{{.State.Status}}' "$CANDIDATE")" == exited ]] || die "candidato não encerrou"
docker cp "$CANDIDATE:/tmp/erp-audit.json" "$SAFE_DIR/erp-5050-audit.json"
chmod 600 "$SAFE_DIR"/*

jq -e --arg code "$ERP_CODE" '.erpCode == $code and .mode == "READ_ONLY_SANITIZED" and ((tostring | test("repair|apply"; "i")) | not)' "$SAFE_DIR/erp-5050-audit.json" >/dev/null || die "relatório inválido ou não read-only"
jq '{mode,erpCode,recordsFound,activeCount,archivedCount,diagnosis}' "$SAFE_DIR/erp-5050-audit.json"
[[ "$(docker inspect --format '{{.State.Status}}' "$OLD_API")" == running ]] || die "API antiga não está running"
[[ "$(docker inspect --format '{{.State.Status}}' "$DB_CONTAINER")" == running ]] || die "banco não está running"
[[ "$(docker inspect --format '{{.State.Status}}' "$WEB_CONTAINER")" == running ]] || die "frontend não está running"
trap - EXIT ERR INT TERM
log "Etapa 1 concluída. Candidato encerrado; produção intacta. Remoção opcional: docker rm $CANDIDATE"
