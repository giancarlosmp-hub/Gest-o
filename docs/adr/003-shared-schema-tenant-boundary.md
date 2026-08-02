# ADR 003 — Boundary multiempresa em schema compartilhado

- **Status:** proposta para a Sprint 1.0; implementação condicionada aos gates deste ADR
- **Data:** 02/08/2026

## Contexto

O Gest-o opera hoje como uma instalação de empresa única. Dos 27 models Prisma, apenas os quatro de
Communications possuem `tenantId`, ainda textual, opcional em três deles, sem uma entidade `Tenant`
nem uma boundary comum na autenticação, autorização, consultas, jobs, caches ou ERP. Fazer somente
um acréscimo de coluna produziria isolamento aparente e manteria caminhos de acesso cruzado.

## Decisão

A evolução oficial adotará **PostgreSQL com schema compartilhado e isolamento por linha**:

1. `Tenant` será a raiz de identidade empresarial e `TenantMembership` ligará usuários a tenants;
2. toda entidade de negócio pertencente a uma empresa terá `tenantId` obrigatório e FK para
   `Tenant`; entidades-filhas também o carregarão para permitir FK composta e defesa local;
3. identificadores externos e unicidades de negócio serão compostos por `tenantId`;
4. o tenant efetivo virá de contexto autenticado validado contra membership, nunca de body/query;
5. repository/data-access será a única porta para Prisma e exigirá contexto de tenant; acesso sem
   escopo ficará restrito a interfaces explícitas de plataforma e rotinas operacionais auditadas;
6. jobs, locks, idempotência, cache, logs, métricas e integrações incluirão a mesma identidade;
7. catálogos realmente globais, metadados de plataforma e a própria raiz `Tenant` jamais receberão
   `tenantId`; configuração empresarial será separada de configuração da plataforma;
8. PostgreSQL Row-Level Security será uma segunda barreira planejada, depois da correção de todas as
   consultas, e nunca substituirá os filtros e testes da aplicação.

Não se adotará database-per-tenant nesta fase. A decisão poderá ser revista para tenants regulados
por uma ADR futura, mantendo IDs e contratos de contexto portáveis.

## Alternativas rejeitadas

- **Database/schema por tenant agora:** isolamento forte, mas eleva provisionamento, migrations,
  pool de conexões, observabilidade e operação antes de existir control plane.
- **Somente filtros Prisma ou extensão `$use`:** não cobre raw SQL, relações, jobs, scripts e erros de
  desenvolvimento; middleware foi removido do Prisma moderno e não constitui boundary suficiente.
- **Tenant enviado pelo cliente:** permite spoofing e confunde seleção de contexto com autorização.
- **Inferir tenant por vendedor, filial ERP ou conta WhatsApp:** essas são identidades de domínio,
  não a autoridade empresarial canônica.

## Consequências e gates

O modelo reduz custo operacional inicial, mas exige disciplina transversal e mudança futura de
schema. Antes do rollout: inventário fechado, backfill determinístico, constraints compostas,
testes negativos cross-tenant, dual-read controlado, observabilidade por tenant, restore ensaiado e
rollback aprovado. Esta ADR não autoriza migration, deploy ou alteração de API nesta Sprint.

