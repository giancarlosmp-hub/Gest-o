# Sprint 1.0B.1 — Persistência do Control Plane e Tenant Default

## Objetivo e problema

Persistir, sem ativar multiempresa, o control plane aprovado na ADR 003. O estado inicial no merge
da PR #771 (`dc7ceb0`) continha contratos default-only, mas nenhum `Tenant`, `TenantMembership`,
migration ou preparação auditável. Git não é evidência do estado de produção.

## Decisões herdadas

Mantêm-se schema compartilhado, `User` global, contexto fail-closed, autoridade de migration
separada do runtime (ADR 002), expansão aditiva e Multiempresa 🔴. `User.role`, JWT, refresh token,
handlers e os models empresariais não mudam.

## Escopo

- três enums de lifecycle/role, `Tenant`, `TenantMembership` e relação reversa em `User`;
- migration SQL estritamente aditiva, identidade default v1 e membership determinística;
- runner explícito dry-run/apply, ledger sem PII, reconciliação e adapter Prisma;
- `TENANCY_MODE=disabled|default-only`, teste estático e PostgreSQL 16 descartável.

## Fora do escopo

`tenantId` nos 23 models centrais, integração aos 216 handlers, alteração de autenticação, segundo
tenant, RLS, deploy, apply ou acesso à produção e rollback destrutivo pertencem a etapas futuras.

## Riscos e controles

Drift parcial, role desconhecida, tenant adicional, membership incompatível, órfã ou com versão
inválida bloqueiam a execução. Apply exige checkout limpo, confirmação, SHA exato, migration
presente, modo default-only e gate externo do banco. A transação é serializável.

## Critérios de aceite e plano de testes

Schema aditivo; um tenant default; uma membership active/version 1 por usuário ativo ou inativo;
roles fechadas; reexecução idempotente; evidência sem PII; nenhum endpoint/handler; testes unitário,
estático, build/typecheck, suites existentes e smoke PostgreSQL 16 com pós-diff vazio.

## Reconciliação

O ledger registra contagens de users por role/atividade, tenants, memberships por role/status,
ausências, órfãos, duplicidades, tenant default, tenants inesperados, hash agregado canônico e
duração. `result.tsv` é criado somente depois do commit e das pós-condições.

## Rollback

Desativar `TENANCY_MODE`; tabelas e memberships ficam inertes para o runtime legado. Não há DROP
automático. Correção ou remoção de dados requer plano e aprovação separados.

## Gates para 1.0B.2

Merge/checks reais; preview por SHA aprovado; migration aplicada separadamente por autoridade DBA;
preparação e ledger PASS revisados; backup/restore e incidentes avaliados; owners confirmados. Só
então planejar tenantização dos models, FKs compostas, repositories e provas A×B.

## Limitações probatórias

O teste usa apenas banco descartável e dados sintéticos. Esta PR não prova GitHub atual, produção,
deploy, aplicação da migration, restore real, isolamento cross-tenant ou prontidão multiempresa.
