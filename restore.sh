#!/bin/bash
set -e
if [ -z "$1" ]; then
  echo "Uso: bash restore.sh /root/backups/ARQUIVO.sql"
  echo ""
  echo "Backups disponíveis:"
  ls -lt /root/backups/*.sql 2>/dev/null || echo "Nenhum backup encontrado."
  exit 1
fi
cd /apps/gest-o
docker compose exec -T db psql -U postgres -d salesforce_pro < $1
echo "Restore concluído!"
