# Sprint 1.0B.2-D — propagação segura de TenantContext no data access

## Estado e decisão

O checkout parte de `cf8dc01`, merge da PR #785, e contém o predecessor 1.0B.2-C. A entrega é
aditiva: contrato e piloto isolado, sem controller, middleware, job, webhook ou scheduler.
`TENANCY_MODE=disabled`; não houve produção, deploy, backfill ou cutover.

O piloto é **Client**, não Opportunity. Client é root expand com `tenantId` direto nullable e tem
CRUD/count representativos. Opportunity não tem `tenantId`, deriva ownership de Client e está
acoplada a itens, atividades, ERP e automações. Pilotá-la exigiria propagação relacional ou schema
fora do escopo. Client prova o predicado Prisma direto sem alterar o runtime.

## Inventário Prisma dos 11 nomes solicitados

Inventário estático de `apps/api/src/**/*.ts` em 08/08/2026. Operações `tx.*` estão em transações.
ID inclui findUnique/findFirst/update/delete; lote inclui findMany/updateMany/deleteMany/upsert;
A/C/G significa aggregate/count/groupBy. Salvo o piloto, os acessos legados em geral omitem tenant.

| Root / domínio | Arquivos e operações encontradas | Classe e superfícies | tenantId atual / risco cross-tenant |
|---|---|---|---|
| AppConfig / configuração e ERP | `routes/ultraFv3Routes.ts` findUnique; `routes/crudRoutes.ts` findMany×3/findUnique×4/upsert×5; `jobs/erpSyncScheduler.ts` findUnique/upsert; `services/ultraFv3SyncService.ts` findUnique×2/upsert×7; `services/erpOrderService.ts` findUnique×2/upsert×2; `services/erpOrderPdfService.ts` findUnique | ID/lote/escrita; scheduler ERP; sem webhook | sim nullable, usualmente ausente; **alto**, chave/configuração global |
| Client / CRM | `routes/dashboardRoutes.ts` count/findMany; `routes/crudRoutes.ts` count×4/create×4/delete×2/findFirst×9/findMany×13/findUnique×4/groupBy/update×4; scripts `backfillClientNormalized`, `ensureSmokeBootstrap`, `erpFixLegacyDuplicates`, `erpFixArchivedFlag`: find/count/create/update/updateMany; services `erpPartnerInvestigation`, `commercialInsights`, `ultraFv3Sync`, `commercialAutomations`, `planningIntelligence`, `clientAiContext`, `timelineIntelligence`, `conversationalCrm`, `platformHealth`, `databaseHealth`: find/create/update/updateMany/count | ID/lote/CRUD/A-C-G; várias transações, scripts e ERP; sem webhook | sim nullable; **crítico**, root central; piloto sempre envia tenant |
| Opportunity / CRM/pedidos | `routes/dashboardRoutes.ts` aggregate/findMany×6; `routes/crudRoutes.ts` count×3/create×2/delete/deleteMany/findFirst×23/findMany×12/findUnique×6/groupBy×6/update×5/updateMany; `erpFixLegacyDuplicates` updateMany; services `commercialInsights`, `ultraFv3Sync`, `commercialAutomations`, `planningIntelligence`, `clientAiContext`, `timelineIntelligence`, `conversationalCrm`, `databaseHealth`: find/create/updateMany/count/aggregate | todos os tipos; transações, automações e ERP; sem webhook | não, deriva de Client; **crítico** |
| Activity / CRM/agenda | `dashboardRoutes.ts` findMany; `crudRoutes.ts` aggregate/count×3/create×3/delete/deleteMany/findFirst×4/findMany×8/groupBy×9/update×3/updateMany; `erpFixLegacyDuplicates` updateMany; services comerciais/ERP/planning/AI/timeline/database: find/create/updateMany/count/aggregate | todos os tipos/A-C-G; transações, automações/ERP; sem webhook | não, múltiplos pais; **crítico** |
| Product / catálogo ERP | `crudRoutes.ts` count/findMany×3/findUnique×3; `commercialInsightsService.ts` findMany; `ultraFv3SyncService.ts` findFirst×2/findMany/findUnique/update×2/upsert | ID/lote/leitura/escrita/count; sync ERP | sim nullable, usualmente ausente; **alto** |
| CommercialGoal / comercial | nenhum model/delegate Prisma com esse nome | nenhuma operação/job/webhook | ausente; schema usa `Goal`; risco **alto** se assumido existente |
| PricingPolicy / precificação | nenhum model/delegate Prisma com esse nome | nenhuma operação/job/webhook | ausente; risco indefinido |
| CommissionRule / comissão | nenhum model/delegate Prisma com esse nome | nenhuma operação/job/webhook | ausente; risco indefinido |
| ErpSyncRun / observabilidade ERP | `crudRoutes.ts` count/findMany×2; `erpSyncScheduler.ts` create/findFirst×3/update×2; `ultraFv3SyncService.ts` create×3/findFirst/findMany×2/update×4; `platformHealthService.ts` findMany | ID/lote/create/update/count; schedulers ERP | sim nullable, usualmente ausente; **crítico** |
| ErpSyncLock / coordenação ERP | `ultraFv3SyncService.ts` create/deleteMany/findUnique/updateMany | ID/lote/escrita; job ERP | sim nullable, `scope` PK global; **crítico** |
| User / identidade | `dashboardRoutes.ts` findMany; `crudRoutes.ts` count×2/create/delete/findFirst/findMany×18/findUnique×11/update×7; bootstrap/auth; scripts `ensureSmokeBootstrap`, `adminEnsureUser`, `seedDefaultUsers`, `knowledgeBaseSmoke`; services agenda/ERP/comercial/planning/AI/database: find/create/update/upsert/deleteMany/count | todos os tipos; auth/bootstrap/scheduler/smoke/transações; sem webhook | sem tenant direto, vínculo por membership; **crítico** |

Não há acesso desses delegates em webhook. O inventário não é allowlist: raw SQL, acessos indiretos
e roots históricos `Goal`, `ActivityKPI`, `Sale`, `SellerTerritoryCity`, `KnowledgeDocument` e
`AgendaEvent` permanecem para ondas posteriores.

## Contrato, piloto e matriz A×B

`tenantIdFromAuthContext` recebe somente `AuthTenantContext`, valida tenant/user/membership ativa e
versão 1 e falha fechado. `assertTenantOwnership` rejeita tenant divergente na criação; update
rejeita qualquer `tenantId`. Não há HTTP, global, singleton mutável, AsyncLocalStorage, default ou
filtragem posterior.

`ClientTenantRepository` recebe delegate por injeção e contexto em cada método. List/count enviam
`{tenantId}`; ID envia `{id,tenantId}`; create força o tenant validado; update/delete usam
`updateMany/deleteMany` com predicado composto, evitando read-then-write inseguro.

| Prova sintética | A | B |
|---|---|---|
| listar/contar próprios | A→A permite | B→B permite |
| buscar/atualizar/excluir próprio | permite | permite |
| cruzar tenant | A→B nega/null/zero | B→A nega/null/zero |
| criar divergente / mudar ownership | nega | nega |
| concorrência | somente A | somente B |
| contexto ausente/inválido | nega antes do delegate | nega antes do delegate |

O fake Prisma é estrito, registra argumentos e o teste afirma tenant em todo `where` e composição
ID+tenant. O gate estático verifica contrato, ausência de HTTP/global/default, não integração aos
controllers, ownership e posição CI sem bypass.

## Riscos, limitações, rollback e próxima subfase

- O piloto não corrige os acessos produtivos inventariados; `tenantId` continua nullable e NULL não
  autoriza acesso. Uniques e lock continuam globais.
- Cada adapter futuro exige teste dos argumentos Prisma e revisão de relações, includes,
  transações, raw SQL e caches.
- Rollback remove contrato/piloto/gate aditivos, preservando schema, dados, JWT, controllers,
  schedulers, webhooks e modo disabled.
- Próximo: integrar uma superfície interna não HTTP de Client somente após backfill/reconciliação;
  depois desenhar ownership transitiva de Opportunity/Activity. User e lock ERP exigem decisões.

`READY_FOR_TENANT_AWARE_RUNTIME = NO`
`READY_FOR_BACKFILL_PRODUCTION = NO`
`READY_FOR_MULTI_TENANT_CUTOVER = NO`
`TENANCY_MODE = disabled`
`PRODUCTION_ACCESSED = NO`
