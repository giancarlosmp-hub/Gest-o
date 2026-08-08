# Sprint 1.0B.1-GATE — readiness para a 1.0B.2

## Objetivo

Certificar, sem iniciar a implementação da 1.0B.2, quais condições permitem abrir seu
desenvolvimento e quais pertencem apenas ao futuro cutover multiempresa. Esta auditoria é
documental e estática: não acessou produção, não executou DDL, DML ou deploy e não usa Git como
prova do estado produtivo.

## Estado de partida

- O `HEAD` local é `61b8844`, merge commit da PR #780. O histórico local, portanto, comprova que o
  conteúdo da PR foi incorporado ao checkout recebido. O repositório não possui remote configurado
  e o acesso não autenticado ao GitHub foi bloqueado pelo proxy; `origin/main` e os checks remotos
  reais do merge são **NOT PROVEN**, não inferidos.
- A fonte canônica do estado operacional é a certificação OP-EXEC, não o Git: migration
  `20260802120000_tenancy_control_plane` aplicada e revalidada como `ALREADY_APPLIED`, control plane
  presente, um tenant, oito Users, oito memberships, reconciliação e cleanup aprovados.
- `DATABASE_SCHEMA_MODE=external`, `TENANCY_MODE=disabled`, nenhum cutover e Multiempresa inativo.
- A marca histórica `READY_FOR_1_0B_2 = NO` significava “certificação integrada e aprovação ainda
  não realizadas”; ela não significa que SLA, RLS ou um segundo tenant produtivo sejam pré-requisitos
  para escrever a fase expand.

## Evidência da 1.0B.1

| Evidência canônica recebida | Resultado |
|---|---|
| Migration registrada/aplicada/revalidada | `PASS/APPLIED_ONCE`; depois `PASS/ALREADY_APPLIED` |
| Catálogo | `Tenant`, `TenantMembership`, três enums, duas PKs, quatro índices, duas FKs e dois CHECKs |
| Diff | managed post-diff com 0 bytes; objetos `incident_*` preservados |
| Preparação | somente `tenant-default-v1` / `default-v1`; 8 memberships para 8 Users |
| Integridade | zero ausência, órfã, duplicidade, referência inválida ou tenant inesperado |
| Reconciliação | hash final igual ao `expectedAggregateHash` do dry-run |
| Autoridade temporária | removida; `TEMP_ROLE_COUNT=0`, `TEMP_HBA_COUNT=0` |
| Runtime/cutover | external + disabled; nenhum cutover e nenhum segundo tenant |

Os números acima são transcrição da evidência operacional já aceita na OP-EXEC. Esta auditoria não
reconsultou produção.

## Matriz de gates

`PASS` significa comprovado pelas fontes/código; `FAIL`, requisito não atendido; `NOT PROVEN`, sem
evidência suficiente. “Bloqueia dev” se refere somente à abertura da 1.0B.2.

| Gate | Origem | Requisito | Estado/evidência | Resultado | Bloqueia dev? | Ação mínima |
|---|---|---|---|---|---|---|
| Foundation 1.0A | Brief 1.0A, ADR 003, threat model | desenho, RACI e contratos aceitos | ADR aceita; STRIDE, `TenantContext` contratual e plano expand existem | PASS | não | preservar condições no aceite da 1.0B.2 |
| Control plane persistence | Brief 1.0B.1, schema e migration | raiz, membership, enums, checks, FKs, índices e preparação | catálogo e harness cobrem todos os objetos; evidência operacional confirma presença | PASS | não | não alterar a migration histórica |
| Control plane operation | OP-EXEC/#780 | fases, reconciliação, cleanup e runtime disabled | certificação canônica registra PASS e cleanup zero | PASS | não | preservar evidência; Git não a substitui |
| Runtime safety | ADR 002, Compose, OP-EXEC | sem integração parcial ou preparação implícita | Compose fixa external/disabled; bootstrap não importa tenancy/preparation; runtime legado não depende do control plane | PASS | não | manter disabled durante expand |
| Auth/JWT baseline | 1.0A e assessment | baseline inventariada e transição compatível definida | payload legado confirmado; estratégia abaixo mantém compatibilidade | PASS | não | implementar somente na fase própria da 1.0B.2 |
| Tenant context runtime | ADR 003/1.0A | reconhecer ausência de enforcement atual | factory/contratos existem, mas não são middleware nem usados pelos handlers | FAIL | não, é escopo da 1.0B.2 | integrar de forma fail-closed após expand/backfill |
| Data-access inventory | assessment/schema | confirmar domínio e dependências | 28 models empresariais/auditoria/integracão inventariados abaixo; nenhum central tem `tenantId`; quatro Communications são parciais | PASS | não | usar inventário como baseline de expand |
| Uniques | assessment/schema | classificar globais e decisões | inventário abaixo separa global, tenant-scoped e decisão | PASS | não | resolver decisões antes do constrain de cada grupo |
| Inativos/membership | OP-EXEC e auth | definir compatibilidade | decisão registrada abaixo: `User.isActive` continua gate superior de autenticação | PASS | não | não sincronizar dados nesta Sprint |
| Default tenant identity | control-plane preparation | identidade estável | ID/slug determinísticos comprovados | PASS | não | reservá-los até o fim de contract |
| Primeira migration expand | migration plan | definir conteúdo, sem criá-la | contrato exato definido abaixo | PASS | não | Comitê aprovar antes da criação |
| Rollback por subfase | ADR 002/plano expand | estratégia forward-compatible | matriz abaixo cobre expand a cutover | PASS | não | anexar comandos/evidência à futura operação |
| Jobs/integrações | threat model/assessment | inventário e futuro envelope tenant-aware | schedulers ERP/comercial, sync in-process, WhatsApp/webhooks e Communications inventariados | PASS | não | proibir execução tenantless quando modo for ativado |
| RLS | ADR 003/plano expand | reconhecer ausência e gate correto | nenhuma policy/RLS atual; gate posterior ao data access e A×B | FAIL | não | implementar na Sprint 1.0E/enforce, antes do cutover |
| Segundo tenant/A×B | threat model/roadmap | não existir em produção agora; plano de prova | evidência OP-EXEC confirma exatamente um; suíte futura definida | PASS | não | criar A/B apenas em fixture descartável da 1.0B.2 |
| Incidentes | Documento Mestre/ER/OP-EXEC | avaliar relação concreta | incidentes são legados ERP/recuperação; nenhum impede DDL expand aditiva | PASS | não | manter estados e gates próprios |
| Enterprise genérico | Enterprise Readiness | não confundir GA com desenvolvimento | SLA/on-call/continuidade permanecem não comprovados | FAIL | não | fechar antes de piloto/GA, não antes de expand |
| Checks da PR #780 | governança/OP-EXEC | checks reais do merge | merge commit local existe; GitHub indisponível neste ambiente | NOT PROVEN | não retroativamente | responsável com acesso anexar URL/status dos checks |
| Aprovação específica do Comitê | governança e OP-EXEC | aprovar escopo, ordem e abort criteria da 1.0B.2 | esta auditoria fornece o pacote, mas nenhuma aprovação foi concedida | FAIL | **sim** | registrar aprovação nominal de Arquitetura, Segurança, DBA, QA e Operação |

## Gates de desenvolvimento

Para abrir a Sprint 1.0B.2 são necessários: (1) esta baseline revisada; (2) escopo estritamente
expand/default-only; (3) runtime disabled; (4) primeira migration aditiva revisada antes de merge;
(5) owners e critérios de abortar; e (6) aprovação específica do Comitê. Os cinco primeiros estão
definidos/comprovados nesta auditoria. O sexto ainda não ocorreu.

Não são gates de abertura: segundo tenant produtivo, RLS habilitada, `tenantId NOT NULL`, remoção de
uniques globais, troca de JWT em produção, cutover, piloto, SLA, on-call ou classificação Enterprise.

**Único bloqueador de abertura:** decisão formal do Comitê sobre este pacote. Não há gap técnico de
persistência/operação que exija outra Sprint intermediária; a aprovação não pode ser presumida por
esta PR.

## Gates de cutover

Antes de `default-only` sair de `disabled` e, depois, antes de tráfego multiempresa, ainda serão
obrigatórios: backfill e reconciliação completos; zero nulos/mismatch; FKs e uniques compostas;
TenantContext real; JWT/sessão e RBAC tenant-aware; handlers, raw SQL, caches, jobs, webhooks e ERP
fail-closed; RLS defensiva e role sem bypass; testes A×B/IDOR; restore e rollback ensaiados; métricas,
alertas e runbooks; aprovação Segurança/LGPD/DBA/Operação; piloto controlado. Portanto todos esses
itens continuam bloqueando **cutover**, não a migration expand inicial.

## Auth/JWT

| Superfície atual | Contrato confirmado | Tenant hoje? | Estratégia compatível |
|---|---|---|---|
| Login | busca global por `email`; rejeita usuário ausente/inativo; compara senha | não | manter resposta legada durante janela; selecionar somente membership default ativa no novo fluxo |
| Access token | `{ id, email, role, region }`, segredo de access, expiração configurável (12h default) | não | aceitar formato legado somente em default-only observado; novo token usa claims canônicos da ADR |
| Refresh token | mesmo payload, cookie HTTP-only SameSite=Lax, expira em 7 dias; sem store/rotação/família | não | introduzir sessão persistida, hash, rotação one-time, replay/revogação e tenant selecionado |
| Middleware | verifica Bearer e copia payload para `req.user` | não | resolver `TenantContext` exclusivamente de token/membership validada, nunca body/query/header |
| `/me` | relê User e devolve id/nome/email/role/region/isActive | não | preservar campos; adicionar contexto de forma versionada, sem trocar silenciosamente `role` |
| RBAC | `User.role` legado (`admin`, `diretor`, `gerente`, `vendedor`) | não | manter durante compatibilidade; autoridade empresarial futura é `TenantMembership.role` |

`User.role=admin` não deve virar `TenantRole`: administração de plataforma exige concessão
`PlatformRole` separada e break-glass auditado. Para diretor/gerente/vendedor, membership será a
autoridade nova; durante dual-read, divergência bloqueia e gera métrica, em vez de escolher a maior
permissão. `User.role` não será removido na 1.0B.2.

## Tenant Context

Existe um **contrato/scaffolding**, com factory imutável, validação de tenant/membership/version e
fontes confiáveis. Não existe `TenantContext` real no runtime: Express não o carrega, auth não emite
claims tenant, controllers/services usam Prisma global e os schedulers não carregam envelope tenant.
Logo, isolamento atual é inexistente; não se deve interpretar os testes unitários do scaffolding como
enforcement. A integração é escopo explícito da 1.0B.2, não desta certificação.

## Models empresariais

O schema atual tem `User`, dois models de control plane e **27 models empresariais centrais**, dos
quais quatro Communications já possuem `tenantId` parcial. A referência antiga a “23 models” cobre
o núcleo anterior a Communications; o inventário abaixo não omite os quatro models adicionados.
`Tenant`/`TenantMembership` aparecem separadamente porque são control plane, não linha empresarial.

| Model | `tenantId`? | Relação Tenant? | Unique global atual? | Índice relevante atual? | Classe futura | Prioridade | Risco |
|---|---|---|---|---|---|---|---|
| User | não | memberships | email | role/isActive/ERP | identidade global + membership | P0 | identidade/RBAC |
| KnowledgeDocument | não | não | não | category/source/active | tenant-bound (ou catálogo separado) | P3 | vazamento IA |
| Client | não | não | code, document? | owner/archive/ERP | tenant-bound | P0 | PII/ERP/IDOR |
| ClientCodeAudit | não | não | não | client/time/request | tenant-bound | P1 | auditoria cruzada |
| AgendaEvent | não | não | não | seller/client/datas | tenant-bound | P1 | FK transitiva |
| AgendaStop | não | não | agendaEvent+order | agenda/order | tenant-bound | P1 | rota cruzada |
| Contact | não | não | phoneHash combinações | client/owner/hash | tenant-bound | P1 | PII/telefone |
| Opportunity | não | não | não | client/owner/stage/date | tenant-bound | P0 | negócio/IDOR |
| OpportunityChangeLog | não | não | não | opportunity/time | tenant-bound | P1 | histórico cruzado |
| TimelineEvent | não | não | não | client/opportunity/time | tenant-bound | P1 | timeline cruzada |
| Activity | não | não | não | owner/due/relations | tenant-bound | P1 | atribuição cruzada |
| Goal | não | não | seller+month | seller/month | tenant-bound | P2 | colisão mensal |
| ActivityKPI | não | não | seller+month+type | seller/month | tenant-bound | P2 | métrica cruzada |
| Sale | não | não | não | seller/date | tenant-bound | P2 | agregado cruzado |
| SellerTerritoryCity | não | não | seller+state+city | seller/local | tenant-bound | P2 | território cruzado |
| AppConfig | não | não | key | não | tenant-bound; separar platform config | P0 | configuração global |
| CultureCatalog | não | não | code/name | active/name | global read-only + override futuro | P3 | decisão de catálogo |
| Product | não | não | códigos ERP | name/active | tenant-bound | P1 | colisão ERP |
| ProductPrice | não | não | combinações produto/tabela | product/branch | tenant-bound | P1 | preço vazado |
| OpportunityItem | não | não | opportunity+line | opportunity/product | tenant-bound | P1 | FK transitiva |
| ErpOrderSync | não | não | `pedidoIdImportacao` | opportunity/status/order | tenant-bound | P0 | idempotência cruzada |
| ErpSyncRun | não | não | não | scope/status/seller/time | tenant-bound | P0 | observabilidade/job |
| ErpSyncLock | não | não | scope/PK | scope | tenant-bound | P0 | lock global |
| CommunicationIntegrationAccount | sim | não | tenant+provider+channel+account | tenant/status | tenant-bound | P0 | sem FK Tenant |
| CommunicationConversation | opcional | não | provider/account/conversation | tenant/client/seller | tenant-bound | P0 | evento sem resolução |
| CommunicationMessage | opcional | não | provider/account/message | tenant/conversation/time | tenant-bound | P0 | mensagem cross-tenant |
| CommunicationWebhookEvent | opcional | não | provider/account/event | tenant/status/time | tenant-bound | P0 | replay/ingestão |

Propagação transitiva obrigatória: raízes (`AppConfig`, contas de integração, Client e identidade via
membership) antes dos filhos; Client antes de Contact/Agenda/Timeline; Opportunity antes de itens,
logs, eventos e pedidos; Product antes de ProductPrice/OpportunityItem; conta externa verificada
antes de conversation/message/webhook; o ERP nunca infere tenant de filial, seller ou conteúdo.

## Unique constraints

- **Permanece global:** `Tenant.slug`; IDs de Tenant; e-mail de User durante a compatibilidade (a
  identidade continua global até ADR posterior); códigos do catálogo canônico de culturas;
  migration ledger e metadados de plataforma.
- **Deverá virar tenant-scoped:** `AppConfig.key`; códigos/identidades de Client; Goal/KPI por
  seller/mês; território; códigos ERP de Product; combinações de ProductPrice; linha de Opportunity;
  `pedidoIdImportacao`; lock/scope ERP; chaves de provider/account/message/event em Communications.
- **Precisa decisão arquitetural antes do constrain do grupo:** e-mail global versus identidade por
  tenant; CNPJ/documento (deduplicação de plataforma não pode conceder acesso); número do pedido e
  sequence ERP; CultureCatalog global versus override; external IDs compartilhados por filial.

Durante expand, a unique global existente não é removida. Primeiro são criados índices compostos,
consumidores migram e colisões são analisadas; remoção ocorre somente em constrain/contract aprovado.

## Background jobs

Inventário: `erpSyncScheduler` e `commercialAutomationsScheduler` iniciados dentro da API; syncs
UltraFV3 manuais/agendados e job assíncrono in-process; lock/run/order ERP; automações comerciais;
WhatsApp/Communications, webhook público e ingestão de mensagens; notificações de saúde; scripts
administrativos/smokes (fora do runtime). Não foi encontrada fila/worker externo persistente.

Contrato futuro: scheduler enumera tenants ativos e enfileira `TenantJobEnvelope`; lock, idempotency
key, run e métricas começam por `tenantId`; webhook resolve conta externa verificada antes de ler o
payload; retries preservam tenant; processamento sem contexto vai para quarentena; credencial/token
ERP e cache ficam tenant-scoped. Jobs globais usam interface de plataforma separada e allowlist.

## RLS

Não há `ENABLE ROW LEVEL SECURITY`, policy ou configuração de sessão tenant no schema/migrations.
RLS é defesa adicional da fase **1.0E/enforce**, após repositories/raw SQL tenant-aware, pool capaz
de limpar contexto, role runtime sem `BYPASSRLS` e testes A×B verdes. Não pertence à primeira
migration expand da 1.0B.2 e continua obrigatória antes do cutover multiempresa.

## Testes A×B

O primeiro segundo tenant será sintético e descartável no harness PostgreSQL/testes de integração
da 1.0B.2; não em produção. A suíte deve provar, para API, repository e raw SQL: A não lista/lê B e
vice-versa; ID conhecido retorna 404/nega; filtros, contagens e agregações não misturam; create/update/
delete/connect rejeitam relações cross-tenant; uniques iguais coexistem quando tenant-scoped;
membership revogada/versionada falha; troca de tenant gira sessão; webhook resolve conta; scheduler,
retry, cache, lock, websocket (se introduzido) e job preservam contexto. RLS terá repetição da matriz
com role runtime real e teste de pool/context leakage.

## Usuários inativos

A criação de membership `active` para os três Users inativos é **compatibilidade intencional do
backfill**, não autorização para login. `User.isActive=false` continua bloqueando autenticação e é
um gate superior à membership. Membership expressa vínculo/role; User expressa capacidade global de
autenticar. Na 1.0B.2, eventos de desativação devem revogar sessões imediatamente e um reconciliador
deve detectar `User inactive + membership active`; ele pode manter o vínculo para histórico, sem
permitir acesso. Sincronização automática de status só poderá ocorrer após política de lifecycle e
auditoria; não se alteram os oito registros produtivos nesta Sprint.

## Default tenant

`tenant-default-v1` (ID) e `default-v1` (slug) são identidade reservada e imutável durante expand,
migrate e contract. Não devem ser regenerados, renomeados, reutilizados ou inferidos de ambiente.
O default é ponte de compatibilidade, não fallback para contexto ausente. Depois do cutover ele é um
tenant comum quanto ao isolamento, mas sua identidade permanece reservada para rastreabilidade.

## Migration strategy

A primeira migration da 1.0B.2 será **somente expand estrutural, sem backfill**: adicionar coluna
`tenantId String?` com FK `ON DELETE RESTRICT ON UPDATE CASCADE` para `Tenant.id` às raízes do primeiro
grupo (`AppConfig`, `Client`, `CommunicationIntegrationAccount`, `ErpSyncRun` e `ErpSyncLock`) e os
índices tenant-first/índices parciais de nulos necessários. Communications preserva a coluna
existente e recebe apenas FK/índice compatível. A migration não cria tenant, não atualiza linhas,
não torna coluna NOT NULL, não remove unique global, não altera auth/handlers e não habilita modo.

Antes de escrever SQL, a 1.0B.2 deve confirmar no Comitê se `ErpSyncRun/Lock` entram nesse primeiro
lote ou no lote ERP seguinte; se a decisão for separar, a migration inicial fica restrita às três
raízes. Essa decomposição não muda a regra “pais antes de filhos”. Nome proposto, somente após
aprovação: `*_tenancy_business_roots_expand`.

## Rollback

| Subfase futura | Rollback/abort seguro |
|---|---|
| nullable `tenantId`/índices | abortar antes do apply; depois manter objetos aditivos inertes e runtime disabled; nunca DROP automático |
| backfill | parar writers/jobs, usar ledger idempotente para desfazer/reclassificar atribuições e quarentenar ambiguidades |
| constraints/uniques | não promover se houver nulo/mismatch/colisão; manter constraint global até consumidores migrarem; rollback de código |
| TenantContext | flag volta a disabled/default-only; tokens legados continuam apenas na janela definida; não relaxar fail-closed |
| handlers/repositories | rollback por release mantendo schema forward-compatible; interromper dual-write inconsistente |
| enforce/NOT NULL/FKs | não aplicar sem duas releases compatíveis; correção forward, janela/restore separados se dados forem afetados |
| RLS/cutover | kill switch somente para contenção sem servir tráfego; reverter release/roteamento, preservar dados e acionar incidente; restore nunca automático |

Cada promoção exige backup/checksum, preview, reconciliação, métricas de lock/WAL/latência e critérios
de abortar. Reverter Git não reverte banco.

## Observabilidade

Logs/métricas futuros podem conter `tenantId`, `tenantSlug` reservado, `membershipId`, source do
contexto, request/correlation/job ID, operação, resultado e duração. Não podem conter e-mail, nome,
telefone, documento, payload, token, URL de banco ou credencial ERP. IDs devem passar allowlist de
formato; dashboards agregam por tenant e alertam contexto ausente, mismatch, cross-tenant denial,
legacy-token usage, nulos/backfill, RLS denial e job sem envelope. Slug só deve ser emitido quando
classificado como identificador operacional não sensível; preferir ID interno nas métricas.

## Incidentes

| Incidente | Estado canônico | Relação com tenancy | Bloqueia 1.0B.2? | Justificativa |
|---|---|---|---|---|
| `INC-5050-4484` | em homologação | identidade/filiais ERP podem influenciar external IDs | não | expand nullable não depende do fechamento; não usar filial para inferir tenant |
| `INC-ERP-5050` | recuperação funcional; causa ainda investigada | sync/identidade ERP precisa namespace futuro | não | requer testes ERP tenant-aware antes do cutover, não antes de adicionar colunas |
| `INC-PROD-2026-07` | corrigido aguardando encerramento, estabilidade e restore | restauração/rollback são gate operacional | não para dev; sim para promoção/cutover | schema expand é preparado em ambiente descartável; produção exige gate próprio |
| recuperação `ProductPrice`/clientes históricos | estado final documentado, hardening pendente | filhos/órfãos afetam backfill | não para abrir; sim para backfill do grupo | reconciliação e quarentena devem bloquear atribuição ambígua |

Nenhum incidente é usado como bloqueio genérico. Seus estados não são alterados por esta auditoria.

## Tech Debt

- **TD-ER-004:** risco macro de isolamento transversal; permanece aberto até o roadmap completo.
- **TD-ER-004A:** assessment/desenho/ADR/threat model da fundação; parcela documental concluída, mas
  os controles só encerram quando integrados e provados.
- **TD-ER-004B:** control plane default-only; persistência e operação estão concluídas, enquanto a
  expansão empresarial permanece aberta.
- A **Sprint 1.0B.2 corresponde à parcela expand/backfill de TD-ER-004B/TD-ER-004**, não a RLS,
  cutover ou encerramento integral de TD-ER-004.

## Enterprise Readiness

Suporte, SLA, on-call, continuidade, billing/onboarding, RPO/RTO aprovado e classificação Enterprise
continuam incompletos. Isso não impede tecnicamente desenvolver schema nullable, backfill tooling e
contexto atrás de flag. Bloqueia piloto/GA/cutover conforme o risco e contratos envolvidos. Segurança
de isolamento, restore e resposta operacional tornam-se gates técnicos somente na promoção que
possa servir ou escrever dados multiempresa.

## Governança

Checklist da aprovação específica, a ser registrado com nomes/data/decisão (esta PR não o aprova):

- [ ] Arquitetura aceita limites da 1.0B.2, grupos de dependência, globais e decisões de unique.
- [ ] Segurança/LGPD aceita threat model atualizado, compatibilidade de token e logging sem PII.
- [ ] DBA aceita primeira migration, locks, índices, FK, backfill/ledger/quarentena e rollback.
- [ ] QA aceita fixtures A/B descartáveis, matriz negativa e critérios de reconciliação.
- [ ] Operação/Release aceita `TENANCY_MODE=disabled`, preview, evidências e critérios de abortar.
- [ ] Produto/TPM confirma que não haverá segundo tenant produtivo, anúncio ou cutover nesta Sprint.
- [ ] Comitê registra `APPROVED`, `APPROVED_WITH_CONDITIONS` ou `REJECTED`, owners, condições e prazo.
- [ ] Checks do SHA candidato e revisão humana são anexados antes do merge da futura migration.

## Riscos

Principais riscos: confundir scaffolding com enforcement; migration grande demais; inferir tenant de
seller/filial/conta; colisões globais ocultas; dual-read permissivo; jobs/caches sem namespace; nulos
servidos; RLS com bypass/context leak; e promover por evidência Git sem prova operacional. Mitigações:
grupos pequenos, default-only/disabled, ledger e hashes, fail-closed, A×B, revisão DBA/Segurança e
promoções independentes.

## Decisão final

`READY_FOR_1_0B_2_DEVELOPMENT = NO`

O control plane e o pacote técnico/documental estão aptos; não foi encontrado bloqueador técnico
adicional a corrigir nesta Sprint. A abertura formal continua bloqueada exclusivamente porque a
aprovação específica do Comitê, explicitamente exigida pela 1.0A e OP-EXEC, ainda não existe. Esta
PR entrega o checklist e não pode autoaprovar seu próprio resultado.

`READY_FOR_MULTI_TENANT_CUTOVER = NO`

O cutover permanece bloqueado por ausência deliberada de tenant boundary no domínio, TenantContext
runtime, JWT/sessão tenant-aware, backfill/constraints, RLS, provas A×B, segundo tenant sintético
validado, restore/rollback e readiness operacional. Nenhum desses itens deve ser implementado nesta
certificação.

### Escopo proposto da 1.0B.2 após aprovação

1. Regenerar inventário e fechar decisões de globais/uniques do primeiro grupo.
2. Criar/testar a migration aditiva nullable de raízes, sem DML e com runtime disabled.
3. Criar runner de backfill default-only dry-run/apply, ledger, batches, hashes e quarentena.
4. Propagar `tenantId` por grupos pais→filhos com FKs/índices aditivos, sem NOT NULL/contract.
5. Integrar TenantContext e novo contrato de sessão/JWT atrás de compatibilidade explícita.
6. Migrar repositories/handlers/raw SQL/jobs/webhooks/caches por domínio, fail-closed.
7. Criar fixtures A/B exclusivamente descartáveis e testes negativos; não criar tenant produtivo.
8. Entregar relatório de reconciliação e gates para a fase constrain/enforce posterior.
