## Contrato de preparação do backup para Recovery (13/08/2026)

O build produtivo do SHA `376c84eed4cfa2ba79e2383e41e6e0d2fb4b5ba0` passou no run 31742404113. O Recovery do run 31743043943 avançou após a correção da PR #804, mas o preflight bloqueou fail-closed em `backup_stale`; o rollback terminou antes de qualquer alteração persistente. Portanto, presença, integridade e freshness de um backup novo continuam pendentes e a sincronização automática permanece `NOT_PROVEN`.

O workflow manual **Prepare Production Recovery Backup** usa o environment protegido dedicado `production-backup-recovery` (secrets de conexão `SSH_HOST`/`VPS_HOST`, `SSH_USER`/`VPS_USER`, `SSH_KEY`/`VPS_KEY` e opcional `SSH_PORT`/`VPS_PORT`). Ele exige confirmação literal e SHA completo da `main`, prepara apenas o par backup/manifesto SHA-256, preserva o par anterior, executa o preflight cutover somente read-only e não executa deploy, cutover ou Recovery. Aprovação humana deve ser configurada nesse environment. O **ERP Production Recovery deve ser disparado separadamente**, somente depois de evidência recente e íntegra. Nesta mudança, produção e backup real não foram acessados.

Estados: `PRODUCTION_BACKUP_PREPARATION=NOT_EXECUTED`; `PRODUCTION_BACKUP_PRESENCE=NOT_PROVEN_ON_NEW_RUN`; `PRODUCTION_BACKUP_INTEGRITY=NOT_PROVEN_ON_NEW_RUN`; `PRODUCTION_BACKUP_FRESHNESS=NOT_PROVEN_ON_NEW_RUN`; `ERP_PRODUCTION_RECOVERY_WORKFLOW=FAILED_PRE_COMMIT_BACKUP_STALE`; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`; `INC_ERP_5050=INVESTIGATING`.

# Backup operacional (Gest-o)

O script `backup.sh` gera backups do PostgreSQL em formato **`.sql.gz`** com validação defensiva de conteúdo.

## O que o script valida antes de aceitar backup

Antes de considerar o backup válido, o script consulta contagens reais no banco (`db` do `docker compose`) e aplica regras:

1. `User` **não pode** estar zerada.
2. `Client`, `Opportunity` e `TimelineEvent` **não podem** estar todas zeradas ao mesmo tempo.
3. O dump SQL precisa ter tamanho mínimo (`MIN_SIZE_BYTES`, padrão 50 KB).

Se qualquer regra falhar:

- o backup é rejeitado;
- o arquivo inválido é removido automaticamente;
- o motivo da rejeição é registrado no log com timestamp.

## Logs

Arquivo de log padrão:

- `/root/backups/backup.log`

O log inclui:

- contagens usadas na validação (`User`, `Client`, `Opportunity`, `TimelineEvent`);
- motivo objetivo da rejeição;
- nome do arquivo rejeitado/removido;
- sucesso de criação e rotação dos backups válidos.

## Rotação

A rotação mantém os **48 backups válidos mais recentes** (`*.sql.gz`).

Importante:

- a rotação roda somente após um backup válido ser finalizado;
- um backup inválido **não** dispara limpeza que possa afetar backups bons recentes.

## Execução manual

```bash
./backup.sh
```

Pré-requisitos esperados no ambiente da VPS:

- `docker compose` funcional;
- serviço `db` ativo;
- acesso ao banco `salesforce_pro` com usuário `postgres` dentro do container.
