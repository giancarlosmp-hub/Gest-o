#!/usr/bin/env bash
set -euo pipefail

# PRODUCTION_ENV_DIR existe só para o teste isolado; produção usa /root/demetra-env.
ENV_DIR="${PRODUCTION_ENV_DIR:-/root/demetra-env}"
SOURCE_FILE="${ENV_DIR}/.env"
# Env protegido do projeto WhatsApp (docker-compose.whatsapp.yml): opcional, copiado quando existir.
WHATSAPP_SOURCE_FILE="${ENV_DIR}/whatsapp.env"
BACKUP_DIR="${ENV_DIR}/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/env-${TIMESTAMP}.backup"
WHATSAPP_BACKUP_FILE="${BACKUP_DIR}/whatsapp-env-${TIMESTAMP}.backup"

if [[ ! -f "${SOURCE_FILE}" ]]; then
  echo "Erro: arquivo de ambiente de produção não encontrado em ${SOURCE_FILE}." >&2
  echo "Crie/restaure o arquivo antes de executar o backup. Nenhum valor sensível foi exibido." >&2
  exit 1
fi

if [[ -e "${WHATSAPP_SOURCE_FILE}" || -L "${WHATSAPP_SOURCE_FILE}" ]] && [[ ! -f "${WHATSAPP_SOURCE_FILE}" || -L "${WHATSAPP_SOURCE_FILE}" ]]; then
  echo "Erro: ${WHATSAPP_SOURCE_FILE} existe mas não é um arquivo comum (symlink ou outro tipo). Nenhum backup foi criado." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

install -m 600 "${SOURCE_FILE}" "${BACKUP_FILE}"
chmod 600 "${BACKUP_FILE}"

echo "Backup seguro criado em ${BACKUP_FILE}. Valores sensíveis não foram exibidos."

if [[ -f "${WHATSAPP_SOURCE_FILE}" ]]; then
  install -m 600 "${WHATSAPP_SOURCE_FILE}" "${WHATSAPP_BACKUP_FILE}"
  chmod 600 "${WHATSAPP_BACKUP_FILE}"
  echo "Backup seguro do env do WhatsApp criado em ${WHATSAPP_BACKUP_FILE}. Valores sensíveis não foram exibidos."
else
  echo "Env do WhatsApp ausente em ${WHATSAPP_SOURCE_FILE}: nada a copiar."
fi
