#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/apps/gest-o}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
BUILD_SERVICES="${BUILD_SERVICES:-api web}"
START_SERVICES="${START_SERVICES:-api web}"
PRODUCTION_ENV_FILE="${PRODUCTION_ENV_FILE:-/root/demetra-env/.env}"

log() {
  printf '[deploy-production] %s\n' "$*"
}

load_production_env() {
  if [[ -f "${PRODUCTION_ENV_FILE}" ]]; then
    log "Carregando variáveis sensíveis de produção de ${PRODUCTION_ENV_FILE} (valores não serão exibidos)"
    set -a
    # shellcheck disable=SC1090
    source "${PRODUCTION_ENV_FILE}"
    set +a
    return
  fi

  log "Aviso: ${PRODUCTION_ENV_FILE} não encontrado; Compose usará variáveis já exportadas ou fallbacks seguros. Envios ERP reais continuarão bloqueados se faltar configuração crítica."
}

log "Iniciando deploy seguro em produção"
log "Data/Hora (UTC): $(date -u '+%Y-%m-%d %H:%M:%S')"
log "Diretório da aplicação: ${APP_DIR}"
log "Branch de deploy: ${DEPLOY_BRANCH}"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  log "ERRO: diretório de produção não encontrado ou não é um repositório Git: ${APP_DIR}"
  exit 1
fi

cd "${APP_DIR}"

if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code; then
  log "ERRO: existem alterações locais rastreadas não commitadas em ${APP_DIR}."
  log "Para segurança, o deploy automático não usa git reset --hard nem sobrescreve arquivos locais."
  git status --short
  exit 1
fi

log "Commit local antes do deploy: $(git rev-parse --short HEAD)"
log "Sincronizando origin/${DEPLOY_BRANCH} com fast-forward obrigatório"

git fetch origin "${DEPLOY_BRANCH}"
git checkout "${DEPLOY_BRANCH}"
git pull --ff-only origin "${DEPLOY_BRANCH}"

log "Commit local após sincronização: $(git rev-parse --short HEAD)"
log "Branch local ativa: $(git branch --show-current)"
log "Status Git após sincronização"
git status --short --branch
load_production_env
log "Validando docker compose config"
docker compose config >/dev/null
log "Reconstruindo imagens Docker: ${BUILD_SERVICES}"
# shellcheck disable=SC2086
docker compose build ${BUILD_SERVICES}

log "Subindo containers atualizados: ${START_SERVICES}"
# shellcheck disable=SC2086
docker compose up -d ${START_SERVICES}

log "Status dos containers após deploy"
docker compose ps
log "IDs das imagens em uso pelos containers atualizados"
# shellcheck disable=SC2086
docker compose images ${START_SERVICES} || true

log "Deploy concluído com segurança"
