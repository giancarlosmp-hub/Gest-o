# Sprint 1.0B.2-C — TenantContext e compatibilidade de autenticação

## Estado real e predecessores

O checkout fornecido não possui remote nem referência local `main`; antes da edição, a worktree
estava limpa e `HEAD=d3fa5b4`, merge da PR #784, cujo histórico contém `4f933f7`, merge da PR #783.
Assim, os dois predecessores exatos estão presentes no ancestry disponibilizado, mas checks/estado
remoto não são inferidos. A branch desta entrega nasceu diretamente desse HEAD.

## Inventário de autenticação, JWT e superfícies

- `authController.ts` é o emissor de access/refresh JWT no login e reemite access no refresh;
  `utils/jwt.ts` assina/verifica ambos. `auth.ts` consome access token; o refresh controller consome
  refresh token. O script sintético `pr18a2HttpRegression.ts` também assina tokens de teste.
- Os tokens atuais carregam `id`, `email`, `role` e `region`. Não há `iss`, `aud`, `jti`, tenant ou
  versão. Por risco de invalidar sessões e porque emissão global tenant-aware não está autorizada,
  emissão, refresh e validação JWT permanecem byte-for-byte no contrato legado.
- Middlewares: `auth`, `authorize(User.role)`, rate limit, request logging e validate. O auth é
  aplicado por routers, não globalmente. Nenhum middleware TenantContext foi instalado.
- `User.role` governa authorize, filtros de vendedor/gestor, dashboards, CRUD, plataforma e AI, e
  é consumido amplamente pelo frontend. Não houve substituição. `TenantMembership` era acessada
  apenas em preparação/default, testes e adapter control-plane; o novo resolver usa somente sua
  interface de leitura.
- Públicos: login/refresh, health/version, health, runtime health, debug, catálogo técnico e webhook
  Communications (este último tem rate limit/validação próprios). Autenticados: auth/me/logout,
  CRUD, dashboard, platform-health, UltraFV3, client lookup, AI e Communications. Internos são
  scripts operacionais/bootstrap; schedulers comercial e ERP rodam no processo API. Webhook e
  schedulers não fabricam TenantContext nesta subfase.
- `TENANCY_MODE` aceita `disabled` e `default-only`; produção declara somente `disabled`.
  `default-only` continua restrito ao tooling explícito de preparação, não ao runtime HTTP.

## Contrato canônico e resolução fail-closed

A implementação é estritamente **aditiva**. O contrato original `TenantContext`, os tipos
`TenantContextEvidence`/`TrustedTenantPrincipal`, `createTenantContext` e suas fontes confiáveis
`access_token`, `webhook_account`, `scheduler_job` e `platform_break_glass` permanecem disponíveis
com `requestId`, `membershipVersion`, `source`, `tenantRole` e `platformRole`. A validação
fail-closed de break-glass também foi preservada. O novo contrato de autenticação tem o nome
distinto `AuthTenantContext`, evitando reinterpretar consumidores anteriores.

`AuthTenantContext` contém `tenantId`, slug sanitizável opcional, `userId`, `membershipId`, status e
role da membership, `legacyUserRole`, `resolutionSource` e `contextVersion=1`. O objeto é congelado
e produzido apenas pelo resolver backend. A projeção de logs omite user, roles, slug, token, PII,
credenciais e payload empresarial.

O caller verifica criptograficamente o JWT antes de fornecer `VerifiedTenantClaims`. Para token
tenant-aware, o resolver exige conjunto completo/versionado de claims, tenant ativo e exatamente
uma membership ativa que coincida em tenant, user, ID e versão. Ausência, suspensão, revogação,
claim parcial/adulterada ou divergência falham fechadas. Header/body/query nem integram a API do
resolver e não podem selecionar tenant.

Para token legado, a compatibilidade precisa ser explicitamente `default-only`, receber o ID default
por configuração, encontrar exatamente uma membership ativa do usuário e confirmar que ela pertence
ao tenant configurado e ativo. Zero ou múltiplas memberships falham; não há primeiro item, fallback
silencioso nem ID hardcoded. A fonte é `legacy_default_only`. `active_membership` e
`synthetic_test` ficam reservadas para fluxos backend/testes explícitos; `tenant_claim` identifica
claims autenticadas.

## Matriz de autoridades

| Caminho | `User.role` | `TenantMembership.role` | Resultado |
|---|---|---|---|
| runtime legado disabled | autoridade atual | sem autoridade runtime | comportamento preservado |
| resolução tenant-aware em scaffolding | preservada como `legacyUserRole` | reconciliada no banco | divergência de identidade/claim nega; não muda RBAC legado |
| token legado default-only em teste/tooling | autoridade atual | exige membership ativa | contexto compatível, sem promover role de membership |
| fase futura tenant-required | ainda não ativada | política a decidir | adiada para 1.0B.2-D/RBAC posterior |

## Testes, gates e observabilidade

Fixtures em memória são exclusivamente sintéticas: tenants A/B ativos, suspenso, usuários A/B,
multi-membership, membership revogada, token legado e claims A/B/adulteradas. Elas provam A→A,
B→B, divergências negadas, inexistente/suspenso/revogado negados, legado inequívoco aceito,
ambiguidade negada, header ignorado como autoridade e concorrência sem compartilhamento de objeto.
O resolver é puro quanto a estado e depende de um reader injetado; por isso não requer Prisma nem
harness PostgreSQL nesta subfase.

O gate estático proíbe entrada HTTP, tenant default hardcoded, `memberships[0]`, contexto global,
logs sensíveis, ativação produtiva, integração em handlers e emissão JWT tenant obrigatória. Logs
permitidos expõem apenas IDs técnicos validados, request ID, source e versão.

O workflow **Docker Compose CI / compose-smoke** contém a etapa obrigatória
`Prove TenantContext auth compatibility`, executando `npm run test:tenant-context-auth` depois dos
gates de tenancy e antes dos smokes gerais, sem bypass, skip ou supressão de erro. `test:tenancy`
continua cobrindo repositories, administração, jobs, cache, webhook, SQL auditado, logs, scheduler
e break-glass anteriores; a nova suíte cobre somente AuthTenantContext A×B, reader e gate estático.

## Riscos, limitações e decisões adiadas

JWT ainda contém e-mail e não possui issuer/audience/jti; rotação/revogação segue em TD-ER-005.
TenantContext não está conectado ao HTTP, data access, webhook, scheduler ou cache. Não há
isolamento multiempresa, dual-read produtivo, RBAC empresarial, backfill, constraints finais, RLS
ou segundo tenant. A próxima subfase **1.0B.2-D** propagará data access por domínio somente após
review próprio; emissão tenant-aware e seleção/troca de tenant exigem gate separado.

## Rollback e produção

Rollback mantém `TENANCY_MODE=disabled`, remove/desabilita o scaffolding não obrigatório e preserva
tokens/autenticação legados. Não desfaz schema/migrations, não altera dados e não executa restore.
Não houve VPS, produção, deploy, DML, backfill ou cutover.
O scaffolding não foi instalado como middleware nem ativado globalmente.

`READY_FOR_1_0B_2_C_REVIEW = YES`  
`READY_FOR_TENANT_AWARE_RUNTIME = NO`  
`READY_FOR_BACKFILL_PRODUCTION = NO`  
`READY_FOR_MULTI_TENANT_CUTOVER = NO`  
`TENANCY_MODE = disabled`  
`PRODUCTION_ACCESSED = NO`
