#!/bin/bash
set -e

echo "Iniciando deploy..."
docker compose down -v
docker compose up -d --build

echo "Aguardando API ficar saudável..."
sleep 30
docker compose ps

echo "Deploy concluído!"
