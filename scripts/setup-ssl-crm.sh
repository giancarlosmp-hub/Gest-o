#!/usr/bin/env bash
set -e

DOMAIN="crm.demetraagronegocios.com.br"

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "[ERRO] Execute como root ou instale sudo."
    exit 1
  fi
else
  SUDO=""
fi

echo "[1/2] Verificando certbot e plugin nginx..."
if ! dpkg -s certbot python3-certbot-nginx >/dev/null 2>&1; then
  echo "Dependências não encontradas. Instalando..."
  $SUDO apt-get update
  $SUDO apt-get install -y certbot python3-certbot-nginx
else
  echo "Certbot e plugin nginx já estão instalados."
fi

echo "[2/2] Emitindo/renovando certificado para ${DOMAIN}..."
$SUDO certbot --nginx -d "$DOMAIN"

echo "Configuração SSL concluída para ${DOMAIN}."
