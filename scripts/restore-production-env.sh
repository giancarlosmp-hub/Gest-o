#!/usr/bin/env bash
set -euo pipefail

SOURCE_FILE="/root/demetra-env/.env"
ENV_DIR="/root/demetra-env"
BACKUP_DIR="/root/demetra-env/backups"
BACKUP_TO_RESTORE="${1:-}"

if [[ -z "${BACKUP_TO_RESTORE}" ]]; then
  echo "Uso: $0 /caminho/para/env-YYYYMMDD-HHMMSS.backup" >&2
  exit 2
fi

if [[ ! -f "${BACKUP_TO_RESTORE}" ]]; then
  echo "Erro: backup informado não existe: ${BACKUP_TO_RESTORE}." >&2
  exit 1
fi

mkdir -p "${ENV_DIR}" "${BACKUP_DIR}"
chmod 700 "${ENV_DIR}" "${BACKUP_DIR}"

if [[ -f "${SOURCE_FILE}" ]]; then
  TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
  PRE_RESTORE_BACKUP="${BACKUP_DIR}/env-before-restore-${TIMESTAMP}.backup"
  install -m 600 "${SOURCE_FILE}" "${PRE_RESTORE_BACKUP}"
  chmod 600 "${PRE_RESTORE_BACKUP}"
  echo "Backup do .env atual criado em ${PRE_RESTORE_BACKUP}. Valores sensíveis não foram exibidos."
else
  echo "Aviso: ${SOURCE_FILE} não existia antes da restauração. Nenhum backup pré-restauração foi criado." >&2
fi

install -m 600 "${BACKUP_TO_RESTORE}" "${SOURCE_FILE}"
chmod 600 "${SOURCE_FILE}"

echo "Arquivo de ambiente restaurado em ${SOURCE_FILE}. Valores sensíveis não foram exibidos."
