# Sprint 1.0B.2-H — ownership dos descendentes de Agenda

## Predecessor, escopo e evidência

A PR #789 está integrada no HEAD e foi confirmada pela coordenação com checks verdes, inclusive **Prove Agenda and Timeline tenant ownership isolation**. A política XOR, os adapters desconectados e a prova PostgreSQL dual-parent permanecem preservados. Esta entrega adiciona somente adapters injetáveis e provas sintéticas; não conecta runtime, não muda schema/FKs/JWT/RBAC, não aplica DDL, backfill, deploy ou acesso a produção. `TENANCY_MODE=disabled`.

## Entrega e provas A×B

A matriz e o inventário estão em `AGENDA_DESCENDANTS_OWNERSHIP_MATRIX.md`. `AgendaStop` deriva ownership exclusivamente de Agenda, repetindo o predicado XOR da 1.0B.2-G; seu Client opcional só restringe e precisa convergir com o tenant. `AgendaActivityTenantRepository` aceita exclusivamente Activity somente-Agenda. Activity com Client/Opportunity continua negada neste canal, mesmo quando aparentemente convergente, e Activity sem Agenda continua sob `ActivityTenantRepository`.

Fixtures independentes exercitam A/B, Clients, Opportunity, Agenda direta/Client/Opportunity, multi-source, NULL, stops A/B/cross-tenant/órfão e Activities somente Agenda, multi-parent, divergentes, cross-tenant e órfãs. As provas inspecionam argumentos dos delegates em lista, ID, create, update, relink, delete, count, aggregate, groupBy, concorrência, contexto inválido e payload de ownership. Não há filtragem em memória nem includes.

## Risco, rollback e próxima fase

CASCADE de Agenda para Stop e SET NULL para Activity podem ampliar dano se a raiz estiver errada; nenhuma FK foi alterada. O runtime legado ainda usa Prisma diretamente, includes e IDs sem estes adapters. Rollback é remover os dois arquivos de prova, gate e documentação; não há rollback de banco. Próxima subfase recomendada: inventário e migração gradual de um único fluxo read-only com contexto explícito, após decisão sobre Activities multi-parent e stops com Client histórico.

`READY_FOR_1_0B_2_H_REVIEW = YES`; demais gates de migration/runtime/backfill/cutover permanecem NO.
