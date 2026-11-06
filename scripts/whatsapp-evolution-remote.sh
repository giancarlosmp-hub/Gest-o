#!/usr/bin/env bash
# WhatsApp Fase A: consulta, sobe ou para o projeto Compose gest-o-whatsapp (Evolution API e o banco dele)
# na VPS. Chamado só pelo workflow "WhatsApp Evolution", que copia este script e o
# docker-compose.whatsapp.yml do mesmo commit para uma pasta temporária.
#
#   status  só leitura: containers, health, imagem/digest, redes, portas, memória, volume, GET / visto pela
#           API e contagem por status do webhook interno no log da API.
#   up      valida os env protegidos (sem imprimir valores), confere digests, sobe só gest-o-whatsapp,
#           espera healthy e confere que api, web e db do CRM não foram tocados.
#   stop    para os containers do projeto. Não remove container, volume nem rede: a sessão do WhatsApp fica.
#
# Nunca imprime valores de env, logs do Evolution nem o corpo de nada.
set -Eeuo pipefail

ACTION="${WHATSAPP_ACTION:-}"
COMPOSE_FILE="${WHATSAPP_COMPOSE_FILE:-}"
PROJECT=gest-o-whatsapp
WHATSAPP_ENV_FILE="${WHATSAPP_ENV_FILE:-/root/demetra-env/whatsapp.env}"
API_ENV_FILE="${WHATSAPP_API_ENV_FILE:-/root/demetra-env/.env}"
EXPECTED_OWNER="${WHATSAPP_ENV_EXPECTED_OWNER:-root:root}"
EXPECTED_MODE="${WHATSAPP_ENV_EXPECTED_MODE:-600}"
API_CONTAINER="${API_CONTAINER:-gest-o-production-api-1}"
WEB_CONTAINER="${WEB_CONTAINER:-gest-o-production-web-1}"
DB_CONTAINER="${DB_CONTAINER:-gest-o-db-clean-v2-20260717}"
WAIT_TIMEOUT="${WHATSAPP_WAIT_TIMEOUT:-300}"
INTERNAL_NETWORK="${PROJECT}_whatsapp_internal"
PRODUCTION_NETWORK=gest-o_default
EVOLUTION_ALIAS=crm-evolution-api
SERVICES=(evolution-api evolution-db)

log(){ printf '%s\n' "$*"; }
die(){ printf 'WHATSAPP_EVOLUTION_RESULT=FAIL\nWHATSAPP_EVOLUTION_REASON=%s\n' "$*" >&2; exit 1; }

[[ "$ACTION" == status || "$ACTION" == up || "$ACTION" == stop ]] || die "ação inválida (status, up ou stop)"
[[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]] || die "docker-compose.whatsapp.yml não encontrado"
log "WHATSAPP_EVOLUTION_ACTION=$ACTION"

# Imagens esperadas: as linhas image: do compose deste commit, todas com digest exato.
mapfile -t EXPECTED_IMAGES < <(sed -n 's/^    image: *//p' "$COMPOSE_FILE" | sort)
[[ "${#EXPECTED_IMAGES[@]}" -eq "${#SERVICES[@]}" ]] || die "compose deveria declarar ${#SERVICES[@]} imagens"
for ref in "${EXPECTED_IMAGES[@]}"; do
  [[ "$ref" =~ ^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] || die "imagem sem digest exato: $ref"
done
expected_image_for(){ # service -> referência declarada no bloco do serviço
  awk -v s="  $1:" '$0==s{f=1; next} f && /^  [a-z]/{f=0} f && /^    image:/{sub(/^    image: */, ""); print; exit}' "$COMPOSE_FILE"
}

# Arquivo protegido: regular, sem symlink, dono e modo esperados. Só metadados; nada é lido aqui.
protected_file_state(){
  local file=$1
  [[ -e "$file" || -L "$file" ]] || { printf 'ABSENT'; return 0; }
  [[ -f "$file" && ! -L "$file" ]] || { printf 'INVALID_TYPE'; return 0; }
  [[ "$(stat -c '%U:%G' "$file")" == "$EXPECTED_OWNER" ]] || { printf 'INVALID_OWNER'; return 0; }
  [[ "$(stat -c '%a' "$file")" == "$EXPECTED_MODE" ]] || { printf 'INVALID_MODE'; return 0; }
  printf 'PROTECTED'
}

# Lê uma variável num subshell e devolve só um veredito ou um hash; o valor nunca sai do subshell.
env_value_check(){ # file key regex -> OK | MISSING | INVALID
  ( set +x; set -a; source "$1" >/dev/null 2>&1 || exit 3; value="${!2-}"
    [[ -n "$value" ]] || { printf 'MISSING'; exit 0; }
    [[ "$value" =~ $3 ]] || { printf 'INVALID'; exit 0; }
    printf 'OK' ) || printf 'UNREADABLE'
}
env_value_hash(){ # file key -> sha256 do valor (só para comparar; nunca impresso)
  ( set +x; set -a; source "$1" >/dev/null 2>&1 || exit 3; printf '%s' "${!2-}" | sha256sum | cut -d' ' -f1 )
}

container_for(){ # service -> id(s) do projeto (vazio se ausente)
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | sed '/^$/d'
}

# Confere um serviço e imprime o relatório. Devolve 0 (ok), 2 (parado/ausente) ou 1 (problema).
check_service(){
  local svc=$1 cid state health ports networks image expected expected_id rc=0
  cid=$(container_for "$svc")
  if [[ -z "$cid" ]]; then log "$svc: AUSENTE"; return 2; fi
  if [[ "$(printf '%s\n' "$cid" | wc -l)" -ne 1 ]]; then log "$svc: PROBLEMA mais de um container"; return 1; fi
  state=$(docker inspect -f '{{.State.Status}}' "$cid")
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sem-healthcheck{{end}}' "$cid")
  ports=$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{$p}} {{end}}{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{$p}}->{{.HostPort}} {{end}}{{end}}' "$cid")
  networks=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{range $v.Aliases}}{{.}},{{end}};{{end}}' "$cid")
  image=$(docker inspect -f '{{.Image}}' "$cid")
  expected=$(expected_image_for "$svc")
  expected_id=$(docker image inspect -f '{{.Id}}' "$expected" 2>/dev/null || true)
  log "$svc: estado=$state health=$health"
  log "$svc: imagem=$expected"
  log "$svc: imagem_em_execucao=$image $([[ -n "$expected_id" && "$image" == "$expected_id" ]] && echo CONFERE || echo DIFERENTE)"
  log "$svc: redes=${networks:-nenhuma}"
  log "$svc: portas_publicadas=${ports:-nenhuma}"
  log "$svc: limite_memoria=$(docker inspect -f '{{.HostConfig.Memory}}' "$cid") bytes"
  log "$svc: volumes=$(docker inspect -f '{{range .Mounts}}{{.Name}}>{{.Destination}} {{end}}' "$cid")"
  [[ -z "$ports" ]] || { log "$svc: PROBLEMA porta publicada"; rc=1; }
  [[ -n "$expected_id" && "$image" == "$expected_id" ]] || { log "$svc: PROBLEMA imagem diferente da declarada"; rc=1; }
  local names
  names=$(printf '%s' "$networks" | tr ';' '\n' | sed '/^$/d; s/=.*//' | sort | tr '\n' ' ')
  if [[ "$svc" == evolution-api ]]; then
    [[ "$names" == "$INTERNAL_NETWORK $PRODUCTION_NETWORK " || "$names" == "$PRODUCTION_NETWORK $INTERNAL_NETWORK " ]] || { log "$svc: PROBLEMA redes inesperadas"; rc=1; }
    [[ ";$networks" == *";$PRODUCTION_NETWORK="*"$EVOLUTION_ALIAS,"* ]] || { log "$svc: PROBLEMA alias $EVOLUTION_ALIAS ausente"; rc=1; }
  else
    [[ "$names" == "$INTERNAL_NETWORK " ]] || { log "$svc: PROBLEMA redes inesperadas"; rc=1; }
  fi
  if [[ "$state" != running ]]; then log "$svc: PARADO"; [[ "$rc" -ne 0 ]] || rc=2; return "$rc"; fi
  log "$svc: memoria_em_uso=$(docker stats --no-stream --format '{{.MemUsage}}' "$cid" 2>/dev/null || echo ilegível)"
  [[ "$health" == healthy ]] || { log "$svc: PROBLEMA não está healthy"; rc=1; }
  if [[ "$svc" == evolution-api ]]; then
    log "$svc: entradas_em_/evolution/instances=$(docker exec "$cid" sh -c 'ls -A /evolution/instances 2>/dev/null | wc -l' 2>/dev/null || echo ilegível)"
  fi
  return "$rc"
}

# Relatório completo (status e fim do up). Devolve 0 (ok), 2 (parado/ausente) ou 1 (problema).
report(){
  local svc result overall=0 internal webhook
  log "WHATSAPP_ENV=$(protected_file_state "$WHATSAPP_ENV_FILE")"
  for svc in "${SERVICES[@]}"; do
    result=0; check_service "$svc" || result=$?
    [[ "$result" -ne 1 ]] || overall=1
    [[ "$result" -ne 2 || "$overall" -eq 1 ]] || overall=2
  done
  internal=$(docker network inspect -f '{{.Internal}}' "$INTERNAL_NETWORK" 2>/dev/null || echo ausente)
  log "rede $INTERNAL_NETWORK: internal=$internal"
  [[ "$internal" == true || "$internal" == ausente ]] || { log "PROBLEMA rede interna sem internal: true"; overall=1; }
  if [[ "$overall" -eq 0 ]]; then
    # GET / do Evolution visto de dentro da API, pela rede gest-o_default: só o código HTTP.
    log "GET http://$EVOLUTION_ALIAS:8080/ pela API: $(docker exec "$API_CONTAINER" node -e "fetch('http://$EVOLUTION_ALIAS:8080/',{signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status)).catch(()=>console.log('erro'))" 2>/dev/null || echo ilegível)"
  fi
  # Webhook interno nos últimos 7 dias do log da API: só contagem por código (200/202 = segredo aceito).
  webhook=$(docker logs --since 168h "$API_CONTAINER" 2>&1 | grep -oE 'POST (/api)?/webhooks/communications/evolution [0-9]{3}' | awk '{print $NF}' | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}' || true)
  log "webhook interno (7 dias, por código): ${webhook:-nenhuma chamada}"
  return "$overall"
}

production_snapshot(){ # nome, id, início e imagem de api, web e db do CRM
  local c
  for c in "$API_CONTAINER" "$WEB_CONTAINER" "$DB_CONTAINER"; do
    docker inspect -f '{{.Name}} {{.Id}} {{.State.Status}} {{.State.StartedAt}} {{.Image}} {{.RestartCount}}' "$c" 2>/dev/null || die "container do CRM ausente: $c"
  done
}

case "$ACTION" in
  status)
    result=0; report || result=$?
    [[ "$result" -ne 1 ]] || die "status com problema (ver acima)"
    [[ "$result" -ne 2 ]] || { log "WHATSAPP_EVOLUTION_RESULT=NOT_RUNNING"; exit 0; }
    log "WHATSAPP_EVOLUTION_RESULT=OK"
    ;;
  stop)
    stopped=0
    # A API para antes do banco dela.
    for svc in "${SERVICES[@]}"; do
      cid=$(container_for "$svc")
      [[ -n "$cid" ]] || { log "$svc: AUSENTE"; continue; }
      [[ "$(printf '%s\n' "$cid" | wc -l)" -eq 1 ]] || die "mais de um container para $svc"
      docker stop --time 30 "$cid" >/dev/null
      log "$svc: PARADO (container, volume e rede preservados)"
      stopped=$((stopped + 1))
    done
    log "WHATSAPP_EVOLUTION_RESULT=STOPPED containers=$stopped"
    ;;
  up)
    for file in "$WHATSAPP_ENV_FILE" "$API_ENV_FILE"; do
      state=$(protected_file_state "$file")
      [[ "$state" == PROTECTED ]] || die "env protegido inválido ($state): $file"
    done
    log "WHATSAPP_ENV=PROTECTED API_ENV=PROTECTED"
    [[ "$(env_value_check "$WHATSAPP_ENV_FILE" WHATSAPP_EVOLUTION_API_KEY '^.{32,}$')" == OK ]] || die "whatsapp.env: WHATSAPP_EVOLUTION_API_KEY ausente ou com menos de 32 caracteres"
    [[ "$(env_value_check "$WHATSAPP_ENV_FILE" EVOLUTION_DB_PASSWORD '^[A-Za-z0-9]{24,}$')" == OK ]] || die "whatsapp.env: EVOLUTION_DB_PASSWORD ausente, com menos de 24 caracteres ou fora de letras e números"
    [[ "$(env_value_check "$API_ENV_FILE" WHATSAPP_EVOLUTION_API_KEY '^.{32,}$')" == OK ]] || die "env da API: WHATSAPP_EVOLUTION_API_KEY ausente ou com menos de 32 caracteres"
    [[ "$(env_value_check "$API_ENV_FILE" WHATSAPP_EVOLUTION_WEBHOOK_SECRET '^.{32,}$')" == OK ]] || die "env da API: WHATSAPP_EVOLUTION_WEBHOOK_SECRET ausente ou com menos de 32 caracteres"
    log "SEGREDOS=PRESENTES"
    if [[ "$(env_value_hash "$WHATSAPP_ENV_FILE" WHATSAPP_EVOLUTION_API_KEY)" == "$(env_value_hash "$API_ENV_FILE" WHATSAPP_EVOLUTION_API_KEY)" ]]; then
      log "WHATSAPP_EVOLUTION_API_KEY entre .env e whatsapp.env: iguais"
    else
      log "WHATSAPP_EVOLUTION_API_KEY entre .env e whatsapp.env: diferentes"
      die "a chave do Evolution difere entre o env da API e o whatsapp.env"
    fi

    COMPOSE=(docker compose -p "$PROJECT" --env-file "$WHATSAPP_ENV_FILE" -f "$COMPOSE_FILE")
    rendered=$("${COMPOSE[@]}" config --images 2>/dev/null | sort) || die "compose do WhatsApp não renderiza"
    [[ "$rendered" == "$(printf '%s\n' "${EXPECTED_IMAGES[@]}")" ]] || die "imagens renderizadas diferem das declaradas com digest"
    log "IMAGENS_COM_DIGEST=CONFERE"

    before=$(production_snapshot)
    "${COMPOSE[@]}" pull --quiet || die "pull das imagens do WhatsApp falhou"
    up_rc=0
    "${COMPOSE[@]}" up -d --no-build --pull never --wait --wait-timeout "$WAIT_TIMEOUT" || up_rc=$?
    after=$(production_snapshot)
    [[ "$before" == "$after" ]] || die "api, web ou db do CRM mudaram durante o up"
    log "CRM_API_WEB_DB=INTACTOS"
    result=0; report || result=$?
    [[ "$up_rc" -eq 0 ]] || die "o Evolution não ficou healthy em ${WAIT_TIMEOUT}s"
    [[ "$result" -eq 0 ]] || die "conferência depois do up com problema (ver acima)"
    log "WHATSAPP_EVOLUTION_RESULT=OK"
    ;;
esac
