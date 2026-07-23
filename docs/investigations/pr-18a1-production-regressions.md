# PR 18A.1 — investigação forense de regressões em produção

## Baseline Git local

Comandos executados antes das alterações:

- `git status --short`
- `git branch --show-current`
- `git rev-parse HEAD`
- `git log -20 --oneline --decorate`
- `git remote -v` / `git remote get-url origin`

Resultado: checkout isolado sem `origin` configurado. O commit local de baseline é `d53a01650972905584b5bf00be5f79b205f4cc84`, merge da PR #727 (`Merge pull request #727 ... recriar-fundacao-omnichannel-segura`). O histórico local contém PRs recentes #718 a #727; sem remote não foi possível validar estado remoto/CI/Preview.

## Evidências históricas encontradas

- PR #727: introduziu a fundação omnichannel segura; schema contém `CommunicationConversation`, `CommunicationMessage` e `CommunicationWebhookEvent` com `tenantId` ainda nullable, conforme `docs/communications/architecture-freeze-2026-07-21.md`.
- PRs #670/#680/#681/#688/#689: os comportamentos esperados aparecem preservados no código local por nomes e rotas: `startErpSyncScheduler`, `nextAutomaticRunAt`, `syncPartnersForAllConfiguredSellers`, `sellerChangedCount`, `ownerSellerId`, `LEGACY_ARCHIVED_DUPLICATE_PREFIX`, `isArchived` e filtros de busca pública.
- PR #721: adicionou `GET /ai/agenda-intelligence/day`; a rota ainda existe no `crudRoutes`, mas a resolução de vendedor retornava 403 para diretor/gerente sem `sellerId`.

## Scheduler UltraFV3

### Comportamento esperado

Scheduler automático deve iniciar no bootstrap da API quando `ERP_SYNC_SCHEDULER_ENABLED` e a configuração persistida estiverem habilitadas, recalcular `nextAutomaticRunAt`, não morrer após erro e aceitar credenciais globais ou credenciais por vendedor.

### Implementação encontrada

- Bootstrap chama `startErpSyncScheduler()` no `server.ts`.
- `env.ts` lê `ERP_SYNC_SCHEDULER_ENABLED`.
- `erpSyncScheduler.ts` mantém `nextAutomaticRunAt`, janela `America/Sao_Paulo`, estados `already_running`/lock e persistência em `ErpSyncRun`.
- `getAutomaticSyncConfigurationStatus()` aceita credenciais globais ou vendedor ativo com `erpLoginUsername`/`erpLoginPasswordEncrypted` quando somente `ULTRAFV3_USERNAME`/`ULTRAFV3_PASSWORD` faltam.

### Causa raiz provável

A evidência de produção “`ERP_SYNC_SCHEDULER_ENABLED` desabilitada” é compatível com variável externa desligada ou não propagada ao deploy. O código local inicializa o scheduler quando a flag está ligada; credenciais globais não são obrigatórias se houver credenciais por vendedor e as demais variáveis UltraFV3 estiverem configuradas.

### Correção aplicada

Não foram inventadas credenciais nem secrets. A PR mantém o fallback por vendedor e documenta que a correção operacional exige configurar `ERP_SYNC_SCHEDULER_ENABLED=true` no ambiente e conferir variáveis UltraFV3 não secretas/secretas usadas pelo client.

## Sincronização de clientes/partners

### Comportamento esperado

`/partners` deve importar clientes, usar código ERP como identidade prioritária, não duplicar em execução repetida, mudar `ownerSellerId` quando a carteira mudar no ERP, preservar histórico e ignorar duplicados legados arquivados nas buscas/matching.

### Implementação encontrada

- `syncPartnersForAllConfiguredSellers()` executa todos vendedores com credenciais configuradas e isola erro por vendedor.
- `syncPartnersByUser()` consulta `/partners` com credencial do vendedor.
- `persistPartnerPayload()` exige código ERP, faz matching por `code`, documento normalizado e identidade nome+cidade+UF apenas quando não há match forte.
- `mergeDuplicateClientsIntoPrimary()` move histórico para o primário e arquiva duplicados com prefixo `[ARQUIVADO ERP DUP]`.
- `GET /clients` filtra `isArchived: false`.

### Causa raiz provável

O código esperado ainda existe. Sem acesso à produção/ERP não é possível confirmar se o cliente ERP `5050` não retorna em `/partners`, retorna sob vendedor sem credencial, retorna com campos inesperados, ou foi afetado pela flag do scheduler desligada. O cenário mais consistente com os sintomas é configuração externa: scheduler desligado e/ou credenciais por vendedor/variáveis UltraFV3 ausentes no ambiente.

### Correção aplicada

Protegemos os fluxos existentes por smokes e não recriamos o algoritmo.

## Central do Dia — `GET /api/clients/alerts/cooling` 404

### Comportamento esperado

Home/Central do Dia chama `api.get("/clients/alerts/cooling")`, que vira `/api/clients/alerts/cooling` no backend.

### Implementação encontrada

Frontend chamava a rota, mas no backend havia `GET /clients` e depois `GET /clients/:id`; não havia rota `GET /clients/alerts/cooling` antes de `/:id`. Em Express, `/clients/:id` captura `alerts` e a rota final retornava 404.

### Causa raiz

Regressão de contrato backend/frontend: endpoint usado pelo frontend não estava registrado e era capturado por rota dinâmica.

### Correção aplicada

Criada rota `GET /clients/alerts/cooling` antes de `GET /clients/:id`, usando `sellerWhere`, `isArchived:false`, contrato `{ count, clients, items, days, generatedAt }` e retorno vazio válido.

## Agenda Intelligence — `GET /api/ai/agenda-intelligence/day` 403

### Comportamento esperado

Diretor e gerente devem acessar análise diária; vendedor acessa o próprio escopo.

### Implementação encontrada

A rota existe, mas `AgendaIntelligenceService.resolveSeller()` usava `input.sellerId || input.viewerUserId` para não vendedores e exigia que esse id fosse um usuário `role: vendedor`. Diretor/gerente sem `sellerId` recebiam 403.

### Causa raiz

Autorização/escopo no serviço, não middleware global. Diretor/gerente sem `sellerId` eram tratados como se o próprio usuário precisasse ser vendedor.

### Correção aplicada

Para vendedor, mantém escopo próprio. Para diretor/gerente com `sellerId`, valida vendedor ativo. Para diretor/gerente sem `sellerId`, seleciona primeiro vendedor ativo como default seguro e audível. Não remove middleware de segurança.

## Conteúdo em inglês no planejamento semanal

### Causa raiz

O prompt do enriquecimento AI do planejamento semanal não exigia explicitamente português do Brasil no JSON final; o fallback determinístico já estava em português.

### Correção aplicada

Prompt atualizado para exigir resposta sempre em português do Brasil, incluindo `summary` e `warnings`.

## Communications — próxima camada arquitetural

Após a proteção das regressões, a PR adiciona:

- `CommunicationIntegrationAccount` com unique por `tenantId + provider + channel + externalAccountId`, sem secrets.
- `CommunicationTenantResolver`, que resolve tenant/account após assinatura validada e nunca aceita `tenantId` do payload externo.
- `phoneNormalized`/`phoneHash` em `Contact`, `contactPhoneHash` nas tabelas communications e matching tenant-aware por hash determinístico `sha256(tenantId:phoneNormalized)`.

## Validações pendentes fora do checkout

- CI real, Preview e logs de startup dependem de publicação externa.
- Caso ERP 5050 (`COCAMAR CD`, Maringá/PR) exige acesso ao ERP/produção; não foi reproduzido localmente para evitar PII/secrets.
- Ambiente externo precisa confirmar `ERP_SYNC_SCHEDULER_ENABLED=true` e credenciais/variáveis UltraFV3 corretas, preferencialmente por vendedor quando globais não forem usadas.
