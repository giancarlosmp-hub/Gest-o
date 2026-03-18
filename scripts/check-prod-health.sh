#!/bin/bash
set -euo pipefail

FORMAT="pretty"
STRICT_MODE=1
DB_NAME="${DB_NAME:-salesforce_pro}"
DB_SERVICE="${DB_SERVICE:-db}"
COMPOSE_BIN="${COMPOSE_BIN:-docker compose}"

usage() {
  cat <<'USAGE'
Uso: scripts/check-prod-health.sh [--format pretty|shell] [--strict|--no-strict]

Consulta contagem das tabelas críticas em modo somente leitura e falha com exit 1
quando detectar banco inconsistente.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --format)
      FORMAT="${2:-}"
      shift 2
      ;;
    --strict)
      STRICT_MODE=1
      shift
      ;;
    --no-strict)
      STRICT_MODE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Argumento inválido: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$FORMAT" != "pretty" && "$FORMAT" != "shell" ]]; then
  echo "Formato inválido: $FORMAT" >&2
  exit 2
fi

declare -A COUNTS
TABLES=("User" "Client" "Opportunity" "TimelineEvent" "AgendaEvent" "Activity")

to_var_name() {
  case "$1" in
    User) echo "USER_COUNT" ;;
    Client) echo "CLIENT_COUNT" ;;
    Opportunity) echo "OPPORTUNITY_COUNT" ;;
    TimelineEvent) echo "TIMELINE_EVENT_COUNT" ;;
    AgendaEvent) echo "AGENDA_EVENT_COUNT" ;;
    Activity) echo "ACTIVITY_COUNT" ;;
    *)
      echo "UNKNOWN_COUNT"
      ;;
  esac
}

query_count() {
  local table_name="$1"
  ${COMPOSE_BIN} exec -T "$DB_SERVICE" psql -U postgres -d "$DB_NAME" -tA -c "SELECT COUNT(*) FROM \"${table_name}\";" | tr -d '[:space:]'
}

for table_name in "${TABLES[@]}"; do
  count="$(query_count "$table_name")"
  if [[ ! "$count" =~ ^[0-9]+$ ]]; then
    echo "Falha ao consultar contagem válida para ${table_name}. Valor recebido: '${count}'" >&2
    exit 1
  fi
  COUNTS["$table_name"]="$count"
done

REASONS=()
ZEROED_TABLES=()

for table_name in "${TABLES[@]}"; do
  if (( COUNTS[$table_name] == 0 )); then
    ZEROED_TABLES+=("$table_name")
  fi
done

if (( COUNTS[User] == 0 )); then
  REASONS+=("User == 0")
fi

if (( COUNTS[Client] == 0 )); then
  REASONS+=("Client == 0")
fi

if (( COUNTS[Client] == 0 && COUNTS[Opportunity] == 0 )); then
  REASONS+=("Client == 0 e Opportunity == 0")
fi

if (( ${#ZEROED_TABLES[@]} >= 2 )); then
  REASONS+=("Múltiplas tabelas críticas zeradas: ${ZEROED_TABLES[*]}")
fi

if [[ "$FORMAT" == "shell" ]]; then
  for table_name in "${TABLES[@]}"; do
    var_name="$(to_var_name "$table_name")"
    printf '%s=%q\n' "$var_name" "${COUNTS[$table_name]}"
  done
  printf 'INCONSISTENT=%q\n' "$([[ ${#REASONS[@]} -gt 0 ]] && echo 1 || echo 0)"
  printf 'ZEROED_TABLES=%q\n' "${ZEROED_TABLES[*]:-}"
  printf 'REASONS=%q\n' "${REASONS[*]:-}"
else
  echo "=== Relatório de saúde do banco (somente leitura) ==="
  for table_name in "${TABLES[@]}"; do
    printf '%-16s %s\n' "${table_name}:" "${COUNTS[$table_name]}"
  done

  if [[ ${#REASONS[@]} -gt 0 ]]; then
    echo
    echo "Status: INCONSISTENTE"
    for reason in "${REASONS[@]}"; do
      echo "- ${reason}"
    done
  else
    echo
    echo "Status: OK"
  fi
fi

if (( STRICT_MODE == 1 && ${#REASONS[@]} > 0 )); then
  exit 1
fi
