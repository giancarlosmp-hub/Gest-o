#!/usr/bin/env bash
set -e

DOMAIN="crm.demetraagronegocios.com.br"
UPSTREAM="http://127.0.0.1:5173"
NGINX_SITE_PATH="/etc/nginx/sites-available/crm"
NGINX_ENABLED_PATH="/etc/nginx/sites-enabled/crm"
NGINX_DEFAULT_ENABLED="/etc/nginx/sites-enabled/default"

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

echo "[1/6] Verificando nginx..."
if ! command -v nginx >/dev/null 2>&1; then
  echo "Nginx não encontrado. Instalando..."
  $SUDO apt-get update
  $SUDO apt-get install -y nginx
else
  echo "Nginx já está instalado."
fi

echo "[2/6] Criando configuração do site CRM em ${NGINX_SITE_PATH}..."
$SUDO tee "$NGINX_SITE_PATH" >/dev/null <<NGINX_CONF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass ${UPSTREAM};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX_CONF

echo "[3/6] Habilitando site CRM..."
$SUDO ln -sfn "$NGINX_SITE_PATH" "$NGINX_ENABLED_PATH"

echo "[4/6] Removendo site default, se existir..."
if [ -e "$NGINX_DEFAULT_ENABLED" ]; then
  $SUDO rm -f "$NGINX_DEFAULT_ENABLED"
  echo "Site default removido."
else
  echo "Site default já estava ausente."
fi

echo "[5/6] Validando configuração do nginx..."
$SUDO nginx -t

echo "[6/6] Reiniciando nginx..."
$SUDO systemctl restart nginx

echo "Configuração concluída com sucesso para ${DOMAIN}."
