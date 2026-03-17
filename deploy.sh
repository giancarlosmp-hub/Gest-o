#!/bin/bash
set -euo pipefail

LOG_DIR="${DEPLOY_LOG_DIR:-./logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"
DB_NAME="salesforce_pro"
CRITICAL_TABLES=("User" "Client" "Opportunity" "TimelineEvent")

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
  docker compose exec -T db psql -U postgres -d "$DB_NAME" -tA -c "SELECT COUNT(*) FROM \"$table\";" | tr -d '[:space:]'
}

collect_snapshot() {
  local label="$1"
  local -n target_ref=$2

  log "[SAFEGUARD] Capturando snapshot de contagens ($label)..."
  for table in "${CRITICAL_TABLES[@]}"; do
    local count
    count="$(run_psql_count "$table")"

    if [[ ! "$count" =~ ^[0-9]+$ ]]; then
      log "[BLOCKED] Não foi possível ler contagem válida de $table em $label (valor='$count')."
      exit 1
    fi

    target_ref["$table"]="$count"
    log "[SAFEGUARD] Snapshot $label | tabela=$table | total=$count"
  done
}

validate_data_integrity() {
  local -a reasons=()
  local zeroed_critical=0

  for table in "${CRITICAL_TABLES[@]}"; do
    local before="${PRE_COUNTS[$table]:-0}"
    local after="${POST_COUNTS[$table]:-0}"
    if (( before > 0 && after == 0 )); then
      ((zeroed_critical += 1))
    fi
  done

  if (( ${PRE_COUNTS["User"]:-0} > 0 && ${POST_COUNTS["User"]:-0} == 0 )); then
    reasons+=("User tinha dados antes e ficou zerada")
  fi

  if (( ${POST_COUNTS["User"]:-0} == 0 )); then
    reasons+=("User == 0 após deploy")
  fi

  if (( ${PRE_COUNTS["Client"]:-0} > 0 && ${POST_COUNTS["Client"]:-0} == 0 )); then
    reasons+=("Client tinha dados antes e ficou zerada")
  fi

  if (( ${PRE_COUNTS["Opportunity"]:-0} > 0 && ${POST_COUNTS["Opportunity"]:-0} == 0 )); then
    reasons+=("Opportunity tinha dados antes e ficou zerada")
  fi

  if (( ${PRE_COUNTS["TimelineEvent"]:-0} > 0 && ${POST_COUNTS["TimelineEvent"]:-0} == 0 )); then
    reasons+=("TimelineEvent tinha dados antes e ficou zerada")
  fi

  if (( zeroed_critical >= 2 )); then
    reasons+=("Múltiplas tabelas críticas zeraram simultaneamente (total=$zeroed_critical)")
  fi

  if (( ${#reasons[@]} > 0 )); then
    log "[CRITICAL] DEPLOY BLOQUEADO: perda de dados detectada"
    for reason in "${reasons[@]}"; do
      log "[BLOCKED] $reason"
    done

    for table in "${CRITICAL_TABLES[@]}"; do
      log "[SAFEGUARD] Comparativo $table | antes=${PRE_COUNTS[$table]} | depois=${POST_COUNTS[$table]}"
    done

    exit 1
  fi

  log "[SAFEGUARD] Validação concluída sem perda de dados detectada"
}

main() {
  log "[INFO] Log do deploy: $LOG_FILE"

  if [[ -x /apps/gest-o/backup.sh ]]; then
    log "[INFO] Executando backup pré-deploy"
    bash /apps/gest-o/backup.sh | tee -a "$LOG_FILE"
  elif [[ -x ./backup.sh ]]; then
    log "[INFO] Executando backup pré-deploy"
    bash ./backup.sh | tee -a "$LOG_FILE"
  else
    log "[BLOCKED] backup.sh não encontrado"
    exit 1
  fi

  collect_snapshot "antes" PRE_COUNTS

  log "[INFO] Iniciando deploy dos containers"
  docker compose down | tee -a "$LOG_FILE"
  docker compose up -d --build | tee -a "$LOG_FILE"

  log "[INFO] Aguardando inicialização"
  sleep 20

  log "[INFO] Status dos serviços"
  docker compose ps | tee -a "$LOG_FILE"

  local health_status
  health_status="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/health || true)"
  if [[ "$health_status" != "200" ]]; then
    log "[BLOCKED] Healthcheck da API falhou (HTTP $health_status)"
    exit 1
  fi
  log "[SAFEGUARD] Healthcheck da API OK"

  collect_snapshot "depois" POST_COUNTS
  validate_data_integrity

  log "[INFO] Deploy concluído com sucesso"
}

main "$@"
