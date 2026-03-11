#!/bin/bash
set -e
docker compose down -v
docker compose up -d --build
echo "Deploy concluído!"
