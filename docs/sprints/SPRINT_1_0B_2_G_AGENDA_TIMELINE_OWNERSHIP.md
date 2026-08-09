# Sprint 1.0B.2-G — ownership de Agenda e Timeline

## Escopo e predecessor

A PR #788 foi confirmada no HEAD integrado, com o gate **Prove Activity dual-parent enforcement on PostgreSQL 16** verde e exits concorrentes 3/3. O DDL segue candidato e o `ActivityTenantRepository` segue XOR. Esta entrega cria somente adapters injetáveis e provas sintéticas A×B; não conecta runtime, não acessa produção e mantém `TENANCY_MODE=disabled`.

## Entrega

A matriz canônica está em `docs/tenancy/AGENDA_TIMELINE_OWNERSHIP_MATRIX.md`. Os adapters recebem `AuthTenantContext`, validam antes de chamar delegate, usam `$transaction`, predicados relacionais no banco e mutations por ID com `updateMany`/`deleteMany`. Agenda aceita tenant direto **ou** Client **ou** Opportunity; Timeline aceita Client **ou** Opportunity. A política é XOR restritiva porque Prisma não compara fontes irmãs. Seller não autoriza.

Fixtures independentes cobrem tenants A/B, Clients, Opportunities, roots por cada fonte, fontes convergentes, divergentes no mesmo tenant, cross-tenant, NULL, órfãos e contexto inválido. Activity A/B como pai não pode ser criada sem inventar relação: no schema Activity é descendente opcional de Agenda. As provas cobrem A→A, B→B, negativas cruzadas, lista/ID/create/update/relink/delete/count/aggregate/groupBy, concorrência, payload e argumentos reais.

Includes independentes são proibidos pela ausência dessa superfície no adapter e pelo gate estático. Descendentes `AgendaStop` e `Activity` permanecem sem adapter e sem promessa de segurança por simples include.

## Limitações, risco e rollback

Todos os acessos produtivos inventariados permanecem legados e desconectados. Não há enforcement de banco para convergência, tenantId continua nullable, não há suporte a multi-parent nem descendentes por ID, e operações globais requerem classificação futura. Rollback consiste em remover os dois artefatos TypeScript, teste/gate/script npm, step CI e documentação; não há dados, migration ou DDL a reverter.

Próxima subfase recomendada: adapters isolados de AgendaStop/Activity-por-Agenda e migração gradual de um único fluxo read-only após desenho explícito de contexto para HTTP, jobs, ERP, IA e webhooks.

## Declarações

`READY_FOR_1_0B_2_G_REVIEW=YES`; todas as prontidões de migration Activity, runtime tenant-aware, backfill produtivo e cutover permanecem `NO`; `TENANCY_MODE=disabled`; `PRODUCTION_ACCESSED=NO`.
