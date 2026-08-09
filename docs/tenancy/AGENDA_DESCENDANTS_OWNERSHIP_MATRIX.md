# Matriz de ownership dos descendentes de Agenda

## Inventário real

`AgendaEvent` possui somente dois descendentes diretos no schema: `AgendaStop` e `Activity`. `AgendaStop.id` é PK; `agendaEventId` é obrigatório, com `ON DELETE CASCADE` (update usa a ação padrão), e `(agendaEventId, order)` é unique. `clientId` é opcional; cidade, endereço, ordem, horários, coordenadas e resultados são dados de rota, não ownership. `Activity.agendaEventId` é opcional e usa `ON DELETE SET NULL`; também possui `clientId`, `opportunityId` opcionais e `ownerSellerId` obrigatório. Nenhum outro model referencia `AgendaEvent`.

O inventário de código encontrou CRUD de eventos/stops em `crudRoutes.ts`, criação/consulta de Activity por `agendaEventId` e leitura em `agendaIntelligenceService.ts`; scripts de recuperação referenciam `AgendaStop.clientId`. Há operações por ID, `findMany`, `findFirst/findUnique`, create, update/delete e transações/includes no runtime legado. Não foi encontrada autoridade tenant em jobs/IA/automações: esses fluxos ficam fora da integração desta Sprint.

## Matriz executável

| Descendente | Estado | Decisão |
|---|---|---|
| Stop | Agenda com exatamente uma raiz autorizada; Client nulo | permite |
| Stop | Agenda autorizada; Client presente e do mesmo tenant | permite; Client só restringe |
| Stop | Agenda cross-tenant, ausente, NULL ou multi-source | nega |
| Stop | Client cross-tenant/NULL | nega |
| Activity | Agenda como único pai relacional e autorizada | permite no adapter específico |
| Activity | Agenda e Client e/ou Opportunity, ainda que pareçam convergentes | nega |
| Activity | sem Agenda | fora deste adapter; permanece no XOR Client/Opportunity existente |
| Ambos | órfão ou Agenda com ownership NULL | nega |

Seller, sequência, posição e campos de rota jamais autorizam. O adapter de Activity é separado para não ampliar o XOR histórico: Prisma não compara fontes irmãs com segurança. Todo `where` parte do descendente e contém `agendaEvent` com o XOR de tenant direto, Client ou Opportunity da 1.0B.2-G. Create valida o pai na mesma transação; update comum recusa links; relink valida o novo pai; update/delete usam `updateMany`/`deleteMany`. Contexto inválido falha antes do delegate.

## Cascades e includes

Excluir Agenda pode apagar Stops em cascade e tornar Activities órfãs via SET NULL. Uma Agenda autorizada incorretamente ampliaria o blast radius; por isso mutations descendentes sempre repetem o predicado da raiz. Esta Sprint não muda FKs. Includes não são superfície dos adapters: root seguro não autoriza `stops`/`activities`, e descendente seguro não autoriza Agenda, Client, Opportunity ou seller de forma independente. Somente campos do próprio row são retornados.
