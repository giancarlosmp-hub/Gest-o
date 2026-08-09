# Matriz de ownership de Agenda e Timeline

## Schema e decisão fail-closed

`AgendaEvent.tenantId`, `clientId` e `opportunityId` são opcionais; `sellerId` é obrigatório. `TimelineEvent` não possui `tenantId`: `clientId` e `opportunityId` são opcionais e `ownerSellerId` é obrigatório. Opportunity deriva ownership exclusivamente de `Opportunity → Client.tenantId`; seller/owner jamais é autoridade tenant. Activity não é pai de nenhum dos roots: `Activity.agendaEventId` torna Activity descendente de Agenda. `AgendaStop.agendaEventId` é descendente com cascade.

O Prisma atual não consegue comparar `AgendaEvent.clientId` com `AgendaEvent.opportunity.clientId`, nem provar convergência entre quaisquer fontes irmãs no predicado. Portanto, a política executável mais restritiva aceita **exatamente uma fonte**. Não se escolhe o primeiro pai e não se declara suporte a multi-parent. A prova PostgreSQL de Activity não muda esta decisão.

| Root/estado | Fonte autorizadora | Resultado |
|---|---|---|
| Agenda, somente `tenantId` não nulo | igualdade com `AuthTenantContext.tenantId` | permite |
| Agenda/Timeline, somente Client | `Client.tenantId` igual ao contexto | permite |
| Agenda/Timeline, somente Opportunity | `Opportunity.client.tenantId` igual ao contexto | permite |
| duas ou três fontes, ainda que convergentes | comparação entre fontes não executável com segurança | nega |
| fontes divergentes no mesmo tenant ou cross-tenant | ambígua/divergente | nega |
| tudo NULL, pai órfão ou Client com tenant NULL | sem prova | nega |
| User/seller/ownerSeller | identidade operacional, não ownership | nunca autoriza |
| Activity informada como suposto pai de Agenda/Timeline | relação inexistente no schema | nega/não suportado |

Criação valida a única fonte dentro de transação. Reads incorporam a matriz em `where`; update/delete por ID usam `updateMany`/`deleteMany`; relink primeiro valida o novo pai e depois mantém escopo do root antigo. Payload comum não pode alterar `tenantId`, `clientId` ou `opportunityId`. O adapter não recebe request HTTP.

## Includes e descendentes

Root autorizado não torna include seguro. A API isolada não expõe `include`: `stops`, `activities`, `client`, `opportunity`, `seller` e demais relações não podem ser incluídos por ela. AgendaStop e Activity consultados/mutados por ID exigirão adapters próprios que provem primeiro o root Agenda e, para seus pais independentes, a política própria; até lá não há suporte. `aggregate`, `count` e `groupBy` sempre recebem o mesmo `where`.

## Inventário de acessos ainda não migrados

| Área/arquivo | Operações observadas | Ownership atual/risco | Comportamento futuro |
|---|---|---|---|
| `apps/api/src/routes/crudRoutes.ts` | findUnique/findFirst/findMany, create, update/updateMany, delete/deleteMany, count/groupBy, includes/selects e transações; várias operações recebem apenas ID | seller/client e filtros funcionais; risco cross-tenant | migrar por fluxo, incluindo descendants e relinks |
| `apps/api/src/services/{agendaIntelligenceService,planningIntelligenceService,timelineIntelligenceService,clientAiContext}.ts` | leituras, selects e includes para agenda/IA | seller/client; root não é tenant-scoped | exigir contexto confiável e adapter dedicado |
| `apps/api/src/services/{commercialAutomationsService,communications/communicationIntegrationService,ultraFv3SyncService}.ts` | creates e updateMany em transações, webhooks/automação/ERP | pais vindos do fluxo; contexto não provado pelo adapter | derivar contexto do canal confiável antes de integrar |
| `apps/api/src/scripts/erpFixLegacyDuplicates.ts` e Prisma seeds | create/deleteMany/updateMany | manutenção global intencional | manter fora do runtime tenant ou criar modo operacional auditado |
| `apps/api/src/utils/databaseHealth.ts` e scripts recovery/health | count e SQL direto | observabilidade/global | não converter silenciosamente; classificar como operação de plataforma |

Não foi localizado cache específico de AgendaEvent/TimelineEvent. O inventário textual completo deve ser refeito antes da integração porque controllers, jobs, webhooks, schedulers e scripts foram deliberadamente preservados.
