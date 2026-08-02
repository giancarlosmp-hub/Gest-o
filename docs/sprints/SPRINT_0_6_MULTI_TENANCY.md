# Sprint 0.6 — Enterprise Multi-Tenancy Assessment

**Estado:** 🔵 PR documental em 02/08/2026.  
**Baseline:** `work` / `b9edd86178fe2ba5f86a4af00a04b7fdef5406de`; sem `main`, remote ou
`origin/main` localmente verificáveis. Último merge local: PR #769. Isso não prova produção.

## Objetivo e diagnóstico

Auditar o checkout e definir o caminho oficial para SaaS multiempresa sem implementar tenancy. O
resultado é [`TENANCY_ASSESSMENT.md`](../TENANCY_ASSESSMENT.md): o sistema é single-tenant; somente
Communications possui `tenantId` parcial e não há raiz Tenant, membership, contexto, repositories,
isolamento de jobs/cache/ERP ou testes cross-tenant.

## Decisão inédita

A [ADR 003](../adr/003-shared-schema-tenant-boundary.md) propõe schema PostgreSQL compartilhado,
isolamento por linha, FK/unique compostas, repository obrigatório e RLS defensiva. A decisão precisa
ser aceita antes de implementação e não autoriza migration nesta Sprint.

## Escopo entregue

- inventário de 27 models/tabelas Prisma, 19 enums, 36 migrations, índices/FKs e raw SQL;
- inventário de controllers, services, repositories, middlewares, 216 handlers lógicos, rotinas ERP,
  schedulers, caches, JWT, logs, scripts, seeds, testes, dashboards e integrações;
- classificação READY/PARCIAL/NÃO COMPATÍVEL, mapa de dependências/riscos;
- estratégia expand/backfill/dual enforcement/contract, compatibilidade, rollout e rollback;
- roadmap 1.0A–1.0F e detalhamento do TD-ER-004.

## Fora do escopo e guardrails

Nenhum código de aplicação, API, regra de negócio, banco, schema, migration, Docker, deploy, VPS ou
produção é alterado/acessado. Não se presume o estado de produção e nenhum incidente ou débito é
encerrado.

## Critérios de aceite

- inventário e classificação auditáveis contra o checkout;
- TenantId obrigatório/opcional/proibido e impactos em chaves, filas, logs, JWT e ERP explícitos;
- estratégia, compatibilidade, rollout, rollback e roadmap aprováveis;
- somente dimensões Multiempresa, Arquitetura e Roadmap alteradas na readiness;
- build, typecheck, testes existentes, `git diff --check`, links Markdown e status executados.

## Riscos e rollback

O risco é tratar documento/ADR proposta como implementação ou certificação. Os avisos, gates e
estado vermelho mitigam isso. Rollback é reverter somente este commit documental; não há rollback de
runtime ou dados.
