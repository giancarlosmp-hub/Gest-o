# Sprint 1.0B.2-F — prova PostgreSQL de dual-parent para Activity

## Objetivo e limites

Provar em PostgreSQL 16 descartável que uma FK composta pode garantir atomicamente `Activity.clientId = Activity.opportunity.clientId` quando os dois links existem. Não há migration produtiva, alteração do schema Prisma, integração runtime, mudança no XOR, acesso a produção, diagnóstico real, backfill, deploy ou cutover.

## Evidência reproduzível

O gate estático confere versão Docker, `docker exec -i`, `psql -X`, `ON_ERROR_STOP=1`, ordem fixtures/baseline/DDL, provas positivas/negativas, catálogo, concorrência, rollback e post-diff; também protege XOR e ausência nas rotas. O gate PostgreSQL cria rede interna sem porta publicada, materializa a projeção fiel do predecessor, cria matriz A×B e pai com tenant NULL, registra baseline, aplica somente o DDL candidato `NOT VALID`, executa dois backends concorrentes e remove todo o ambiente ao sair. Falha é fechada; exit 77 existe somente para indisponibilidade local de Docker/imagem. No CI, a imagem é previamente baixada e o comando direto torna qualquer 77 uma falha do step.

As provas esperadas são: convergente, somente Client, somente Opportunity e ambos NULL aceitos; divergente no mesmo tenant, cross-tenant e relink divergente negados; updates concorrentes de pai e filho não deixam violação nova; baseline histórica preservada; constraint/unique presentes; rollback transacional possível; post-diff contém exatamente os dois objetos autorizados. A divergência histórica sintética permanece por causa de `NOT VALID`, evidenciando a necessidade de saneamento.

## Decisão e gates

A FK composta é preferida a trigger, query transacional e ownership duplicado pelas razões, queries, impacto Prisma, comportamento NULL, locks, rollout e rollback registrados no [plano de enforcement](../tenancy/ACTIVITY_DUAL_PARENT_ENFORCEMENT_PLAN.md). É recomendação futura, não autorização.

- `READY_FOR_1_0B_2_F_REVIEW`: depende dos testes e revisão desta entrega.
- `READY_FOR_ACTIVITY_DUAL_PARENT_MIGRATION = NO`.
- `READY_FOR_TENANT_AWARE_RUNTIME = NO`.
- `READY_FOR_BACKFILL_PRODUCTION = NO`.
- `READY_FOR_MULTI_TENANT_CUTOVER = NO`.
- `TENANCY_MODE = disabled`; `PRODUCTION_ACCESSED = NO`.
