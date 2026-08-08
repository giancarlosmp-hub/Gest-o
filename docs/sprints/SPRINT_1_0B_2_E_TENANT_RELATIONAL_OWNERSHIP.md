# Sprint 1.0B.2-E — ownership relacional tenant-scoped

## Estado e limites

Entrega aditiva de 08/08/2026. Os adapters são provas isoladas, recebem `AuthTenantContext` e delegates por injeção e **não** estão conectados a controllers, serviços, jobs, agenda, automações, webhooks ou ERP. `TENANCY_MODE=disabled`; não houve banco, VPS, migration, backfill, deploy ou produção. Contexto histórico, JWT, `User.role`, break-glass e modo disabled permanecem intactos.

## Inventário relacional real

### Opportunity

`Opportunity.clientId` é obrigatório e aponta para `Client`; somente `Client.tenantId` (nullable no EXPAND) é a raiz de ownership. `ownerSellerId` não é ownership tenant. Descendentes são `Activity`, `AgendaEvent`, `TimelineEvent`, `OpportunityChangeLog`, `OpportunityItem` e `ErpOrderSync`; itens e syncs ERP usam `opportunityId`, logs usam cascade, e agenda/timeline podem ter também Client.

O runtime contém `findUnique`, `findFirst`, `findMany`, `create`, `update`, `updateMany`, `delete`, `deleteMany`, `count`, `aggregate` e `groupBy` em dashboard, CRUD, inteligências, automações, auditoria e scripts ERP. Há includes/selects de Client, Activity e Item, transações de importação/merge/automação, recálculo de itens seguido de update por `opportunityId` e operações de item/pedido/ERP que recebem apenas ID. Não foi encontrado SQL raw específico desses models; raw futuro requer predicado e prova equivalentes. Esses caminhos produtivos são apenas inventariados, **não migrados**.

### Activity

Pais opcionais reais: `clientId -> Client`, `opportunityId -> Opportunity -> Client` e `agendaEventId -> AgendaEvent`. O vendedor obrigatório (`ownerSellerId -> User`) não prova tenant. Agenda possui `tenantId` nullable e também Client/Opportunity, mas não é fonte autônoma nesta sprint: seu ownership expand ainda não migrado tornaria a decisão ambígua. Activity sem Client e Opportunity é órfã e negada mesmo com vendedor ou agenda.

O runtime contém buscas por ID/lote, create/update/delete, count/aggregate/groupBy, transações, dashboard, KPIs, agenda, automações, merge, IA e ERP. Includes/selects e operações apenas por `activityId` precisam herdar a matriz. Nenhum consumidor foi conectado.

## Matriz canônica (sem inferência silenciosa)

| Estado | Fonte e cadeia | Decisão |
|---|---|---|
| Opportunity com Client do tenant | `Opportunity.client -> Client.tenantId == context.tenantId` | permite |
| Client nulo/ausente, `tenantId=NULL` ou outro tenant | cadeia não comprova ownership | nega sem revelar existência |
| troca de Client | novo Client é do contexto e registro atual também está no predicado relacional | somente A→A/B→B |
| Activity somente com Client | `Activity.client.tenantId == context.tenantId` | permite |
| Activity somente com Opportunity | `Activity.opportunity.client.tenantId == context.tenantId` | permite |
| Activity com ambos | ambos são do tenant e `Opportunity.clientId == Activity.clientId` | permite se convergentes |
| pais no mesmo tenant, Clients diferentes | divergência semântica | nega |
| pai cross-tenant ou tenant nulo | uma prova falha | nega |
| sem Client e Opportunity | órfã; User/Agenda não substituem ownership | nega |
| contexto ausente/inativo/inválido | valida antes do delegate | nega |

AgendaEvent isolado, User e combinações históricas sem Client/Opportunity não podem ser autorizados aqui. Precisam de subfase própria após propagação tenant-scoped de Agenda.

## Estratégia Prisma

Opportunity envia `{ client: { tenantId } }` em leitura, count, aggregate, updateMany e deleteMany, composto com `id`. Create/troca rodam na transação injetada: validam `{ id: clientId, tenantId }` e criam/movem. A transação evita read-then-write; `updateMany` evita escrita por ID sem ownership.

Activity usa três cláusulas `AND`: (1) Client **ou** Opportunity prova tenant; (2) se Client existe, prova tenant; (3) se Opportunity existe, sua cadeia prova tenant. Órfãos e pais cross-tenant falham no predicado. Create/relink valida cada pai na mesma transação e, havendo ambos, compara `Opportunity.clientId` com Client.id. Updates comuns recusam chaves relacionais; relink é explícito. Delete/update por ID usam `*Many` e retornam sucesso/zero sem distinguir inexistente de cross-tenant.

Includes/selects não foram expostos. Quando adicionados, relações independentes (Activity/Agenda/Timeline) exigem `where` próprio: root seguro não torna automaticamente seguro todo include. `groupBy` não foi exposto; API futura deve enviar a mesma cláusula `where`. Nenhum resultado é filtrado em memória.

## Provas A×B

Fixtures sintéticas criam Tenant/Client/Opportunity A/B, Activity A/B, pais convergentes, divergentes e órfãos. Mocks relacionais registram argumentos: list/find/count/aggregate provam A→A e B→B sem vazamento; ID/update/delete provam A→B e B→A como null/zero; moves/relinks cross-tenant rejeitam; divergência/órfão rejeitam; `Promise.all` prova ausência de contexto global; contexto ausente/versão inválida falha sem delegate. O gate estático verifica injeção, contexto explícito, transações, ID, provas negativas, não integração e ordem CI.

## Riscos, rollback e próximo passo

Permanecem acessos não migrados em rotas, serviços, dashboard, IA, agenda, automações, ERP e scripts. `findUnique(id)`, includes, groupBy, merges, cascades e transações são prioritários. Banco/RLS não reforçam estes adapters e `tenantId` segue nullable. Rollback: remover adapters/teste/gate e entradas npm/CI/docs; não há estado de banco.

Próxima subfase: adapters para Agenda/Timeline e descendentes, depois leitores produtivos por consumidor; só então mutações/ERP e eventual backfill/constraints/RLS sob nova autorização.

`READY_FOR_1_0B_2_E_REVIEW = YES`  
`READY_FOR_TENANT_AWARE_RUNTIME = NO`  
`READY_FOR_BACKFILL_PRODUCTION = NO`  
`READY_FOR_MULTI_TENANT_CUTOVER = NO`  
`TENANCY_MODE = disabled`  
`PRODUCTION_ACCESSED = NO`
