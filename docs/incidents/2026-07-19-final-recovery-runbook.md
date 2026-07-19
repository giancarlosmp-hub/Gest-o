# Runbook — finalização segura da recuperação do incidente 2026-07-19

Este runbook prepara execução posterior na VPS. Ele não deve ser interpretado como confirmação de execução em produção.

## Guardrails obrigatórios

- Não executar `seed`, reset de senha, `db reset`, `DROP`, `TRUNCATE`, `DELETE`, `docker system prune`, remoção de volumes ou remoção de backups.
- Testar a recuperação dos 273 `ProductPrice` órfãos primeiro em banco isolado restaurado de backup.
- O modo padrão dos scripts é read-only/DRY_RUN.
- Alterações exigem `APPLY_RECOVERY=true`, `psql -v apply_recovery=true` e `app.apply_recovery=true` na sessão.
- Manter produtos históricos sem destino como `isActive=false` e `isSuspended=true`.
- Preservar IDs antigos, tabelas de auditoria e backups do incidente.

## Banco/containers confirmados no incidente

- Container de banco recuperado: `gest-o-db-clean-v2-20260717`.
- Database: `salesforce_pro`.
- API temporária: `gest-o-api-recovery-20260718`.
- Web: `gest-o-web-1`.
- Rede: `gest-o_default`.
- A API deve ter alias de rede `api` para o upstream do web.
- Manter `ERP_SYNC_SCHEDULER_ENABLED=false` durante a recuperação.

## Fluxo recomendado

1. Restaurar o dump em banco isolado e conferir SHA256 fora do Git.
2. Executar classificação read-only:

   ```bash
   psql "$ISOLATED_DATABASE_URL" -v expected_orphan_rows=273 -v fail_on_expected_mismatch=true -v june_product_table=public.incident_20260719_june_product_source -f scripts/recovery/classify-20260719-productprice-orphans.sql
   ```

3. Executar DRY_RUN da automação:

   ```bash
   psql "$ISOLATED_DATABASE_URL" -v apply_recovery=false -v expected_orphan_rows=273 -v expected_remaining_orphans=0 -v june_product_table=public.incident_20260719_june_product_source -f scripts/recovery/apply-20260719-productprice-recovery.sql
   ```

4. Só depois, aplicar no banco isolado com as duas travas explícitas:

   ```bash
   APPLY_RECOVERY=true PGOPTIONS='-c app.apply_recovery=true' psql "$ISOLATED_DATABASE_URL" -v apply_recovery=true -v expected_orphan_rows=273 -v expected_remaining_orphans=0 -v june_product_table=public.incident_20260719_june_product_source -f scripts/recovery/apply-20260719-productprice-recovery.sql
   ```

5. Validar que `ProductPrice` órfãos = 0. Não propor constraints antes disso.
6. Repetir em produção somente após backup novo e aprovação humana.

## Diagnóstico dos 73 clientes genéricos

Use apenas relatório read-only. Não criar correspondência automática para títulos genéricos, culturas ou nomes prováveis.

```bash
psql "$DATABASE_URL" -v expected_generic_clients=73 -f scripts/recovery/report-20260719-generic-historical-clients.sql
```

Classificações:

- `exact_safe`: requer evidência externa única antes de qualquer alteração futura.
- `probable_review`: somente revisão humana.
- `none`: manter arquivado.

## Constraints Prisma

1. Diagnosticar FKs esperadas e órfãos:

   ```bash
   psql "$DATABASE_URL" -f scripts/recovery/diagnose-20260719-prisma-foreign-keys.sql
   ```

2. Adicionar constraints ausentes como `NOT VALID` somente quando órfãos da relação forem 0.
3. Validar uma constraint por vez com `ALTER TABLE ... VALIDATE CONSTRAINT ...`.
4. Não usar `prisma db push` destrutivo durante a recuperação.

## Deploy Docker Compose permanente

- Produção deve definir `POSTGRES_VOLUME_NAME` para o volume recuperado, preservando o volume original.
- `DATABASE_URL` não deve conter o sufixo malformado `schema=public}`.
- `ERP_SYNC_SCHEDULER_ENABLED=false` até o encerramento formal da recuperação.
- O serviço `api` mantém alias de rede `api`.
- Produção usa políticas de restart configuráveis; preview usa `restart: "no"` no override.

Exemplo de variáveis sem segredos reais:

```bash
export POSTGRES_VOLUME_NAME=gest-o_pgdata_recovered_20260717
export POSTGRES_DB=salesforce_pro
export ERP_SYNC_SCHEDULER_ENABLED=false
export API_RESTART_POLICY=always
export WEB_RESTART_POLICY=always
export DB_RESTART_POLICY=always
```

### Rollback

1. Não remover volumes.
2. Parar a stack sem `-v`.
3. Reapontar `POSTGRES_VOLUME_NAME` para o volume anterior preservado.
4. Subir a stack e validar `/health` da API e `/healthz` do web.
5. Registrar SHA256 dos dumps usados no rollback.

## Segurança pós-incidente PostgreSQL

- Remover exposição externa da porta 5432; não publicar `ports` para o serviço `db`.
- Nunca usar `trust` para conexões externas; preferir SCRAM e senhas fortes fora do Git.
- Revisar `pg_hba.conf`, portas Docker, regras de firewall/security group e túneis SSH.
- Investigar e preservar evidências relacionadas a banco `readme_to_recover` e role superuser `priv_esc` no volume atacado.
- Rotacionar senhas e segredos somente com procedimento explícito, janela acordada e armazenamento em cofre/ambiente seguro, nunca no repositório.
- Não executar limpeza automática de evidências ou backups.

## Smokes pós-aplicação

- Typecheck API.
- Login.
- Leitura de cliente arquivado.
- Oportunidades.
- Product/OpportunityItem/ProductPrice.
- Bootstrap da sequência ERP.
- Docker Compose smoke.
- Validação negativa: o script deve abortar quando `expected_orphan_rows` divergir.
