#!/usr/bin/env bash
set -euo pipefail

SOURCE_FILE="/root/demetra-env/.env"
BACKUP_DIR="/root/demetra-env/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/env-${TIMESTAMP}.backup"

if [[ ! -f "${SOURCE_FILE}" ]]; then
  echo "Erro: arquivo de ambiente de produção não encontrado em ${SOURCE_FILE}." >&2
  echo "Crie/restaure o arquivo antes de executar o backup. Nenhum valor sensível foi exibido." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

install -m 600 "${SOURCE_FILE}" "${BACKUP_FILE}"
chmod 600 "${BACKUP_FILE}"

echo "Backup seguro criado em ${BACKUP_FILE}. Valores sensíveis não foram exibidos."
