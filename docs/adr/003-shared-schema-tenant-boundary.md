# ADR 003 — Boundary multiempresa em schema compartilhado

- **Status:** aceita; implementação condicionada aos gates desta ADR
- **Data da proposta:** 02/08/2026
- **Data do aceite:** 02/08/2026
- **Comitê (papéis participantes):** CTO/Arquitetura (**A**), Segurança, DBA, Backend, DevOps, QA, Product Owner e LGPD/Jurídico (**C**). Os papéis não representam presença nominal inventada; a ocupação formal permanece gate operacional.

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


## Condições obrigatórias do aceite

1. O aceite autoriza o desenho e o scaffolding default-only, **não** migration, backfill, deploy, segundo tenant ou alegação multiempresa.
2. `TenantContext` é imutável, fail-closed e só nasce de fonte confiável; body, query e header livre jamais são autoridade.
3. Todo futuro data access empresarial exige contexto; escape de plataforma é interface separada, nomeada, temporária e auditada.
4. Expand/backfill/constrain/contract ocorrem em Sprints separadas, com reconciliação, quarentena, rollback e restore aprovados.
5. FK e uniques compostas precedem liberação multiempresa; RLS é defesa adicional sob role sem bypass, nunca substituto do filtro.
6. ERP, webhooks, IA, cache, jobs, locks, logs e métricas precisam de prova A×B antes do piloto.
7. O tenant default é a única compatibilidade autorizada até os gates 1.0B–1.0E.

A revisão crítica não identificou bloqueador arquitetural: os custos operacionais do schema compartilhado são tratados pelos controles acima e pela possibilidade de ADR futura para tenants regulados.
