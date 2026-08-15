#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "" ]]; then
  echo "Uso: $0 <PR_NUMBER> [PREVIEW_BASE_DIR]"
  echo "Exemplo: $0 123 /var/www/preview"
  exit 1
fi

PR_NUMBER="$1"
PREVIEW_BASE_DIR="${2:-/var/www/preview}"
PREVIEW_DIR="${PREVIEW_BASE_DIR}/pr-${PR_NUMBER}"

if [[ ! -d "$PREVIEW_DIR" ]]; then
  echo "[ERRO][ambiente] diretório não encontrado: $PREVIEW_DIR"
  exit 1
fi

cd "$PREVIEW_DIR"

if [[ ! -f .env ]]; then
  echo "[ERRO][ambiente] arquivo .env não encontrado em $PREVIEW_DIR"
  exit 1
fi

set -a
source ./.env
set +a

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-gesto-pr-${PR_NUMBER}}"
POSTGRES_DB="${POSTGRES_DB:-salesforce_pro_preview_pr_${PR_NUMBER}}"
POSTGRES_VOLUME_NAME="${POSTGRES_VOLUME_NAME:-gest-o_pgdata_pr_${PR_NUMBER}}"
ADMIN_BOOTSTRAP_EMAIL="${ADMIN_BOOTSTRAP_EMAIL:-admin+pr${PR_NUMBER}@preview.local}"
ADMIN_BOOTSTRAP_PASSWORD="${ADMIN_BOOTSTRAP_PASSWORD:-PreviewPr${PR_NUMBER}!123}"
API_PORT="${API_PORT:-40${PR_NUMBER}}"

COMPOSE_CMD=(docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.yml -f docker-compose.preview.yml)

FAILED=0

run_check() {
  local label="$1"
  local category="$2"
  shift 2

  echo
  echo "=== ${label} ==="
  if "$@"; then
    echo "[OK][${category}] ${label}"
  else
    echo "[FALHA][${category}] ${label}"
    FAILED=1
  fi
}

run_check "Subir preview isolado" "ambiente" "${COMPOSE_CMD[@]}" up -d --build

run_check "DATABASE_URL efetiva (container api)" "ambiente" \
  "${COMPOSE_CMD[@]}" exec -T api node -e 'const u=process.env.DATABASE_URL||""; const m=u.match(/postgres(?:ql)?:\/\/([^@]+@)?([^:/?#]+)(?::(\d+))?\/([^?]+)/i); console.log(JSON.stringify({hasDatabaseUrl:Boolean(u),host:m?.[2]??null,port:m?.[3]??null,database:m?.[4]??null},null,2)); if(!u) process.exit(1);'

run_check "Nome do banco configurado no preview" "ambiente" \
  bash -lc "echo \"POSTGRES_DB=${POSTGRES_DB}\" && [[ \"${POSTGRES_DB}\" == \"salesforce_pro_preview_pr_${PR_NUMBER}\" ]]"

run_check "Volume isolado do PR" "ambiente" \
  bash -lc "docker volume inspect '${POSTGRES_VOLUME_NAME}' >/dev/null && echo 'POSTGRES_VOLUME_NAME=${POSTGRES_VOLUME_NAME}'"

run_check "Admin técnico existe no banco" "dado/hash" \
  "${COMPOSE_CMD[@]}" exec -T db psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB}" -c "SELECT id, email, role, \"isActive\" FROM \"User\" WHERE email='${ADMIN_BOOTSTRAP_EMAIL}';"

run_check "Diagnóstico do hash do admin técnico" "dado/hash" \
  "${COMPOSE_CMD[@]}" exec -T api env ADMIN_DIAG_EMAIL="${ADMIN_BOOTSTRAP_EMAIL}" ADMIN_DIAG_PASSWORD="${ADMIN_BOOTSTRAP_PASSWORD}" npm run admin:diagnose-hash -w @salesforce-pro/api

run_check "Login HTTP real (/auth/login)" "fluxo de autenticação" \
  bash -lc "curl -sS -i -X POST 'http://127.0.0.1:${API_PORT}/auth/login' -H 'Content-Type: application/json' --data '{\"email\":\"${ADMIN_BOOTSTRAP_EMAIL}\",\"password\":\"${ADMIN_BOOTSTRAP_PASSWORD}\"}' | tee /tmp/preview-login-pr-${PR_NUMBER}.txt && grep -q 'HTTP/1.1 200' /tmp/preview-login-pr-${PR_NUMBER}.txt"

if [[ "$FAILED" -eq 0 ]]; then
  echo
  echo "RESULTADO FINAL: SUCESSO"
  echo "Classificação: ambiente=OK, dado/hash=OK, fluxo de autenticação=OK"
  exit 0
fi

echo
cat <<'SUMMARY'
RESULTADO FINAL: FALHA (ver passos acima)
Classificação sugerida:
- [ambiente] falha de compose/container/rede/porta
- [dado/hash] usuário inexistente, hash inválido, senha não confere
- [fluxo de autenticação] endpoint responde diferente do esperado no login HTTP
SUMMARY
exit 1
