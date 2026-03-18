#!/bin/bash
set -euo pipefail

LOG_DIR="${DEPLOY_LOG_DIR:-./logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"

CRITICAL_TABLES=("User" "Client" "Opportunity" "TimelineEvent" "AgendaEvent" "Activity")
CHECK_SCRIPT="${DEPLOY_DB_CHECK_SCRIPT:-./scripts/check-prod-health.sh}"
API_HEALTH_URL="${DEPLOY_API_HEALTH_URL:-http://127.0.0.1:4000/health}"
API_HEALTH_MAX_RETRIES="${DEPLOY_API_HEALTH_MAX_RETRIES:-30}"
API_HEALTH_SLEEP_SECONDS="${DEPLOY_API_HEALTH_SLEEP_SECONDS:-5}"

ANTES_USER=0
ANTES_CLIENT=0
ANTES_OPPORTUNITY=0
ANTES_TIMELINE_EVENT=0
ANTES_AGENDA_EVENT=0
ANTES_ACTIVITY=0
DEPOIS_USER=0
DEPOIS_CLIENT=0
DEPOIS_OPPORTUNITY=0
DEPOIS_TIMELINE_EVENT=0
DEPOIS_AGENDA_EVENT=0
DEPOIS_ACTIVITY=0

ts() {
  date '+%Y-%m-%d %H:%M:%S'
}

log() {
  echo "[$(ts)] $*" | tee -a "$LOG_FILE"
}

require_check_script() {
  if [[ ! -x "$CHECK_SCRIPT" ]]; then
    log "ERRO: script de checagem não encontrado ou sem permissão de execução: $CHECK_SCRIPT"
    exit 1
  fi
}

collect_counts() {
  local phase="$1"
  local prefix=""

  require_check_script
  eval "$(bash "$CHECK_SCRIPT" --format shell --no-strict)"

  if [[ "$phase" == "antes" ]]; then
    prefix="ANTES"
    log "[SAFEGUARD] Snapshot antes do deploy"
  else
    prefix="DEPOIS"
    log "[SAFEGUARD] Snapshot depois do deploy"
  fi

  for table_name in "${CRITICAL_TABLES[@]}"; do
    local source_var=""
    local target_var=""
    local count=""

    case "$table_name" in
      User) source_var="USER_COUNT"; target_var="${prefix}_USER" ;;
      Client) source_var="CLIENT_COUNT"; target_var="${prefix}_CLIENT" ;;
      Opportunity) source_var="OPPORTUNITY_COUNT"; target_var="${prefix}_OPPORTUNITY" ;;
      TimelineEvent) source_var="TIMELINE_EVENT_COUNT"; target_var="${prefix}_TIMELINE_EVENT" ;;
      AgendaEvent) source_var="AGENDA_EVENT_COUNT"; target_var="${prefix}_AGENDA_EVENT" ;;
      Activity) source_var="ACTIVITY_COUNT"; target_var="${prefix}_ACTIVITY" ;;
      *)
        log "ERRO: tabela crítica desconhecida: $table_name"
        exit 1
        ;;
    esac

    count="${!source_var}"
    if [[ ! "$count" =~ ^[0-9]+$ ]]; then
      log "ERRO: contagem inválida para $table_name no snapshot $phase: '$count'"
      exit 1
    fi

    printf -v "$target_var" '%s' "$count"
    log "Snapshot $phase | tabela=$table_name | total=$count"
  done
}

wait_for_api_healthcheck() {
  local attempt=1

  log "Aguardando healthcheck real da API em $API_HEALTH_URL ..."
  while (( attempt <= API_HEALTH_MAX_RETRIES )); do
    local health_status=""
    health_status="$(curl -sS -o /dev/null -w '%{http_code}' "$API_HEALTH_URL" || true)"

    if [[ "$health_status" == "200" ]]; then
      log "Healthcheck da API OK (HTTP 200) após ${attempt} tentativa(s)."
      return
    fi

    log "Healthcheck da API ainda indisponível (tentativa ${attempt}/${API_HEALTH_MAX_RETRIES}, HTTP ${health_status:-000})."
    sleep "$API_HEALTH_SLEEP_SECONDS"
    ((attempt += 1))
  done

  log "ERRO: Healthcheck da API falhou após ${API_HEALTH_MAX_RETRIES} tentativas."
  exit 1
}

validate_data_safety() {
  local -a reasons=()
  local zeroed_tables_after=0

  if (( ANTES_USER > 0 && DEPOIS_USER == 0 )); then
    reasons+=("User tinha dados antes do deploy e ficou zerada")
    ((zeroed_tables_after += 1))
  fi

  if (( ANTES_CLIENT > 0 && DEPOIS_CLIENT == 0 )); then
    reasons+=("Client tinha dados antes do deploy e ficou zerada")
    reasons+=("Client caiu para zero após o deploy")
    ((zeroed_tables_after += 1))
  fi

  if (( ANTES_OPPORTUNITY > 0 && DEPOIS_OPPORTUNITY == 0 )); then
    reasons+=("Opportunity tinha dados antes do deploy e ficou zerada")
    reasons+=("Opportunity caiu para zero após o deploy")
    ((zeroed_tables_after += 1))
  fi

  if (( ANTES_TIMELINE_EVENT > 0 && DEPOIS_TIMELINE_EVENT == 0 )); then
    reasons+=("TimelineEvent tinha dados antes do deploy e ficou zerada")
    reasons+=("TimelineEvent caiu para zero após o deploy")
    ((zeroed_tables_after += 1))
  fi

  if (( ANTES_AGENDA_EVENT > 0 && DEPOIS_AGENDA_EVENT == 0 )); then
    reasons+=("AgendaEvent tinha dados antes do deploy e ficou zerada")
    ((zeroed_tables_after += 1))
  fi

  if (( ANTES_ACTIVITY > 0 && DEPOIS_ACTIVITY == 0 )); then
    reasons+=("Activity tinha dados antes do deploy e ficou zerada")
    ((zeroed_tables_after += 1))
  fi

  if (( zeroed_tables_after >= 2 )); then
    reasons+=("Múltiplas tabelas críticas zeraram após o deploy (total=${zeroed_tables_after})")
  fi

  if (( ${#reasons[@]} > 0 )); then
    log "[CRITICAL] DEPLOY BLOQUEADO: perda de dados detectada"
    log "Comparativo final de contagens críticas:"
    log "  User: antes=$ANTES_USER | depois=$DEPOIS_USER"
    log "  Client: antes=$ANTES_CLIENT | depois=$DEPOIS_CLIENT"
    log "  Opportunity: antes=$ANTES_OPPORTUNITY | depois=$DEPOIS_OPPORTUNITY"
    log "  TimelineEvent: antes=$ANTES_TIMELINE_EVENT | depois=$DEPOIS_TIMELINE_EVENT"
    log "  AgendaEvent: antes=$ANTES_AGENDA_EVENT | depois=$DEPOIS_AGENDA_EVENT"
    log "  Activity: antes=$ANTES_ACTIVITY | depois=$DEPOIS_ACTIVITY"
    for reason in "${reasons[@]}"; do
      log "- $reason"
    done
    exit 1
  fi

  log "Validação de segurança concluída: nenhuma perda crítica detectada."
}

main() {
  log "Log do deploy: $LOG_FILE"
  log "Fazendo backup antes do deploy..."

  if [[ -x /apps/gest-o/backup.sh ]]; then
    bash /apps/gest-o/backup.sh | tee -a "$LOG_FILE"
  elif [[ -x ./backup.sh ]]; then
    bash ./backup.sh | tee -a "$LOG_FILE"
  else
    log "ERRO: script de backup não encontrado em /apps/gest-o/backup.sh nem ./backup.sh"
    exit 1
  fi

  collect_counts "antes"

  log "Iniciando deploy..."
  docker compose down | tee -a "$LOG_FILE"
  docker compose up -d --build | tee -a "$LOG_FILE"

  log "Status dos serviços:"
  docker compose ps | tee -a "$LOG_FILE"

  wait_for_api_healthcheck
  collect_counts "depois"
  validate_data_safety

  log "Deploy concluído com sucesso!"
}

main "$@"
