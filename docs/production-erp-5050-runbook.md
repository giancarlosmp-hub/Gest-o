# Etapa 1 — imagem candidata e auditoria ERP 5050

> **Gate humano:** não execute na VPS sem aprovação. Esta etapa não troca, para ou desconecta a API
> de produção. O script equivalente é `scripts/production/run-erp-audit-candidate.sh` e termina após
> parar o candidato.
>
> **Decisão arquitetural:** este runbook adota a ADR de backup administrativo local registrada no
> [Documento Mestre](documento-mestre.md#adr--backup-administrativo-local-do-postgresql-recuperado).
> Ela substitui o uso anterior de credenciais do ambiente do container.

## A. Checkout (somente leitura)

```bash
cd /apps/gest-o
git status --short --branch
git rev-parse HEAD
git log -3 --oneline
test -z "$(git status --porcelain)" || { echo 'ABORTAR: working tree suja'; exit 1; }
```

Confirme que o commit desta PR está no histórico. Não prossiga com checkout incorreto ou alterações
locais inesperadas.

## B–C. Evidências protegidas e backup lógico

```bash
export RUN_ID="$(date -u +%Y%m%dT%H%M%S%N)-$$"
export SAFE_ROOT="/root/gest-o-safe"
export SAFE_DIR="$SAFE_ROOT/$RUN_ID"
install -d -m 700 "$SAFE_ROOT"
exec 9>/run/lock/gest-o-erp-audit-candidate.lock
flock -n 9 || { echo 'ABORTAR: outra Etapa 1 está em execução'; exit 1; }
mkdir -m 700 "$SAFE_DIR" || { echo 'ABORTAR: SAFE_DIR já existe'; exit 1; }
docker inspect gest-o-api-recovery-20260718 >"$SAFE_DIR/api-old.inspect.json"
docker inspect gest-o-db-clean-v2-20260717 >"$SAFE_DIR/db.inspect.json"
docker inspect gest-o-web-1 >"$SAFE_DIR/web.inspect.json"
docker network inspect gest-o_default >"$SAFE_DIR/network.inspect.json"
docker image ls --digests --no-trunc >"$SAFE_DIR/images.txt"
docker inspect --format '{{json .NetworkSettings.Ports}} {{json .NetworkSettings.Networks}}' \
  gest-o-api-recovery-20260718 >"$SAFE_DIR/api-old-connectivity.txt"
jq -r '.[0].Config.Env[]' "$SAFE_DIR/api-old.inspect.json" >"$SAFE_DIR/api.env"
chmod 600 "$SAFE_DIR"/*

export DB_NAME="${DB_NAME:-}"
if test -z "$DB_NAME"; then
  DB_NAME="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
    gest-o-db-clean-v2-20260717 | sed -n 's/^POSTGRES_DB=//p' | sed -n '1p')"
fi
DB_NAME="${DB_NAME:-salesforce_pro}"
docker exec -u postgres gest-o-db-clean-v2-20260717 \
  psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -tAc 'SELECT 1' >/dev/null || exit 1
docker exec -u postgres gest-o-db-clean-v2-20260717 \
  pg_dump -U postgres -d "$DB_NAME" --format=custom --no-owner --no-acl \
  >"$SAFE_DIR/postgres.dump"
test -s "$SAFE_DIR/postgres.dump" || exit 1
docker exec -i gest-o-db-clean-v2-20260717 pg_restore --list \
  <"$SAFE_DIR/postgres.dump" >"$SAFE_DIR/postgres.dump.list"
test -s "$SAFE_DIR/postgres.dump.list" || exit 1
wc -c <"$SAFE_DIR/postgres.dump" >"$SAFE_DIR/postgres.dump.size"
sha256sum "$SAFE_DIR/postgres.dump" >"$SAFE_DIR/postgres.dump.sha256"
```

O nome do banco é resolvido, nesta ordem, por `DB_NAME` informado pelo operador, `POSTGRES_DB` do
container e o fallback `salesforce_pro`. A validação e o dump executam como o usuário local
`postgres`, via autenticação peer. A rotina administrativa nunca consulta `DATABASE_URL`,
`POSTGRES_USER` ou `POSTGRES_PASSWORD`.

Isto lê o banco e cria arquivos locais; não restaura nem altera registros. `api.env` nunca deve ser
impresso no terminal. Consulte a decisão normativa e suas consequências no
[Documento Mestre](documento-mestre.md#adr--backup-administrativo-local-do-postgresql-recuperado).

## D–F. Build exclusivo, identidade e teste estático

```bash
export APP_COMMIT="$(git rev-parse HEAD)"
export APP_VERSION="$(node -p "require('./package.json').version")"
export APP_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export CANDIDATE_IMAGE="gest-o-api:candidate-$RUN_ID"

docker build \
  --build-arg APP_COMMIT="$APP_COMMIT" \
  --build-arg APP_VERSION="$APP_VERSION" \
  --build-arg APP_BUILT_AT="$APP_BUILT_AT" \
  -f apps/api/Dockerfile -t "$CANDIDATE_IMAGE" .

docker image inspect --format '{{.Id}} {{json .RepoTags}} {{.Created}}' "$CANDIDATE_IMAGE"
docker run --rm --network none "$CANDIDATE_IMAGE" cat apps/api/dist/build-info.json
IMAGE_COMMIT="$(docker run --rm --network none "$CANDIDATE_IMAGE" \
  node -p "require('./apps/api/dist/build-info.json').commit")"
test "$IMAGE_COMMIT" = "$APP_COMMIT" || { echo 'ABORTAR: commits diferentes'; exit 1; }

docker run --rm --network none "$CANDIDATE_IMAGE" \
  test -f apps/api/dist/scripts/crmAuditErpClient.js
docker run --rm --network none "$CANDIDATE_IMAGE" node -e \
  "const p=require('./apps/api/package.json');if(p.scripts['crm:audit-erp-client:prod']!=='node dist/scripts/crmAuditErpClient.js')process.exit(1)"
! docker run --rm --network none "$CANDIDATE_IMAGE" \
  npm run --silent crm:audit-erp-client:prod -w @salesforce-pro/api -- \
  >"$SAFE_DIR/missing-code.stdout" 2>"$SAFE_DIR/missing-code.stderr"
grep -q 'Informe --erp-code=<codigo>' "$SAFE_DIR/missing-code.stderr"
```

A tag `gest-o-api:latest` não é modificada. Os testes estáticos usam `--network none`; a validação de
argumento ocorre antes de qualquer consulta ao banco.

## G–J. Container efêmero, auditoria e encerramento

O candidato **não inicia a API**, não executa `server.js` e não oferece healthcheck. Ele executa
exclusivamente a CLI compilada, grava stdout/stderr em arquivos internos e encerra. Um lock exclusivo
impede duas execuções simultâneas; o `RUN_ID` usa nanossegundos e PID; o cleanup só atua se esta
execução criou o container.

```bash
export CANDIDATE="gest-o-api-candidate-$RUN_ID"
export IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")"
test -z "$(docker ps -aq --filter "name=^/${CANDIDATE}$")" || exit 1

docker create --name "$CANDIDATE" --restart=no \
  --env-file "$SAFE_DIR/api.env" \
  -e APP_COMMIT="$APP_COMMIT" -e APP_VERSION="$APP_VERSION" -e APP_BUILT_AT="$APP_BUILT_AT" \
  -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000' \
  -e AUDIT_ERP_CODE=5050 --network gest-o_default "$CANDIDATE_IMAGE" sh -c \
  'npm run --silent crm:audit-erp-client:prod -w @salesforce-pro/api -- --erp-code="$AUDIT_ERP_CODE" >/tmp/erp-audit.json 2>/tmp/erp-audit.stderr'

test "$(docker inspect --format '{{.Image}}' "$CANDIDATE")" = "$IMAGE_ID"
test -z "$(docker inspect --format \
  '{{range $p,$v := .NetworkSettings.Ports}}{{if $v}}{{$p}}{{end}}{{end}}' "$CANDIDATE")"
ALIASES="$(docker inspect --format \
  '{{json (index .NetworkSettings.Networks "gest-o_default").Aliases}}' "$CANDIDATE")"
! jq -e 'index("api")' <<<"$ALIASES" >/dev/null
test "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$CANDIDATE")" = no

docker start -a "$CANDIDATE" >/dev/null
test "$(docker inspect --format '{{.State.Status}}' "$CANDIDATE")" = exited
docker cp "$CANDIDATE:/tmp/erp-audit.json" "$SAFE_DIR/erp-5050-audit.json"
chmod 600 "$SAFE_DIR/erp-5050-audit.json"
jq -e '.erpCode == "5050" and .mode == "READ_ONLY_SANITIZED" and \
  ((tostring | test("repair|apply"; "i")) | not)' "$SAFE_DIR/erp-5050-audit.json" >/dev/null
jq '{mode,erpCode,recordsFound,activeCount,archivedCount,diagnosis}' \
  "$SAFE_DIR/erp-5050-audit.json"
test "$(docker inspect --format '{{.State.Status}}' gest-o-api-recovery-20260718)" = running
test "$(docker inspect --format '{{.State.Status}}' gest-o-db-clean-v2-20260717)" = running
test "$(docker inspect --format '{{.State.Status}}' gest-o-web-1)" = running
# Opcional após inspeção: docker rm "$CANDIDATE"
```

O script operacional captura stderr sem exibi-lo, aplica redaction de URL PostgreSQL, bearer token e
chaves sensíveis e remove o arquivo bruto. Não remove a imagem candidata, volumes, rede, banco,
frontend ou API antiga.

## Execução assistida recomendada

```bash
ERP_CODE=5050 DRY_RUN=1 scripts/production/run-erp-audit-candidate.sh
ERP_CODE=5050 CONFIRM=ETAPA1 scripts/production/run-erp-audit-candidate.sh
```

O script aborta por: árvore suja; dependência ausente; execução concorrente; `RUN_ID` inválido ou
reutilizado; dump vazio/inválido; commit divergente; artefato/comando ausente; nome de container já
existente; image ID/restart policy inesperado; porta publicada; alias `api`; CLI com erro; candidato
que não encerra; JSON inválido; modo/código incorreto; texto `repair`/`apply`; ou API antiga,
banco/frontend fora de `running`. `SET TRANSACTION READ ONLY` protege todas as consultas da única
rotina executada, e `PGOPTIONS` adiciona read-only e timeouts como defesa em profundidade.
