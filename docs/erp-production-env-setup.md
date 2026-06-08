# Ambiente sensível de produção do ERP UltraFV3

Este projeto deve carregar as variáveis sensíveis de produção a partir de um arquivo fora do diretório versionado:

```text
/root/demetra-env/.env
```

Esse arquivo é a fonte recomendada para produção do CRM Demetra Agro Performance em `/apps/gest-o`. Não coloque credenciais reais em GitHub, issues, pull requests, chats ou documentos compartilhados.

## Variáveis obrigatórias

O arquivo `/root/demetra-env/.env` deve conter, no mínimo:

```dotenv
ULTRAFV3_BASE_URL=https://servidor-ou-ip-do-ultrafv3
ERP_CREDENTIAL_ENCRYPTION_KEY=troque-por-uma-chave-forte
JWT_SECRET=troque-por-um-segredo-forte
DATABASE_URL=postgresql://usuario:senha@host:5432/banco?schema=public
```

Variáveis opcionais/globais para autenticação UltraFV3:

```dotenv
ULTRAFV3_USERNAME=usuario-global-opcional
ULTRAFV3_PASSWORD=senha-global-opcional
```

Se `ULTRAFV3_USERNAME`/`ULTRAFV3_PASSWORD` não forem usados, mantenha as credenciais por vendedor configuradas no painel do CRM. Nunca copie valores reais para GitHub, chat ou PR.

## Criar diretório e arquivo em produção

No servidor, execute como `root`:

```bash
mkdir -p /root/demetra-env/backups
chmod 700 /root/demetra-env /root/demetra-env/backups
nano /root/demetra-env/.env
chmod 600 /root/demetra-env/.env
```

O `docker-compose.yml` carrega `./.env` quando existir para desenvolvimento local e também `/root/demetra-env/.env` para produção. O arquivo externo fica fora de `/apps/gest-o`, portanto não é sobrescrito por `git pull`, `merge`, `checkout`, `reset`, `stash` ou deploy do projeto.

## Copiar ou restaurar o arquivo

Para copiar um `.env` seguro de outro local para produção:

```bash
install -m 600 /caminho/seguro/.env /root/demetra-env/.env
chmod 600 /root/demetra-env/.env
```

Para criar backup manual antes de qualquer alteração:

```bash
/apps/gest-o/scripts/backup-production-env.sh
```

Para restaurar a partir de um backup:

```bash
/apps/gest-o/scripts/restore-production-env.sh /root/demetra-env/backups/env-YYYYMMDD-HHMMSS.backup
```

O script de restauração faz backup do `.env` atual antes de sobrescrever.

## Backup automático diário

Exemplo de cron para backup diário às 02:30:

```cron
30 2 * * * /apps/gest-o/scripts/backup-production-env.sh >> /var/log/demetra-env-backup.log 2>&1
```

Os scripts não imprimem valores sensíveis. Os backups são gravados em `/root/demetra-env/backups` com permissão `600`.

## Subir containers após alteração

Após editar `/root/demetra-env/.env`, recrie/reinicie a API para receber o novo ambiente:

```bash
cd /apps/gest-o
docker compose up -d --build api web
```

Se também alterou banco/serviços compartilhados, suba tudo:

```bash
cd /apps/gest-o
docker compose up -d --build
```

## Diagnóstico no painel

Em **Configurações > Integração ERP**, o painel mostra apenas `presente`/`ausente` para:

- arquivo externo `/root/demetra-env/.env`;
- `ULTRAFV3_BASE_URL`;
- `ERP_CREDENTIAL_ENCRYPTION_KEY`;
- `JWT_SECRET`;
- `DATABASE_URL`.

Valores reais nunca são exibidos. Em produção, se `ULTRAFV3_BASE_URL` ou `ERP_CREDENTIAL_ENCRYPTION_KEY` estiverem ausentes, a API continua podendo subir, mas o envio real de pedidos ERP fica bloqueado com erro estruturado contendo `correlationId` e `missingConfig`.
