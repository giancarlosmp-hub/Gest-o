#!/bin/bash
set -e
echo "Iniciando deploy..."
git pull origin main
docker compose down
docker compose up -d --build
echo "Aguardando sistema inicializar..."
sleep 20
docker compose ps
curl -s http://127.0.0.1:4000/health
echo "Deploy concluído!"
