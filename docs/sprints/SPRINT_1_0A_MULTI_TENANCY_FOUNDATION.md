# Sprint 1.0A — Multi-Tenancy Foundation

**Estado:** 🔵 PR em 02/08/2026. **Não é implantação nem capacidade multiempresa.**
**Baseline local:** branch `work`, HEAD inicial `6bf00a5` (merge local da PR #770); worktree inicialmente limpo. Checks remotos/GitHub não foram inferidos e produção não foi acessada.

## Objetivo, problema e contexto

Formalizar a decisão arquitetural, modelar riscos e ownership e entregar contratos mínimos que tornem a futura expansão auditável e fail-closed. O Gest-o continua single-tenant: os quatro `tenantId` de Communications são parciais e não existe isolamento ponta a ponta nos demais models, JWT, Prisma, SQL, jobs, cache, ERP ou IA. A Sprint 0.6 inventariou essa lacuna e propôs a ADR 003; esta Sprint a revisa e aceita sob condições.

## Decisões fechadas

- schema PostgreSQL compartilhado, isolamento por linha, `Tenant` raiz, `TenantMembership`, tenantId em entidades empresariais, FK/unique compostas e RLS defensiva posterior;
- `TenantContext` imutável e tenant-required no data access; cliente nunca é autoridade de tenant;
- administração de plataforma separada da administração do tenant;
- expand/backfill/constrain/contract progressivos; nenhuma migration nesta Sprint;
- `User` permanece global e `email` globalmente único nesta evolução; permissões empresariais migram de `User.role` para membership;
- múltiplas memberships são permitidas, mas cada token carrega um tenant ativo explícito; troca emite token novo;
- `PlatformRole` é separado de `TenantRole`; tenant default é obrigatório durante compatibilidade;
- versão/revogação da membership e suspensão do tenant invalidam acesso; refresh deverá ser persistido e revogável.

## Fora do escopo

Tenancy transversal, alteração dos 27 models, migration/backfill/RLS, CRM/repositories existentes, deploy/produção, segundo tenant, piloto ou anúncio comercial. Não corrigimos os 216 handlers nem a falha preexistente de `calculateTodayPriorities.test.ts`.

## Modelo de control plane (desenho para 1.0B)

### `Tenant`

| Campo | Tipo/regra | Justificativa |
|---|---|---|
| `id` | String/CUID, PK, imutável | identidade canônica |
| `slug` | String, unique global, imutabilidade controlada | roteamento/control plane, não autoridade cliente |
| `legalName` | String | identificação jurídica |
| `displayName` | String | apresentação |
| `status` | `active/suspended/archived` | lifecycle fail-closed |
| `createdAt`, `updatedAt` | timestamps | auditoria de ciclo |
| `suspendedAt` | nullable | evidência da suspensão |

`metadata` não entra no modelo inicial: sem caso mínimo aprovado, JSON arbitrário esconderia contrato e PII. Configuração empresarial terá modelo próprio. Alternativas database-per-tenant e tenant inferido foram rejeitadas na ADR.

### `TenantMembership`

| Campo | Tipo/regra | Justificativa |
|---|---|---|
| `id` | String/CUID, PK | identidade da concessão |
| `tenantId`, `userId` | FKs; unique composto | relação canônica, uma membership por par |
| `role` | `diretor/gerente/vendedor` inicialmente | migração compatível do RBAC atual |
| `status` | `invited/active/revoked` | lifecycle explícito |
| `createdAt`, `updatedAt` | timestamps | trilha temporal |
| `invitedAt`, `acceptedAt`, `revokedAt` | nullable e coerentes com status | evidência de lifecycle |
| `version` | inteiro positivo, incrementado em mudança de autorização | invalidação de token/sessão |

Um usuário pode ter várias memberships, sem “tenant default” implícito no `User`; a implantação terá exatamente o tenant default de compatibilidade. `User.role` permanece temporariamente para código legado, mas a autoridade futura é `TenantMembership.role`. `PlatformRole` vive em concessão de plataforma separada, não na membership. Alternativas de role global e seleção silenciosa foram rejeitadas.

## Contrato imutável de TenantContext

Campos: `tenantId`, `userId`, `membershipId`, `tenantRole`, `platformRole?`, `requestId`, `membershipVersion`, `source`. Fontes permitidas: access token validado; webhook resolvido por conta externa verificada; job de scheduler tenant-aware; break-glass de plataforma auditado. Proibidos: body, query, `X-Tenant-Id`, sellerId, branch ERP, accountId não validado e cookie arbitrário.

Fail-closed: contexto ausente/inválido, membership ausente/revogada/divergente/versionada, ou tenant suspenso são negados. Recurso de outro tenant retorna 404 por padrão para reduzir enumeração; 403 é reservado a recurso já revelado/política documentada. Operação global usa interface distinta. O scaffolding default-only valida registros por porta injetada; ainda não está conectado aos handlers porque tabelas e memberships não existem.

## Tokens, sessão e autorização futuros

Access token validará assinatura e claims `sub`, `tenant_id`, `membership_id`, `tenant_role`, `platform_role?`, `membership_version`, `aud`, `iss`, `exp`, `jti`. O token identifica seleção, mas status/version atuais continuam sendo autoridade conforme política de risco/cache curto. Refresh usa sessão persistida, hash do token, rotação one-time, família, detecção de replay, revogação/logout real, tenant selecionado e membership version. Replay revoga a família.

Usuários atuais recebem membership no tenant default. Tokens legados só resolvem esse tenant durante janela curta, explícita e observada; refresh emite formato novo. Não há seleção por header. Troca de tenant exige endpoint autenticado, membership ativa e novo par de tokens; o token anterior não muda. Respostas de negócio não precisam expor `tenantId`.

Autorização avalia em ordem: autenticação/token → tenant lifecycle → membership/version → tenant role → política do objeto com predicado tenant. Platform role não concede automaticamente acesso empresarial.

## Administração de tenant e plataforma

**Tenant:** memberships/usuários daquele tenant, configurações, integrações e negócio, via TenantContext e TenantRole. **Plataforma:** criar/suspender tenant, manutenção, billing futuro, auditoria global, suporte e break-glass, por namespace/rotas/services separados e PlatformRole.

Toda ação de plataforma registra `auditId`, ator, tenant-alvo, ação, requestId, motivo obrigatório, aprovação quando aplicável, início/fim e resultado, sem token/PII desnecessária. Break-glass é just-in-time, menor privilégio, expira rapidamente, não renova silenciosamente e alerta/revisa acesso; leitura silenciosa é proibida. Endpoints comuns de negócio jamais recebem bypass global.

## Ownership — RACI

Legenda: **A** accountable (um por atividade), **R** executa, **C** consultado, **I** informado.

| Atividade | PO | CTO/Arq | Seg | DBA | BE | FE | DevOps | QA | Operação | LGPD/Jur | Suporte |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ADR | C | A/R | C | C | C | I | I | I | I | C | I |
| migration | I | C | C | A/R | R | I | C | C | I | I | I |
| backfill | I | C | C | A | R | I | C | R | C | C | I |
| reconciliação | I | C | C | A | R | I | I | R | C | I | I |
| TenantContext | I | A | C | I | R | C | I | R | I | I | I |
| JWT/membership | I | C | A | C | R | C | I | R | I | C | I |
| repositories | I | A | C | C | R | I | I | R | I | I | I |
| RLS | I | C | C | A/R | C | I | C | R | I | I | I |
| ERP | C | A | C | C | R | I | C | R | C | I | I |
| webhooks | I | A | C | I | R | I | C | R | C | C | I |
| IA | C | A | C | I | R | C | I | R | I | C | I |
| observabilidade | I | C | C | I | R | I | R | C | A | C | C |
| restore | I | C | C | A | I | I | R | R | C | C | I |
| incidente cross-tenant | I | C | A | R | R | I | R | C | R | C | C |
| rollout | A | C | C | C | R | R | R | R | R | C | C |
| rollback | I | C | C | R | R | I | R | C | A | I | I |
| piloto | A | C | C | I | R | R | R | R | R | C | R |

Papéis, não pessoas, são designados porque o repositório não contém nomes aprovados. Ausência real de ocupante bloqueia o gate correspondente.

## Implementação mínima e testes arquiteturais

Foram adicionados tipos e factory sem Express/Prisma, porta de leitura do control plane, feature option `defaultOnly`, interface `TenantRepository`, interface distinta de plataforma e contratos para job, cache, webhook e SQL auditado. Não há schema/migration/seed de tenant.

A prova comportamental cobre contexto imutável, tenant inválido/outro, suspensão, membership ausente/revogada/versionada, break-glass, repository, cache, job, webhook e SQL. O lint estático limita-se ao novo diretório — propositalmente não corrige legado — e bloqueia body/query/header, Prisma global, repository sem TenantContext, cache/job sem namespace/tenant.

## Riscos, dependências e rollback

Riscos principais: scaffolding ser confundido com enforcement, factory não integrada, owners sem ocupantes, sessão ainda stateless, banco global e integrações não isoladas. Dependências: incidentes/P0 existentes, restore, Segurança, DBA, SLO e aprovação humana dos papéis. Rollback desta Sprint é reverter o commit de código/documentação; não há rollback de banco/runtime porque nada foi aplicado.

## Critérios de aceite e testes

ADR aceita com condições; threat model STRIDE completo; RACI; modelos e contratos; separação administrativa; testes novos; plano 1.0B; readiness/tech debt atualizados; Multiempresa 🔴; nenhuma migration, produção ou segundo tenant. Executar build, typecheck, segurança e smokes de produção (estáticos), tenancy, diff, links, estado ADR e buscas exigidas.

## Gates para Sprint 1.0B

1. PR 1.0A revisada/mesclada e owners reais confirmados por papel.
2. Threat model e desenho de sessão aprovados por Arquitetura/Segurança/LGPD; risco residual registrado.
3. DBA aprova ordem, locks, reconciliação, quarantine, backup/restore e autoridade ADR 002.
4. Fixtures e PostgreSQL descartável prontos; preview demonstra apenas DDL aditiva.
5. Tenant default e mapeamento de roles determinísticos aprovados; nenhum segundo tenant.
6. Rollback/feature flag/default-only e critérios de abortar aprovados.
7. Incidentes e débitos permanecem conforme fontes oficiais; não inferir produção pelo merge.

## Documentação

Fontes: ADR 003, threat model, plano expand, assessment, Documento Mestre, Status Atual, Enterprise Readiness e Tech Debt. `OPERACAO.md` e `DEPLOY_GUIDE.md` não mudam: não surgiu procedimento nem deploy.
