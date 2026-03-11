#!/bin/bash
set -e
echo "Iniciando deploy..."
docker compose down
docker compose up -d --build
echo "Aguardando containers..."
sleep 15
docker compose ps
echo "Deploy concluído!"
