# Sprint 1.0B.2-A — Schema Expand / Roots

## Objetivo
Adicionar a primeira boundary estrutural de ownership empresarial, exclusivamente por expansão nullable e sem ativar tenancy no runtime.

## Estado de partida
A PR #782 consta no predecessor local exato `fff1f669aeacba17f922577a7789c6a5b89210b6`. O checkout fornecido não possui remote configurado; por isso `origin/main` e checks remotos não puderam ser consultados e não são inferidos. A certificação aceita registra `READY_FOR_1_0B_2_DEVELOPMENT = YES`, enquanto `READY_FOR_MULTI_TENANT_CUTOVER = NO`, `DATABASE_SCHEMA_MODE=external` e `TENANCY_MODE=disabled`. Git não comprova produção; nenhuma VPS ou base produtiva foi acessada.

## Escopo
Somente roots com ownership diretamente atribuível. `tenantId = NULL` significa **registro ainda não migrado**; nunca significa global, tenant default automático ou acesso liberado. Não há backfill, default, handler, repository, JWT, auth, RLS, segundo tenant, deploy ou cutover.

## Inventário de roots

| Model | Categoria | Root? | Filho? | Pai de tenancy | Unique global atual | tenantId antes? | Prioridade | Risco | 1.0B.2-A? | Justificativa |
|---|---|---|---|---|---|---|---|---|---|---|
| User | identidade global | não | não | membership | `email` | não | alta | crítico | NO | identidade permanece global; ownership vem de membership |
| Tenant | control plane | sim | não | — | `slug` | n/a | concluída | baixo | NO | raiz canônica já existente |
| TenantMembership | control plane | não | sim | Tenant | tenant+user | sim | concluída | baixo | NO | já implementada na 1.0B.1 |
| KnowledgeDocument | conhecimento empresarial | sim | não | Tenant | — | não | média | médio | YES | conteúdo/configuração pertence diretamente à empresa |
| Client | CRM central | sim | não | Tenant | — | não | máxima | alto | YES | pai principal de contatos, oportunidades e timeline |
| ClientCodeAudit | auditoria de Client | não | sim | Client | — | não | média | médio | NO | propagação transitiva na 1.0B.2-D |
| AgendaEvent | agenda | sim | opcional de Client/Opportunity | Tenant | — | não | alta | alto | YES | pode existir só com vendedor; ownership é direto |
| AgendaStop | agenda | não | sim | AgendaEvent | evento+ordem | não | média | médio | NO | deriva do evento pai |
| Contact | CRM | não | sim | Client | — | não | alta | alto | NO | deriva do Client, inclusive quando legado está órfão |
| Opportunity | CRM | não | sim | Client | — | não | máxima | crítico | NO | ownership deve propagar do Client e validar relações |
| OpportunityChangeLog | auditoria | não | sim | Opportunity | — | não | média | médio | NO | deriva da oportunidade |
| TimelineEvent | CRM | não | sim | Client/Opportunity | — | não | média | alto | NO | pai opcional exige reconciliação posterior |
| Activity | CRM | não | sim | Client/Opportunity/AgendaEvent | — | não | alta | alto | NO | múltiplos pais exigem propagação reconciliada |
| Goal | metas empresariais | sim | não | Tenant | seller+month | não | alta | médio | YES | política empresarial atribuível diretamente |
| ActivityKPI | metas empresariais | sim | não | Tenant | seller+month+type | não | alta | médio | YES | política empresarial atribuível diretamente |
| Sale | vendas | sim | não | Tenant | — | não | média | médio | YES | fato empresarial diretamente atribuível |
| SellerTerritoryCity | território | sim | não | Tenant | seller+state+city | não | alta | médio | YES | configuração territorial empresarial |
| AppConfig | configuração empresarial | sim | não | Tenant | `key` | não | alta | alto | YES | configuração ERP/runtime de negócio é por empresa |
| CultureCatalog | catálogo candidato global | sim | não | plataforma | `slug` | não | baixa | médio | NO | globalidade requer decisão explícita antes de tenantizar |
| Product | catálogo ERP empresarial | sim | não | Tenant | código+classe ERP | não | alta | alto | YES | pai do preço/item e ERP multiempresa exige ownership |
| ProductPrice | catálogo | não | sim | Product | — | não | alta | alto | NO | deriva do Product |
| OpportunityItem | CRM/pedido | não | sim | Opportunity | oportunidade+linha | não | alta | crítico | NO | deriva da Opportunity; também referencia Product |
| ErpOrderSync | pedido ERP | não | sim | Opportunity | pedido importação | não | alta | crítico | NO | idempotência deve propagar da Opportunity em fase própria |
| ErpSyncRun | integração ERP | sim | não | Tenant | — | não | alta | alto | YES | execução, métricas e diagnóstico devem ter ownership direto |
| ErpSyncLock | coordenação ERP | sim | não | Tenant | PK `scope` | não | alta | crítico | YES | lock deve ser namespaceável; PK global é preservada nesta fase |
| CommunicationIntegrationAccount | integração comunicação | sim | não | Tenant futuro | provider+externalAccount | sim, obrigatório textual | alta | crítico | NO | modelo parcial exige reconciliação/FK sem quebrar dados existentes |
| CommunicationConversation | comunicação | não | sim | IntegrationAccount | provider+externalConversation | sim, nullable textual | alta | crítico | NO | deriva da conta e exige propagação reconciliada |
| CommunicationMessage | comunicação | não | sim | Conversation/Account | provider+externalMessage | sim, nullable textual | alta | crítico | NO | filho com boundary parcial |
| CommunicationWebhookEvent | comunicação | não | sim | IntegrationAccount | provider+externalEvent | sim, nullable textual | alta | crítico | NO | idempotência deriva da conta externa |

## Roots selecionados
`Client`, `AgendaEvent`, `Product`, `AppConfig`, `Goal`, `ActivityKPI`, `Sale`, `SellerTerritoryCity`, `KnowledgeDocument`, `ErpSyncRun` e `ErpSyncLock`.

## Roots adiados
Filhos de Client/Opportunity/Agenda/Product/Communications e pedidos ERP ficam para propagação 1.0B.2-D. `CultureCatalog` aguarda classificação como catálogo global ou empresarial. Os models Communications já têm boundary textual parcial, mas sua conversão segura em FK depende de reconciliação separada.

## Decisão ErpSyncRun/ErpSyncLock
Ambos entram. O código atual usa `ErpSyncRun` para execução, diagnóstico e idempotência operacional e usa `ErpSyncLock.scope` como exclusão global. Em ERP multiempresa, run e lock pertencem à empresa; sem namespace, scopes homônimos causariam interferência e indisponibilidade cruzadas. Nesta expand, `tenantId` apenas prepara essa ownership. A PK global de `ErpSyncLock.scope` e todo comportamento atual permanecem intactos; sua futura substituição por chave tenant+scope ocorrerá somente após backfill/data-access e prova concorrente A×B.

## Alterações Prisma
Cada root selecionado recebe `tenantId String?`, relação opcional nomeada com `Tenant` e ações referenciais `NoAction`. As inversas ficam agrupadas no control plane. Não existe default ou fallback.

## Migration
A migration única `20260808120000_tenancy_expand_roots` contém exatamente 11 colunas nullable, 11 índices e 11 FKs. Não contém DML, DROP, TRUNCATE, SET NOT NULL, RLS, role ou valor do tenant default.

## Índices
Um índice simples por `tenantId` foi aprovado para lookup/reconciliação e para suportar cada FK/consultas tenant-first futuras. Índices compostos especulativos foram adiados até existirem padrões de consulta tenant-aware medidos.

## Uniques transitórios
Todos os uniques globais permanecem: `AppConfig.key`, Product código+classe, Goal seller+month, ActivityKPI seller+month+type, SellerTerritoryCity seller+state+city e `ErpSyncLock.scope`. A 1.0B.2-D mede consumidores e colisões; somente a fase constrain posterior substitui uniques por versões tenant-scoped.

## Compatibilidade
Linhas e inserts legados omitem `tenantId` e continuam válidos. Nenhum handler, repository, JWT, middleware, role ou modo runtime muda. NULL é estado de migração, não autorização.

## Harness PostgreSQL
O harness descartável PostgreSQL 16 materializa o schema predecessor do Git, cria fixtures, aplica a migration uma vez, rejeita reaplicação, valida nullable/NULL/counts/FKs/índices/uniques e exige post-diff vazio. Também preserva uma tabela sintética `incident_*`. Docker indisponível localmente resulta em SKIP 77; o workflow com Docker executa o gate obrigatoriamente.

## Testes negativos
O gate estático usa allowlist exata das 33 instruções e rejeita DML, DROP, TRUNCATE, SET NOT NULL, tenant default hardcoded, grants/RLS e mutações destrutivas do control plane. O harness rejeita tenant inexistente, duplicate de unique global e segunda aplicação da migration.

## Rollback
Abortar a promoção, manter as colunas nullable e o runtime legado disabled. Não existe down migration nem DROP automático. Reverter Git não reverte schema.

## Riscos
Os uniques e locks ainda são globais, `tenantId` permanece nulo e o runtime não oferece isolamento. Índices adicionam custo de escrita e FKs tomam lock de catálogo durante DDL; o harness e a futura operação devem medir janela. A fase não autoriza alegação multiempresa.

## Evidências
No head remoto `59d1243` da PR #783, o GitHub Actions comprovou `Preview Deploy = SUCCESS`, `Docker Compose CI / compose-smoke = SUCCESS`, `Prove tenancy roots expand on PostgreSQL 16 = PASS` e `TENANCY_EXPAND_POSTGRES=PASS`, sem command not found, exit 77 ou falha de fixture. O harness executou create → verify → baseline → apply → preserve sobre `public."incident_synthetic"` exclusivamente sintética e descartável, validando existência, coluna `id`, tipo `integer`, `NOT NULL`, PK e count antes/depois. A evidência comprova somente o banco descartável: não houve merge, deploy, apply produtivo, backfill ou cutover.

## Critérios de aceite
Roots justificados; expansão somente nullable/aditiva; zero alteração de dados/runtime; uniques preservados; FK segura; testes antigos e novos verdes; PostgreSQL 16 e post-diff verdes no CI; documentação reconciliada. `READY_FOR_MULTI_TENANT_CUTOVER = NO`.

## Próxima subfase
1.0B.2-B: tooling de backfill separado, dry-run, ledger, batches, hashes, quarentena e reconciliação, sem execução produtiva automática.
