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
