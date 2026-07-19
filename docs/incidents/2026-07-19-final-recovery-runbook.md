# Runbook — resultado final da recuperação do incidente 2026-07-19

Este documento registra artefatos auditáveis e procedimentos posteriores. Ele não afirma execução a partir do ambiente Codex; a recuperação descrita abaixo foi validada manualmente em banco isolado e depois em produção.

## Guardrails permanentes

- Não executar `seed`, reset de senha, `db reset`, `DROP`, `TRUNCATE`, `docker system prune`, remoção de volumes ou remoção de backups durante atividades de recuperação.
- Scripts desta PR são DRY_RUN/read-only por padrão ou exigem `apply_recovery=true` explícito.
- Não criar produtos históricos artificiais para os 273 `ProductPrice` órfãos.
- Não mesclar, renomear ou reconciliar automaticamente os 73 clientes históricos genéricos restantes.
- Preservar evidências, IDs antigos, tabelas de auditoria e dumps do incidente.

## Estado final validado

- `Product`: 531.
- `ProductPrice` válidos: 596.
- `ProductPrice` órfãos: 0.
- `OpportunityItem` órfãos: 0.
- `Opportunity` órfãs em relação a `Client`: 0.
- Login, clientes, oportunidades, equipe, cliente histórico e contatos retornaram HTTP 200 nos smokes manuais.

## Resultado real dos 273 ProductPrice órfãos

Todos os 273 órfãos tinham evidência segura para limpeza, não para recriação de produtos:

- `price = 0` em todos.
- `validFrom = null` em todos.
- 267 sem `erpPriceId`.
- 6 com `erpPriceId = '1'` genérico.
- O backup de junho não possui tabela `Product` nem caches ERP de produtos/preços.

Antes da remoção, cada linha foi preservada integralmente como JSONB em:

```sql
public.incident_20260719_orphan_productprice_audit
```

Depois da preservação auditável, somente esses `ProductPrice` cujo `Product` não existia foram removidos. Nenhum `Product` histórico artificial foi criado.

## Automação segura de ProductPrice

1. Classificar em modo read-only:

   ```bash
   psql "$DATABASE_URL" -v expected_orphan_rows=273 -v fail_on_expected_mismatch=true -f scripts/recovery/classify-20260719-productprice-orphans.sql
   ```

2. Rodar DRY_RUN da limpeza auditável:

   ```bash
   psql "$DATABASE_URL" -v apply_recovery=false -v expected_orphan_rows=273 -f scripts/recovery/apply-20260719-productprice-recovery.sql
   ```

3. Aplicar somente se ainda houver exatamente os 273 órfãos com `price=0`, `validFrom=null` e `erpPriceId` nulo ou `'1'`:

   ```bash
   psql "$DATABASE_URL" -v apply_recovery=true -v expected_orphan_rows=273 -f scripts/recovery/apply-20260719-productprice-recovery.sql
   ```

4. Se a recuperação já estiver concluída (`ProductPrice` órfãos = 0), o script detecta o estado final e não altera nada.

## Rollback de ProductPrice pela auditoria

Preferir rollback por dump quando o objetivo for retornar a um ponto anterior completo. Para rollback cirúrgico dos 273 `ProductPrice`, usar `previous_data` preservado em `public.incident_20260719_orphan_productprice_audit` em banco isolado primeiro.

Exemplo operacional para revisão humana antes de qualquer aplicação:

```sql
SELECT product_price_id, orphan_product_id, previous_data
FROM public.incident_20260719_orphan_productprice_audit
ORDER BY product_price_id;
```

Um rollback cirúrgico deve reconstruir explicitamente as colunas de `ProductPrice` a partir de `previous_data`, dentro de transação, validando contagem esperada e abortando se qualquer `product_price_id` já existir. Não usar JSONB sem revisar tipos/colunas.

## 73 clientes históricos genéricos

Estado final validado:

- `exact_safe`: 0.
- `probable_review`: 73.
- Pedidos ERP: 0.
- Códigos ERP comprovados: 0.

Eles permanecem arquivados e legíveis. A leitura de clientes históricos arquivados já funciona pela PR #725. O relatório desta PR usa somente:

- `isArchived=true`;
- `archiveReason='INCIDENT_20260718_MISSING_PARENT_RESTORED'`;
- `name LIKE '[RECUPERADO]%'`;
- referências reais por `Opportunity`, `Activity`, `AgendaEvent`, `AgendaStop`, `Contact` ou `TimelineEvent`.

Executar relatório:

```bash
psql "$DATABASE_URL" -v expected_generic_clients=73 -v fail_on_expected_mismatch=true -f scripts/recovery/report-20260719-generic-historical-clients.sql
```

Não usar título genérico, cultura, cidade ou nome parcial como evidência automática.

## FKs restauradas e validadas

As seis FKs restauradas/validadas são:

| Relação | ON DELETE | ON UPDATE |
| --- | --- | --- |
| `Activity.clientId` | `SET NULL` | `CASCADE` |
| `AgendaStop.clientId` | `SET NULL` | `CASCADE` |
| `Opportunity.clientId` | `RESTRICT` | `CASCADE` |
| `OpportunityItem.productId` | `SET NULL` | `CASCADE` |
| `ProductPrice.productId` | `CASCADE` | `CASCADE` |
| `TimelineEvent.clientId` | `SET NULL` | `CASCADE` |

Diagnóstico read-only:

```bash
psql "$DATABASE_URL" -f scripts/recovery/diagnose-20260719-prisma-foreign-keys.sql
```

Não adicionar/validar constraints enquanto houver órfãos. Não usar `prisma db push` destrutivo.

## Backups relevantes

- `immediate-production-before-productprice-cleanup-20260719.dump`
  - SHA256: `67e2117ae49e71e8d292ee356d812b139adbafc801c12753d0c410017fd9cbd8`
- `after-productprice-cleanup-20260719.dump`
  - SHA256: `f709a96e377677947f6012b7a13f0863d1db7e0e79e79ef859bbdce7f7779fb2`
- `immediate-before-fk-restoration-20260719.dump`
  - SHA256: `0fc0b7d0e85212c47832dbf514ee6dbd40c5da1153cb605bf232db7cd3040560`
- `after-fk-restoration-20260719.dump`
  - SHA256: `70443192efee01e9742faf107b7b49831f2f4ab1b8a5e460ebd8dfeab0a76ad9`

## Rollback por backup

1. Não remover volumes.
2. Fazer backup do estado atual antes de qualquer rollback.
3. Restaurar o dump apropriado em banco isolado primeiro.
4. Validar contagens, FKs e smokes.
5. Só então planejar janela operacional para produção.

## Segurança pós-incidente e hardening futuro

Houve evidência de banco `readme_to_recover` e role superuser `priv_esc` no volume atacado. Preservar evidências e backups.

Recomenda-se uma PR futura exclusiva para hardening operacional do Docker Compose/PostgreSQL, sem misturar com recuperação de dados, para tratar:

- remoção de exposição externa do PostgreSQL;
- revisão de `pg_hba.conf`, portas Docker e firewall;
- remoção de `trust` para conexões externas;
- migração planejada para SCRAM/senhas fortes;
- rotação de segredos fora do Git;
- políticas de restart e variáveis de ambiente testadas na VPS.
