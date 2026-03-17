#!/bin/bash
set -euo pipefail

LOG_DIR="${DEPLOY_LOG_DIR:-./logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"

# Tabelas críticas monitoradas para detectar perda inesperada de dados.
CRITICAL_TABLES=("User" "Client" "Opportunity" "TimelineEvent" "AgendaEvent" "Activity")

declare -A PRE_COUNTS=()
declare -A POST_COUNTS=()

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
  local -n target_ref=$2
  local table=""

  log "Coletando snapshot de contagem ($phase)..."
  for table in "${CRITICAL_TABLES[@]}"; do
    local count=""
    count="$(run_psql_count "$table")"

    if [[ ! "$count" =~ ^[0-9]+$ ]]; then
      log "ERRO: Não foi possível ler contagem válida para tabela $table no snapshot $phase (valor recebido: '$count')."
      exit 1
    fi

    target_ref["$table"]="$count"
    log "Snapshot $phase | tabela=$table | total=$count"
  done
}

validate_data_safety() {
  local -a reasons=()
  local table=""
  local zeroed_tables=0

  # Regra global: múltiplas tabelas críticas zeradas simultaneamente indicam risco severo.
  for table in "${CRITICAL_TABLES[@]}"; do
    local before="${PRE_COUNTS[$table]:-0}"
    local after="${POST_COUNTS[$table]:-0}"

    if (( before > 0 && after == 0 )); then
      ((zeroed_tables += 1))
    fi
  done

  if (( ${POST_COUNTS["User"]:-0} == 0 )); then
    reasons+=("Tabela User ficou com zero registros após o deploy")
  fi

  if (( ${PRE_COUNTS["Client"]:-0} > 0 && ${POST_COUNTS["Client"]:-0} == 0 )); then
    reasons+=("Client tinha dados antes do deploy e ficou zerada")
  fi

  if (( ${PRE_COUNTS["Opportunity"]:-0} > 0 && ${POST_COUNTS["Opportunity"]:-0} == 0 )); then
    reasons+=("Opportunity tinha dados antes do deploy e ficou zerada")
  fi

  if (( ${PRE_COUNTS["TimelineEvent"]:-0} > 0 && ${POST_COUNTS["TimelineEvent"]:-0} == 0 )); then
    reasons+=("TimelineEvent tinha dados antes do deploy e ficou zerada")
  fi

  if (( zeroed_tables >= 2 )); then
    reasons+=("Múltiplas tabelas críticas zeraram ao mesmo tempo (total=$zeroed_tables)")
  fi

  if (( ${#reasons[@]} > 0 )); then
    log "ERRO CRÍTICO: trava de segurança de dados acionada."
    for reason in "${reasons[@]}"; do
      log "- $reason"
    done

    log "Comparativo final de contagens críticas:"
    for table in "${CRITICAL_TABLES[@]}"; do
      log "  $table: antes=${PRE_COUNTS[$table]} | depois=${POST_COUNTS[$table]}"
    done

    log "Deploy abortado por segurança. Revise o banco e restaure manualmente se necessário."
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

  collect_counts "antes" PRE_COUNTS

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

  collect_counts "depois" POST_COUNTS
  validate_data_safety

  log "Deploy concluído com sucesso!"
}

main "$@"
