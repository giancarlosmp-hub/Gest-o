#!/bin/bash
set -euo pipefail

LOG_DIR="${DEPLOY_LOG_DIR:-./logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"

CRITICAL_TABLES=("User" "Client" "Opportunity" "TimelineEvent")

ANTES_USER=0
ANTES_CLIENT=0
ANTES_OPP=0
ANTES_TIMELINE=0
DEPOIS_USER=0
DEPOIS_CLIENT=0
DEPOIS_OPP=0
DEPOIS_TIMELINE=0

ts() {
  date '+%Y-%m-%d %H:%M:%S'
}

log() {
  echo "[$(ts)] $*" | tee -a "$LOG_FILE"
}

run_psql_count() {
  local table="$1"
  docker compose exec -T db psql -U postgres -d salesforce_pro -t -A -c "SELECT COUNT(*) FROM \"$table\";" | tr -d '[:space:]'
}

collect_counts() {
  local phase="$1"
  local table=""

  if [[ "$phase" == "antes" ]]; then
    log "[SAFEGUARD] Snapshot antes do deploy"
  else
    log "[SAFEGUARD] Snapshot depois do deploy"
  fi

  for table in "${CRITICAL_TABLES[@]}"; do
    local count=""
    count="$(run_psql_count "$table")"

    if [[ ! "$count" =~ ^[0-9]+$ ]]; then
      log "ERRO: Não foi possível ler contagem válida para tabela $table no snapshot $phase (valor recebido: '$count')."
      exit 1
    fi

    case "$phase:$table" in
      "antes:User") ANTES_USER="$count" ;;
      "antes:Client") ANTES_CLIENT="$count" ;;
      "antes:Opportunity") ANTES_OPP="$count" ;;
      "antes:TimelineEvent") ANTES_TIMELINE="$count" ;;
      "depois:User") DEPOIS_USER="$count" ;;
      "depois:Client") DEPOIS_CLIENT="$count" ;;
      "depois:Opportunity") DEPOIS_OPP="$count" ;;
      "depois:TimelineEvent") DEPOIS_TIMELINE="$count" ;;
    esac

    log "Snapshot $phase | tabela=$table | total=$count"
  done
}

validate_data_safety() {
  local -a reasons=()
  local zeroed_tables=0

  if (( ANTES_USER > 0 && DEPOIS_USER == 0 )); then
    reasons+=("User tinha dados antes do deploy e ficou zerada")
    ((zeroed_tables += 1))
  fi

  if (( ANTES_CLIENT > 0 && DEPOIS_CLIENT == 0 && DEPOIS_OPP == 0 )); then
    reasons+=("Client tinha dados antes do deploy e Client/Opportunity zeraram")
  fi

  if (( ANTES_CLIENT > 0 && DEPOIS_CLIENT == 0 )); then
    ((zeroed_tables += 1))
  fi

  if (( ANTES_OPP > 0 && DEPOIS_OPP == 0 )); then
    ((zeroed_tables += 1))
  fi

  if (( ANTES_TIMELINE > 0 && DEPOIS_TIMELINE == 0 )); then
    ((zeroed_tables += 1))
  fi

  if (( zeroed_tables >= 2 )); then
    reasons+=("Múltiplas tabelas críticas zeraram após o deploy (total=$zeroed_tables)")
  fi

  if (( ${#reasons[@]} > 0 )); then
    log "[CRITICAL] DEPLOY BLOQUEADO: perda de dados detectada"
    log "Comparativo final de contagens críticas:"
    log "  User: antes=$ANTES_USER | depois=$DEPOIS_USER"
    log "  Client: antes=$ANTES_CLIENT | depois=$DEPOIS_CLIENT"
    log "  Opportunity: antes=$ANTES_OPP | depois=$DEPOIS_OPP"
    log "  TimelineEvent: antes=$ANTES_TIMELINE | depois=$DEPOIS_TIMELINE"
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

  # Mantém compatibilidade com o fluxo atual do VPS e fallback para execução local.
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

  log "Aguardando sistema inicializar..."
  sleep 20

  log "Status dos serviços:"
  docker compose ps | tee -a "$LOG_FILE"

  log "Validando healthcheck da API..."
  local health_status=""
  health_status="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/health || true)"
  if [[ "$health_status" != "200" ]]; then
    log "ERRO: Healthcheck da API falhou (HTTP $health_status)."
    exit 1
  fi
  log "Healthcheck da API OK (HTTP 200)."

  collect_counts "depois"
  validate_data_safety

  log "Deploy concluído com sucesso!"
}

main "$@"
