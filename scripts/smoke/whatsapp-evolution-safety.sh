#!/usr/bin/env bash
# whatsapp-evolution-remote.sh (workflow "WhatsApp Evolution"): status, up e stop com Docker falso e env
# protegidos fictícios numa pasta temporária. Nenhum acesso remoto; nenhum valor real.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/whatsapp-evolution-remote.sh"
COMPOSE_SRC="$ROOT/docker-compose.whatsapp.yml"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP:?}"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
fail(){ printf 'FALHA: %s\n' "$*" >&2; exit 1; }

cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
# Estado em $FAKE_STATE: <serviço>.state (running|exited|absent), <serviço>.health, <serviço>.ports,
# <serviço>.networks; "touched" muda o StartedAt dos containers do CRM.
printf '%s\n' "$*" | tee -a "$FAKE_ALL_CALLS" >>"$FAKE_CALLS"
S=$FAKE_STATE
svc_of(){ case "$1" in cid-api) echo evolution-api ;; cid-db) echo evolution-db ;; *) return 1 ;; esac; }
get(){ cat "$S/$1" 2>/dev/null || printf '%s' "${2:-}"; }
case "$1" in
  ps)
    svc="${*: -1}"; svc=${svc##*=}
    [[ "$(get "$svc.state" absent)" != absent ]] || exit 0
    [[ "$svc" == evolution-api ]] && echo cid-api || echo cid-db
    [[ ! -f "$S/$svc.dup" ]] || echo cid-dup
    exit 0 ;;
  inspect)
    tpl=$3 target=$4
    if svc=$(svc_of "$target"); then
      case "$tpl" in
        *'.State.Status}}') get "$svc.state" ;;
        *'.State.Health'*) get "$svc.health" healthy ;;
        *PortBindings*) get "$svc.ports" ;;
        *'.NetworkSettings.Networks'*)
          if [[ "$svc" == evolution-api ]]; then get "$svc.networks" 'gest-o-whatsapp_whatsapp_internal=evolution-api,;gest-o_default=crm-evolution-api,evolution-api,;'
          else get "$svc.networks" 'gest-o-whatsapp_whatsapp_internal=evolution-db,;'; fi ;;
        '{{.Image}}') [[ "$svc" == evolution-api ]] && echo sha256:img-api || echo sha256:img-db ;;
        *HostConfig.Memory*) echo 805306368 ;;
        *Mounts*) echo "gest-o-whatsapp_evolution_instances>/evolution/instances " ;;
        *) exit 98 ;;
      esac
      exit 0
    fi
    case "$target" in
      gest-o-production-api-1|gest-o-production-web-1|gest-o-db-clean-v2-20260717)
        started=2026-01-01T00:00:00Z; [[ ! -f "$S/touched" || "$target" != gest-o-production-api-1 ]] || started=2026-01-02T00:00:00Z
        printf '/%s id-%s running %s sha256:img-%s 0\n' "$target" "$target" "$started" "$target"; exit 0 ;;
    esac
    exit 1 ;;
  image)
    [[ "$2 $3 $4" == 'inspect -f {{.Id}}' ]] || exit 99
    case "$5" in evoapicloud/evolution-api:*@sha256:*) echo sha256:img-api ;; postgres:*@sha256:*) echo sha256:img-db ;; *) exit 1 ;; esac
    exit 0 ;;
  stats) echo '120MiB / 768MiB'; exit 0 ;;
  exec)
    if [[ "$2" == gest-o-production-api-1 ]]; then echo "${FAKE_GET_STATUS:-200}"; else echo 1; fi
    exit 0 ;;
  network) [[ "$2" == inspect ]] || exit 99; get internal true; echo; exit 0 ;;
  logs)
    printf '%s\n' '{"message":"[API] r1 POST /webhooks/communications/evolution 200 (3ms)"}' \
      '{"message":"[API] r2 POST /webhooks/communications/evolution 200 (2ms)"}' \
      '{"message":"[API] r3 POST /api/webhooks/communications/evolution 202 (2ms)"}' \
      '{"message":"[API] r4 POST /webhooks/communications/evolution 401 (1ms)"}' \
      '{"message":"[API] r5 GET /health 200 (1ms)"}'
    exit 0 ;;
  stop)
    svc=$(svc_of "${*: -1}") || exit 1
    echo exited >"$S/$svc.state"; exit 0 ;;
  compose)
    case "$*" in
      *' config --images')
        sed -n 's/^    image: *//p' "${*: -3:1}"
        [[ -z "${FAKE_RENDER_EXTRA:-}" ]] || echo "$FAKE_RENDER_EXTRA"
        exit 0 ;;
      *' pull --quiet') exit 0 ;;
      *' up -d --no-build --pull never --wait --wait-timeout '*)
        for svc in evolution-api evolution-db; do echo running >"$S/$svc.state"; echo "${FAKE_UP_HEALTH:-healthy}" >"$S/$svc.health"; done
        [[ -z "${FAKE_UP_TOUCHES:-}" ]] || : >"$S/touched"
        [[ "${FAKE_UP_HEALTH:-healthy}" == healthy ]] || exit 1
        exit 0 ;;
    esac ;;
esac
printf 'UNEXPECTED %s\n' "$*" | tee -a "$FAKE_ALL_CALLS" >>"$FAKE_CALLS"; exit 99
FAKE
chmod +x "$BIN/docker"

export PATH="$BIN:$PATH" FAKE_CALLS="$TMP/calls" FAKE_ALL_CALLS="$TMP/all-calls" FAKE_STATE="$TMP/state"
export WHATSAPP_ENV_FILE="$TMP/env/whatsapp.env" WHATSAPP_API_ENV_FILE="$TMP/env/api.env"
export WHATSAPP_ENV_EXPECTED_OWNER="${WHATSAPP_ENV_EXPECTED_OWNER:-$(id -un):$(id -gn)}" WHATSAPP_COMPOSE_FILE="$TMP/docker-compose.whatsapp.yml"
cp "$COMPOSE_SRC" "$WHATSAPP_COMPOSE_FILE"

KEY="chave-ficticia-de-teste-0123456789abcdef"
DB_PASSWORD="SenhaFicticiaDeTeste0123456789"
SECRET="segredo-ficticio-de-teste-0123456789abcdef"
write_envs(){ # api_key db_password webhook_secret
  mkdir -p "$TMP/env"
  printf 'WHATSAPP_EVOLUTION_API_KEY=%s\nEVOLUTION_DB_PASSWORD=%s\n' "$1" "$2" >"$WHATSAPP_ENV_FILE"
  printf 'JWT_SECRET=valor-ficticio\nWHATSAPP_EVOLUTION_API_KEY=%s\nWHATSAPP_EVOLUTION_WEBHOOK_SECRET=%s\n' "$KEY" "$3" >"$WHATSAPP_API_ENV_FILE"
  chmod 600 "$WHATSAPP_ENV_FILE" "$WHATSAPP_API_ENV_FILE"
}
reset(){ rm -rf "${TMP:?}/state" "${TMP:?}/env"; mkdir -p "$FAKE_STATE"; : >"$FAKE_CALLS"; cp "$COMPOSE_SRC" "$WHATSAPP_COMPOSE_FILE"; }
run(){ # action -> OUT, RC
  set +e; OUT=$(WHATSAPP_ACTION="$1" bash "$SCRIPT" 2>&1); RC=$?; set -e
}
expect_fail(){ # descrição padrão
  [[ "$RC" -ne 0 ]] || fail "$1: deveria falhar"
  grep -q 'WHATSAPP_EVOLUTION_RESULT=FAIL' <<<"$OUT" || fail "$1: sem RESULT=FAIL"
  grep -q -- "$2" <<<"$OUT" || fail "$1: motivo esperado '$2' ausente: $OUT"
}
no_compose(){ ! grep -q '^compose' "$FAKE_CALLS" || fail "$1: compose chamado"; }
no_secret_leak(){
  ! grep -qE "$KEY|$DB_PASSWORD|$SECRET|valor-ficticio" <<<"$OUT" || fail "$1: valor de env impresso"
}

# Ação inválida e compose ausente.
reset; run down; expect_fail 'ação down' 'ação inválida'
reset; WHATSAPP_COMPOSE_FILE="$TMP/nao-existe.yml" run status; expect_fail 'compose ausente' 'não encontrado'

# status sem nada instalado: só leitura, NOT_RUNNING, exit 0.
reset; run status
[[ "$RC" -eq 0 ]] || fail "status vazio: $OUT"
grep -q '^WHATSAPP_ENV=ABSENT$' <<<"$OUT" || fail 'status vazio: env deveria ser ABSENT'
grep -q '^evolution-api: AUSENTE$' <<<"$OUT" || fail 'status vazio: api deveria ser AUSENTE'
grep -q '^WHATSAPP_EVOLUTION_RESULT=NOT_RUNNING$' <<<"$OUT" || fail 'status vazio: NOT_RUNNING'
no_compose 'status vazio'

# up feliz: segredos conferidos sem imprimir, digests, só gest-o-whatsapp, CRM intacto, healthy.
reset; write_envs "$KEY" "$DB_PASSWORD" "$SECRET"; run up
[[ "$RC" -eq 0 ]] || fail "up feliz: $OUT"
for line in 'WHATSAPP_ENV=PROTECTED API_ENV=PROTECTED' 'SEGREDOS=PRESENTES' \
  'WHATSAPP_EVOLUTION_API_KEY entre .env e whatsapp.env: iguais' 'IMAGENS_COM_DIGEST=CONFERE' \
  'CRM_API_WEB_DB=INTACTOS' 'evolution-api: estado=running health=healthy' 'evolution-db: estado=running health=healthy' \
  'evolution-api: portas_publicadas=nenhuma' 'evolution-db: portas_publicadas=nenhuma' \
  'GET http://crm-evolution-api:8080/ pela API: 200' 'WHATSAPP_EVOLUTION_RESULT=OK'; do
  grep -qxF "$line" <<<"$OUT" || fail "up feliz: linha ausente '$line': $OUT"
done
grep -q '^evolution-api: imagem_em_execucao=sha256:img-api CONFERE$' <<<"$OUT" || fail 'up feliz: imagem da api'
grep -q '^evolution-api: entradas_em_/evolution/instances=1$' <<<"$OUT" || fail 'up feliz: contagem do volume'
no_secret_leak 'up feliz'
compose_calls=$(grep '^compose' "$FAKE_CALLS" | sed 's/ -f [^ ]*/ -f COMPOSE/')
expected_compose="compose -p gest-o-whatsapp --env-file $WHATSAPP_ENV_FILE -f COMPOSE config --images
compose -p gest-o-whatsapp --env-file $WHATSAPP_ENV_FILE -f COMPOSE pull --quiet
compose -p gest-o-whatsapp --env-file $WHATSAPP_ENV_FILE -f COMPOSE up -d --no-build --pull never --wait --wait-timeout 300"
[[ "$compose_calls" == "$expected_compose" ]] || fail "up feliz: chamadas de compose inesperadas: $compose_calls"

# status depois do up: OK, GET / e contagem do webhook por código, sem tocar em nada.
: >"$FAKE_CALLS"; run status
[[ "$RC" -eq 0 ]] || fail "status ok: $OUT"
grep -qxF 'WHATSAPP_ENV=PROTECTED' <<<"$OUT" || fail 'status ok: env PROTECTED'
grep -qxF 'webhook interno (7 dias, por código): 200=2 202=1 401=1 ' <<<"$OUT" || fail "status ok: contagem do webhook: $OUT"
grep -qxF 'rede gest-o-whatsapp_whatsapp_internal: internal=true' <<<"$OUT" || fail 'status ok: rede interna'
grep -qxF 'WHATSAPP_EVOLUTION_RESULT=OK' <<<"$OUT" || fail 'status ok: RESULT'
no_compose 'status ok'; no_secret_leak 'status ok'

# status com problemas: porta publicada, rede a mais, alias ausente, unhealthy, duplicado, rede interna aberta.
for problem in 'evolution-api.ports:8080/tcp ' 'evolution-db.networks:gest-o-whatsapp_whatsapp_internal=x,;gest-o_default=x,;' \
  'evolution-api.networks:gest-o-whatsapp_whatsapp_internal=x,;gest-o_default=x,;' 'evolution-db.health:unhealthy' \
  'evolution-api.dup:1' 'internal:false'; do
  echo "${problem#*:}" >"$FAKE_STATE/${problem%%:*}"; run status
  expect_fail "status com ${problem%%:*}" 'status com problema'
  rm "$FAKE_STATE/${problem%%:*}"
done
echo healthy >"$FAKE_STATE/evolution-db.health"

# stop: só docker stop, api antes do banco; nada removido; status depois = NOT_RUNNING, exit 0.
: >"$FAKE_CALLS"; run stop
[[ "$RC" -eq 0 ]] || fail "stop: $OUT"
grep -qxF 'WHATSAPP_EVOLUTION_RESULT=STOPPED containers=2' <<<"$OUT" || fail 'stop: RESULT'
[[ "$(grep -c '^stop ' "$FAKE_CALLS")" -eq 2 && "$(grep '^stop ' "$FAKE_CALLS" | head -n1)" == 'stop --time 30 cid-api' ]] || fail "stop: ordem/argumentos: $(cat "$FAKE_CALLS")"
no_compose 'stop'
run status
[[ "$RC" -eq 0 ]] || fail "status parado: $OUT"
grep -qxF 'evolution-api: PARADO' <<<"$OUT" || fail 'status parado: PARADO'
grep -qxF 'WHATSAPP_EVOLUTION_RESULT=NOT_RUNNING' <<<"$OUT" || fail 'status parado: NOT_RUNNING'

# up recusado antes de qualquer compose.
reset; run up; expect_fail 'up sem env' 'env protegido inválido (ABSENT)'; no_compose 'up sem env'
reset; write_envs "$KEY" "$DB_PASSWORD" "$SECRET"; chmod 644 "$WHATSAPP_ENV_FILE"; run up
expect_fail 'up env 644' 'INVALID_MODE'; no_compose 'up env 644'
reset; write_envs "$KEY" "$DB_PASSWORD" "$SECRET"; mv "$WHATSAPP_ENV_FILE" "$TMP/env/real.env"; ln -s "$TMP/env/real.env" "$WHATSAPP_ENV_FILE"; run up
expect_fail 'up env symlink' 'INVALID_TYPE'; no_compose 'up env symlink'
reset; write_envs "$KEY" "$DB_PASSWORD" "$SECRET"; chmod 644 "$WHATSAPP_API_ENV_FILE"; run up
expect_fail 'up env da API 644' 'INVALID_MODE'; no_compose 'up env da API 644'
reset; write_envs "$KEY" 'Senha-Com-Simbolo-0123456789' "$SECRET"; run up
expect_fail 'up senha com símbolo' 'EVOLUTION_DB_PASSWORD'; no_compose 'up senha com símbolo'; no_secret_leak 'up senha com símbolo'
reset; write_envs "$KEY" 'Curta123' "$SECRET"; run up
expect_fail 'up senha curta' 'EVOLUTION_DB_PASSWORD'; no_compose 'up senha curta'
reset; write_envs '' "$DB_PASSWORD" "$SECRET"; run up
expect_fail 'up chave vazia' 'whatsapp.env: WHATSAPP_EVOLUTION_API_KEY'; no_compose 'up chave vazia'
reset; write_envs "$KEY" "$DB_PASSWORD" ''; run up
expect_fail 'up sem segredo do webhook' 'WHATSAPP_EVOLUTION_WEBHOOK_SECRET'; no_compose 'up sem segredo do webhook'
reset; write_envs "outra-chave-ficticia-0123456789abcdefgh" "$DB_PASSWORD" "$SECRET"; run up
expect_fail 'up chaves diferentes' 'difere'
grep -qxF 'WHATSAPP_EVOLUTION_API_KEY entre .env e whatsapp.env: diferentes' <<<"$OUT" || fail 'up chaves diferentes: linha "diferentes"'
no_compose 'up chaves diferentes'; no_secret_leak 'up chaves diferentes'

# Imagens: sem digest no compose, ou renderizadas diferentes.
reset; write_envs "$KEY" "$DB_PASSWORD" "$SECRET"; sed -i 's/@sha256:[0-9a-f]*//' "$WHATSAPP_COMPOSE_FILE"; run up
expect_fail 'up sem digest' 'imagem sem digest exato'; no_compose 'up sem digest'
reset; write_envs "$KEY" "$DB_PASSWORD" "$SECRET"; FAKE_RENDER_EXTRA='imagem-ficticia:latest' run up
expect_fail 'up imagens diferentes' 'imagens renderizadas diferem'
! grep -q ' up -d' "$FAKE_CALLS" || fail 'up imagens diferentes: up chamado'

# CRM tocado durante o up, e Evolution que não fica healthy.
reset; write_envs "$KEY" "$DB_PASSWORD" "$SECRET"; FAKE_UP_TOUCHES=1 run up
expect_fail 'up tocou o CRM' 'api, web ou db do CRM mudaram'
reset; write_envs "$KEY" "$DB_PASSWORD" "$SECRET"; FAKE_UP_HEALTH=unhealthy run up
expect_fail 'up unhealthy' 'não ficou healthy'

# Em nenhum cenário: down, rm, volume, prune, -v, restart ou recriação forçada.
! grep -qE '(^| )(down|rm|volume|prune|restart|kill)( |$)|(^| )-v( |$)|--volumes|--force-recreate|--remove-orphans' "$FAKE_ALL_CALLS" || fail "comando proibido: $(cat "$FAKE_ALL_CALLS")"
! grep -q '^UNEXPECTED' "$FAKE_ALL_CALLS" || fail "chamada inesperada ao docker: $(grep '^UNEXPECTED' "$FAKE_ALL_CALLS")"

# Workflow: só disparo manual na main, aprovação do production-cutover, fila do Deploy Production.
WF="$ROOT/.github/workflows/whatsapp-evolution.yml"
grep -qx '  workflow_dispatch:' "$WF" || fail 'workflow: workflow_dispatch'
! grep -qE '^  (push|pull_request|pull_request_target|schedule|workflow_run|workflow_call):' "$WF" || fail 'workflow: só workflow_dispatch'
grep -qx '        options: \[status, up, stop\]' "$WF" || fail 'workflow: ações status, up, stop'
grep -qx "    if: github.ref == 'refs/heads/main'" "$WF" || fail 'workflow: só na main'
grep -qx '    environment: production-cutover' "$WF" || fail 'workflow: environment production-cutover'
grep -qx '  group: deploy-production' "$WF" || fail 'workflow: grupo deploy-production'
grep -qx '  cancel-in-progress: false' "$WF" || fail 'workflow: cancel-in-progress false'
! grep -q 'script_stop: true' "$WF" || fail 'workflow: sem script_stop'
grep -q 'source: scripts/whatsapp-evolution-remote.sh,docker-compose.whatsapp.yml$' "$WF" || fail 'workflow: copia script e compose do commit'

printf 'whatsapp-evolution-safety: OK\n'
