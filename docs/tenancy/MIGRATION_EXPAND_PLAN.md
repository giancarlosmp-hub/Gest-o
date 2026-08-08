# Plano da migration expand — Sprints 1.0B.1 e 1.0B.2

> A 1.0B foi dividida: 1.0B.1 persiste somente o control plane default-only; 1.0B.2 tratará os
> models empresariais após os gates operacionais. Esta PR não aplica migration em produção.

**Estado:** plano futuro; nenhuma migration foi criada, aplicada ou executada nesta Sprint.
**Princípio:** expandir de forma aditiva, reconciliar e somente depois restringir. O tenant default representa exclusivamente a empresa atual; não habilita um segundo tenant.

## Pré-condições e autoridades

ADR 003 aceita; RACI vigente; backup/restore isolado aprovado; inventário do schema regenerado; ambiente PostgreSQL 16 descartável; migration authority da ADR 002; janela, SLO e rollback aprovados. Produção exige procedimento próprio futuro e evidência operacional — Git não prova aplicação.

## Ordem proposta

1. Criar enums/lifecycle e tabelas `Tenant` e `TenantMembership`, índices e uniques do control plane.
2. Criar exatamente um tenant default com ID/slug determinísticos, em transação e idempotente.
3. Criar uma membership ativa por usuário atual; mapear `User.role` para `TenantRole`, manter `User` global e e-mail globalmente único durante a compatibilidade.
4. Adicionar `tenantId` **nullable** por grupos de dependência: raízes/configuração; `Client`/`User`-owned; filhos de Client; `Opportunity` e filhos; agenda/atividades; catálogo/produtos; ERP; Communications; conhecimento/configurações empresariais. Catálogos comprovadamente globais ficam fora mediante revisão.
5. Criar índices temporários para nulos e índices tenant-first de leitura, preferencialmente `CONCURRENTLY` fora de transação quando a ferramenta/procedimento permitir.
6. Backfill pais antes de filhos, em lotes limitados, usando relações já reconciliadas e tenant default; nunca inferir tenant de seller, filial, conta WhatsApp ou conteúdo.
7. Quarentenar órfãos/ambíguos em ledger separado, sem apagá-los nem servi-los ao caminho novo.
8. Reconciliar; somente depois planejar NOT NULL, FKs/uniques compostas e remoção de constraints globais em Sprint constrain posterior.

## Reconciliação e evidência

Por tabela, preservar antes/depois: contagem total, contagem nula, contagem por tenant, PK min/max quando aplicável, hash determinístico de PK→tenant, órfãos, relações cross-tenant e duração/lotes. Duas implementações independentes devem comparar filhos e pais. O gate exige total preservado, hash esperado, zero atribuição divergente e quarentena zero ou formalmente aprovada. Memberships exigem contagem contra usuários ativos/inativos e versões determinísticas.

## Locks, desempenho e disponibilidade

Medir `EXPLAIN (ANALYZE, BUFFERS)` em dados sintéticos representativos; limitar batch, timeout e write amplification; monitorar locks, WAL, replication lag, CPU e storage. DDL que reescreva tabela ou adquira lock prolongado aborta. Não combinar criação de colunas, backfill e constraints pesadas numa única transação operacional. Índices temporários têm owner e remoção somente após prova.

## Backup, restore e rollback

Antes da aplicação futura: backup com checksum e restore em ambiente isolado. Depois: repetir restore e reconciliação tenant-aware. Rollback de código desliga a flag e mantém tabelas/colunas aditivas; rollback de dados usa ledger idempotente, nunca `DROP`. Se houver atribuição errada, parar writes/jobs, colocar linhas em quarentena e reconciliar. Restore de produção é decisão de incidente aprovada, nunca passo automático.

## Gates de progressão

- **Para backfill:** schema expand validado em PostgreSQL descartável, preview revisado e zero DDL destrutivo.
- **Para NOT NULL:** 100% classificado ou quarentena aprovada; zero novos nulos por período acordado; readers/writers compatíveis.
- **Para FK composta:** pai/filho possuem tenant, zero mismatch e índices de suporte testados.
- **Para unique composta:** colisões analisadas; sem remoção antecipada da unique global até todos os consumidores migrarem.
- **Para RLS:** repositories/raw SQL tenant-aware, role runtime sem bypass, pool limpa contexto e testes A×B verdes.
- **Para contract:** duas releases estáveis, restore multi-tenant provado e autorização formal. `DROP`, renome destrutivo e remoção de coluna/constraint são proibidos antes desse gate.

## Entregáveis da 1.0B

Migration aditiva separada, preview, fixtures sintéticas, runner de backfill idempotente/dry-run, ledger, relatório de reconciliação, plano de execução/rollback e testes PostgreSQL descartáveis. Sem segundo tenant funcional e sem alegação multiempresa.

## Decisão executada na 1.0B.2-A

A primeira onda seleciona Client, AgendaEvent, Product, AppConfig, Goal, ActivityKPI, Sale, SellerTerritoryCity, KnowledgeDocument, ErpSyncRun e ErpSyncLock. Todos recebem somente `tenantId` nullable, FK opcional NO ACTION e índice simples. NULL significa registro ainda não migrado; não é globalidade nem fallback. Uniques globais permanecem transitórios. Filhos, backfill, data access e constraints tenant-scoped seguem separados nas subfases posteriores.
