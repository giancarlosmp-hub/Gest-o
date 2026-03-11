#!/bin/bash
set -e
echo "ATENÇÃO: Todos os dados serão apagados!"
read -p "Digite YES para confirmar: " confirm
[ "$confirm" = "YES" ] || exit 1
docker compose down -v
docker compose up -d --build
echo "Reset concluído!"
