#!/bin/bash
set -e
echo "ATENÇÃO: Isso apagará todos os dados!"
read -p "Confirmar? (yes/no): " confirm
if [ "$confirm" = "yes" ]; then
  docker compose down -v
  docker compose up -d --build
  echo "Reset concluído!"
fi
