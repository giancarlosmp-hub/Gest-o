#!/bin/bash
set -e
echo "ATENÇÃO: Isso apagará todos os dados do banco!"
read -p "Digite YES para confirmar: " confirm
[ "$confirm" = "YES" ] || exit 1
echo "Fazendo backup de segurança..."
bash /apps/gest-o/backup.sh
docker compose down -v
docker compose up -d --build
echo "Reset concluído!"
