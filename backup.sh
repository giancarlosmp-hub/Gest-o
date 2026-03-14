#!/bin/bash
set -e
BACKUP_DIR="/root/backups"
mkdir -p $BACKUP_DIR
FILENAME="$BACKUP_DIR/salesforce_pro_$(date +%Y%m%d_%H%M%S).sql"
cd /apps/gest-o
docker compose exec -T db pg_dump -U postgres salesforce_pro > $FILENAME
echo "Backup criado: $FILENAME"
ls -t $BACKUP_DIR/*.sql | tail -n +49 | xargs rm -f 2>/dev/null
echo "Concluído. Backups mantidos: $(ls /root/backups/*.sql | wc -l)"
