# Tenant Data Readiness Preflight

## Contrato e limite

`1.0B.2-L/v1` é um diagnóstico injetável, estritamente read-only, determinístico e fail-closed. Ele avalia se o control plane e os 11 roots estão tecnicamente legíveis para **planejar** um backfill futuro. Não importa o singleton Prisma, não recebe tenant por header/query/body e não contém DML, migration, endpoint ou integração ao runtime. `READY` não autoriza backfill, produção, tenant-aware runtime ou cutover. Um resultado sintético nunca descreve produção; isso exigiria execução formal autorizada.

A interface fornece snapshots mínimos de tenants, users, memberships e roots. Nenhuma seleção posicional (`memberships[0]`) existe: memberships são agrupadas por `userId`, e cardinalidade maior que um é ambígua. A execução concorrente mantém todo o estado no escopo da chamada.

## Inventário real

O control plane contém `Tenant`, `TenantMembership` e `User` ativo/inativo. Os roots fechados são: `Client`, `AgendaEvent`, `Product`, `AppConfig`, `Goal`, `ActivityKPI`, `Sale`, `SellerTerritoryCity`, `KnowledgeDocument`, `ErpSyncRun` e `ErpSyncLock`. Ownership derivável usa relações de usuário/membership e, quando presente, pai root: Client para AgendaEvent; seller para Client/AgendaEvent/Goal/ActivityKPI/Sale/SellerTerritoryCity; createdBy para KnowledgeDocument. Product, AppConfig, ErpSyncRun e ErpSyncLock não devem ter ownership inferido de conteúdo, filial, ERP ou payload.

Permanecem uniques globais transitórias: `User.email`, `Tenant.slug`, `AppConfig.key`, `Product(erpProductCode, erpProductClassCode)`, `Goal(sellerId,month)`, `ActivityKPI(sellerId,month,type)` e `SellerTerritoryCity(sellerId,state,city)`, além das PKs globais. O preflight apenas inventaria; não remove nem converte constraints.

## Relatório sanitizado

Cada root informa total, `tenantId` preenchido/NULL, tenants distintos, ownership divergente, órfãos, cross-tenant, SHA-256 das PKs ordenadas e `READY`, `BLOCKED` ou `QUARANTINE_REQUIRED`. `tenantId NULL` é pendência de backfill: nunca acesso global e nunca correção automática. O agregado é uma única linha `TENANT_DATA_READINESS_PREFLIGHT=<JSON>` com versão, roots avaliados, contagens técnicas, hashes, blockers por código, quarentena, resultado e duração.

Não são emitidos IDs de origem, nomes, e-mails, documentos, tokens, credenciais, connection strings, valores empresariais ou payloads. Os hashes são evidência técnica de cardinalidade/ordem, não pseudonimização autorizando divulgação de PII.

## Blockers fail-closed

| Código | Significado |
|---|---|
| `UNKNOWN_TENANT` | control plane vazio/desconhecido |
| `AMBIGUOUS_MEMBERSHIP` | usuário com mais de uma membership |
| `MEMBERSHIP_TENANT_INACTIVE` / `MEMBERSHIP_TENANT_MISSING` | membership aponta a tenant suspenso/inexistente |
| `ROOT_TENANT_MISSING` | root atribuído a tenant inexistente |
| `CROSS_TENANT_RELATION` / `OWNERSHIP_DIVERGENCE` | pai/ownership difere do root |
| `OWNERSHIP_NULL` / `ORPHAN_PARENT` | ownership esperado ausente ou pai inexistente |
| `HASH_INCONSISTENT` | hash informado difere do recomputado |
| `ROOT_MISSING` / `ROOT_UNEXPECTED` | inventário não é exatamente o fechado |
| `PARTIAL_READ` | qualquer delegate falhou parcialmente |

Qualquer blocker torna o agregado `BLOCKED`; integridade de linha pode exigir quarentena. O harness usa PostgreSQL 16 em rede interna, sem porta, recusa `DATABASE_URL` herdada, usa `docker exec -i`, `psql -X`, `ON_ERROR_STOP=1`, `public`, fixtures A×B e transação `READ ONLY`. Hash do dataset antes/depois comprova zero alteração durante a leitura.

## Riscos, operação e rollback

O diagnóstico não mede volume/locks/WAL/latência produtivos, não valida restore, não resolve qual tenant deve receber NULL e não prova que um delegate futuro consulta todas as relações. Falha de leitura, schema desconhecido ou adulteração bloqueiam. Rollback é exclusivamente reverter/remover módulo, scripts, gate e documentação; não há dado ou schema a desfazer. Uma execução real futura requer autoridade, conexão e evidência próprias, sem alegação baseada no harness.

