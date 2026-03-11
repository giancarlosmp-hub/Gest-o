#!/bin/bash
set -e
echo "Iniciando deploy..."
docker compose down
docker compose up -d --build
echo "Aguardando containers ficarem saudáveis..."
sleep 30
docker compose ps
echo "Deploy concluído!"
