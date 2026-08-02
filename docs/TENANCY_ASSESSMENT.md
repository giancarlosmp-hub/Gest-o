# Enterprise Multi-Tenancy Assessment — Sprint 0.6

**Baseline:** branch local `work`, `HEAD b9edd86178fe2ba5f86a4af00a04b7fdef5406de`, em 02/08/2026.
Não existe branch `main`, `origin/main` ou remote configurado neste checkout. O histórico local
registra o merge da PR #769 como último commit; isso não comprova GitHub, checks, deploy ou produção.
Nenhuma conexão a banco, migration, Docker, deploy ou produção foi executada nesta auditoria.

## Visão geral e diagnóstico

O Gest-o **não é multiempresa**. Ele é um monólito modular Express/React, com PostgreSQL acessado
diretamente pelo Prisma e com identidade/RBAC globais. Há 27 models Prisma, 19 enums, 36 migrations,
um controller, 50 services de runtime, cinco middlewares e nenhum repository. Somente quatro models
de Communications possuem um `tenantId` embrionário; esse valor não está ligado a `Tenant`, não vem
do JWT e não protege o CRM central. Portanto, classificações “ready” abaixo significam apenas que o
item é global por definição ou já carrega a dimensão, e não que o sistema esteja pronto.

**Resposta objetiva:** faltam control plane (`Tenant`, memberships e ciclo de vida), tenant context
confiável, isolamento em todas as persistências e consultas, unicidades/FKs compostas, autorização
tenant-aware, particionamento de jobs/caches/locks/logs/ERP, testes negativos e um rollout com
backfill verificável. A estratégia oficial está na [ADR 003](adr/003-shared-schema-tenant-boundary.md).

### Escala

| Classe | Significado |
| --- | --- |
| **MULTI-TENANT READY** | Global por desenho ou já isolado ponta a ponta com prova. |
| **PARCIAL** | Possui parte do contexto/controle, mas não uma boundary completa. |
| **NÃO COMPATÍVEL** | Global, ambíguo ou acessível sem tenant confiável. |

## Arquitetura atual

```text
Browser React -> Axios/Bearer -> Express -> auth JWT {sub, role} -> rotas/services -> Prisma -> PostgreSQL/public
                                      |                         |-> caches Map/process
                                      |                         |-> schedulers no processo API
                                      +-> UltraFV3 / Meta WhatsApp / CNPJ / provedores de IA
```

- API monta as rotas sob aliases com e sem `/api`; CRUD e relatórios concentram-se em
  `crudRoutes.ts`, que consulta Prisma diretamente.
- `authMiddleware` identifica usuário, `authorize` decide somente por role e filtros de vendedor
  limitam visibilidade comercial; vendedor não equivale a tenant.
- Não há repository/data-access central, RLS, control plane, fila externa, worker separado ou cache
  distribuído. Os dois schedulers rodam dentro da API.
- `AppConfig`, locks ERP, sequences, e-mails, códigos e chaves externas têm namespace global.

## Arquitetura desejada

```text
request/webhook/job
  -> resolver tenant confiável (host/conta externa/token)
  -> membership + RBAC/ABAC
  -> TenantContext imutável {tenantId,userId,role,requestId}
  -> repository obrigatório / transação com tenant
  -> PostgreSQL shared-schema + FK/unique compostas + RLS defensiva
  -> cache, job, lock, log, métrica e integração sempre namespaced
```

O contexto nunca é aceito do payload. Operações de plataforma usam uma interface separada,
deny-by-default, auditada e sem reutilizar endpoints empresariais. IDs continuam opacos e toda busca
por ID também filtra `tenantId` para impedir IDOR.

## Inventário de dados: models, tabelas, FKs e índices

Cada model Prisma corresponde à tabela homônima. As oito tabelas históricas `incident_*` conhecidas
existem somente na evidência operacional e não no schema Prisma: são **READY/global-imutáveis** como
evidência de incidente e jamais devem ser silenciosamente atribuídas a tenant.

| Model/tabela | Classe atual | `tenantId` futuro | Mudança de chave/índice/FK |
| --- | --- | --- | --- |
| `User` | NÃO COMPATÍVEL | obrigatório via `TenantMembership`; perfil pode ser global | trocar `email @unique` por identidade global explicitamente definida ou `(tenantId,email)`; memberships e FKs compostas |
| `Tenant` / `TenantMembership` | inexistente | `Tenant`: jamais; membership: obrigatório | criar raiz, slug/status únicos globais e `(tenantId,userId)` |
| `KnowledgeDocument` | NÃO COMPATÍVEL | obrigatório; opcional apenas se houver catálogo de plataforma separado | `(tenantId,category/sourceType/isActive/createdById)` |
| `Client` | NÃO COMPATÍVEL | obrigatório | `(tenantId,id)`, índices por tenant para code, fantasyName, archive e identidade ERP/CNPJ |
| `ClientCodeAudit` | NÃO COMPATÍVEL | obrigatório | FK `(tenantId,clientId)` e índices tenant+createdAt/requestId/origin |
| `AgendaEvent` | NÃO COMPATÍVEL | obrigatório | FKs compostas a seller/client/opportunity e índices tenant+datas |
| `AgendaStop` | NÃO COMPATÍVEL | obrigatório | unique `(tenantId,agendaEventId,order)` e FK composta |
| `Contact` | NÃO COMPATÍVEL | obrigatório | FKs compostas e `(tenantId,phoneHash)`, `(tenantId,ownerSellerId,phoneHash)` |
| `Opportunity` | NÃO COMPATÍVEL | obrigatório | FKs cliente/vendedor e índices tenant+stage/datas/owner |
| `OpportunityChangeLog` | NÃO COMPATÍVEL | obrigatório | FKs compostas e `(tenantId,opportunityId,createdAt)` |
| `TimelineEvent` | NÃO COMPATÍVEL | obrigatório | FKs compostas e índices tenant+cliente/oportunidade/data |
| `Activity` | NÃO COMPATÍVEL | obrigatório | FKs compostas e índices tenant+owner/dueDate/relacionamentos |
| `Goal` | NÃO COMPATÍVEL | obrigatório | unique `(tenantId,sellerId,month)` |
| `ActivityKPI` | NÃO COMPATÍVEL | obrigatório | unique `(tenantId,sellerId,month,type)` |
| `Sale` | NÃO COMPATÍVEL | obrigatório | FK composta e índice `(tenantId,sellerId,date)` |
| `SellerTerritoryCity` | NÃO COMPATÍVEL | obrigatório | unique `(tenantId,sellerId,state,city)`; demais índices tenant-first |
| `AppConfig` | NÃO COMPATÍVEL | obrigatório para configuração empresarial | separar `PlatformConfig` sem tenant; unique `(tenantId,key)` |
| `CultureCatalog` | PARCIAL | jamais se catálogo canônico; obrigatório numa tabela de override | manter global read-only; criar override tenant-scoped em vez de valor híbrido |
| `Product` | NÃO COMPATÍVEL | obrigatório | unique `(tenantId,erpProductCode,erpProductClassCode)`; índice `(tenantId,name)` |
| `ProductPrice` | NÃO COMPATÍVEL | obrigatório | FK composta; índices `(tenantId,productId)` e `(tenantId,branchCode)` |
| `OpportunityItem` | NÃO COMPATÍVEL | obrigatório | unique `(tenantId,opportunityId,lineNumber)` e FKs compostas |
| `ErpOrderSync` | NÃO COMPATÍVEL | obrigatório | `pedidoIdImportacao` tenant-scoped; FKs e status/número tenant-first |
| `ErpSyncRun` | NÃO COMPATÍVEL | obrigatório | índices `(tenantId,scope/status/sellerId,startedAt)` |
| `ErpSyncLock` | NÃO COMPATÍVEL | obrigatório | PK/unique `(tenantId,scope)`; nunca lock global por acidente |
| `CommunicationIntegrationAccount` | PARCIAL | já obrigatório, mas sem FK | FK para `Tenant`; manter unique tenant+provider+channel+account |
| `CommunicationConversation` | PARCIAL | tornar obrigatório | uniques devem começar por tenant; FKs compostas para integração/cliente/vendedor |
| `CommunicationMessage` | PARCIAL | tornar obrigatório | unique tenant+provider+account+message; FKs compostas |
| `CommunicationWebhookEvent` | PARCIAL | obrigatório após resolver conta externa | unique tenant+provider+account+event; estado de evento tenant-scoped |
| enums Prisma | MULTI-TENANT READY | jamais | valores de plataforma; customização exige tabelas próprias, não `tenantId` no enum |
| migrations e `_prisma_migrations` | MULTI-TENANT READY | jamais | ledger/schema são infraestrutura global; futuras migrations seguem ADR 002 |
| sequence `erp_order_number_seq` | NÃO COMPATÍVEL | não é coluna; namespace lógico obrigatório | substituir por contador `(tenantId,sequence)` ou definir número global por decisão explícita |

### Tenant obrigatório, opcional e proibido

- **Obrigatório:** toda linha empresarial, inclusive filhos, auditoria, outbox/webhooks, jobs,
  idempotência, uploads futuros, configurações, integrações e snapshots derivados.
- **Opcional somente na transição:** colunas adicionadas antes do backfill e eventos externos ainda
  não resolvidos, sempre em quarentena e nunca visíveis ao domínio. Ao final não há `tenantId` nulo
  em dados empresariais.
- **Jamais:** `Tenant`, catálogo de países/IBGE/enums/culturas canônicas, build info, migrations,
  feature definitions globais, metadados de plataforma e evidências forenses históricas. Overrides,
  habilitações e consumo desses recursos pertencem a tabelas tenant-scoped separadas.

## Inventário da aplicação

| Superfície | Quantidade/itens | Classe | Ação obrigatória |
| --- | --- | --- | --- |
| Controllers | `authController.ts` (1) | NÃO COMPATÍVEL | emitir tenant/membership selecionada, rotação/revogação e impedir troca não autorizada |
| Services | 50 arquivos de runtime (IA, agenda, clientes, ERP, comunicações, saúde) | NÃO COMPATÍVEL; Communications PARCIAL | receber `TenantContext`, remover Prisma global e provar isolamento |
| Repositories | 0 | NÃO COMPATÍVEL | criar camada tenant-required; escape hatch administrativo explícito |
| Middlewares | `auth`, `authorize`, `rateLimit`, `requestLogging`, `validate` (5) | PARCIAL | adicionar resolução/membership; rate-limit e log por tenant; validação não confia no body |
| Schedulers | `erpSyncScheduler`, `commercialAutomationsScheduler` | NÃO COMPATÍVEL | fan-out justo por tenant, lease/lock tenant-scoped, retry/DLQ/idempotência |
| Workers/filas | nenhum worker ou broker separado; mensagens usam status persistido | NÃO COMPATÍVEL para escala | envelope com tenant, outbox, consumo deny-by-default e DLQ tenant-aware |
| Caches | `Map`/singleton em IA, planejamento, timeline, CRM, saúde; token UltraFV3; parceiros em `AppConfig` | PARCIAL/NÃO COMPATÍVEL | chave com tenant, invalidação e limites; criptografar/segregar token por tenant |
| Logs | morgan, `logApiEvent`, console e scripts/TSV operacionais | PARCIAL | `tenantId` sanitizado/correlation, controle de acesso e retenção; nunca token/PII |
| JWT | access/refresh com usuário/role; token UltraFV3 em memória | NÃO COMPATÍVEL | claims `tenant_id`, membership/version/audience; seleção e revogação; cache ERP tenant-scoped |
| Dashboards | UI/API Dashboard e Saúde da Plataforma | NÃO COMPATÍVEL | agregações tenant-first; visão de plataforma em endpoint/role separados |
| Integrações | UltraFV3, Meta WhatsApp, CNPJ, IA Ollama/OpenAI-compatible | PARCIAL no WhatsApp; demais NÃO COMPATÍVEL/global | credencial, quota, webhook e correlação por tenant; CNPJ/IA sem cache ou prompt cruzado |
| Filtros/JOINs | Prisma `where/include`, owner filters e quatro raw dashboards | NÃO COMPATÍVEL | `tenantId` no nó raiz e em relações; FK composta impede JOIN cruzado |
| Scripts administrativos/seeds | 38 scripts TS da API, scripts raiz/produção/recuperação; `seed.js`, preview e fixture | NÃO COMPATÍVEL/PARCIAL operacional | tenant explícito, dry-run/allowlist; seeds descartáveis criam tenant fixture; recovery histórica permanece global e congelada |
| Testes | 37 arquivos de teste/smoke detectados; suites npm e CI | PARCIAL | matriz A×B negativa para CRUD, IDs, busca, relatórios, cache, jobs, webhook, ERP e raw SQL |

## APIs e endpoints

Foram inventariados **216 handlers lógicos**: 4 auth, 1 CNPJ, 1 assistente, 192 CRUD/ERP/admin,
3 dashboard, 2 saúde, 12 proxies UltraFV3 e 1 status Communications, além de 2 webhooks Meta e 4
health/debug endpoints montados diretamente em `app.ts`. Muitos handlers têm aliases `/api`, logo a
superfície HTTP publicada é maior que o número lógico.

| Família | Endpoints | Classe | Requisito |
| --- | --- | --- | --- |
| Health/build | `GET /health`, `/health/version`, `/system/health/runtime`, `/debug` | READY somente como plataforma | jamais retornar dado tenant; separar health público de diagnóstico operador |
| Auth | `POST /login`, `/refresh`, `/logout`; `GET /me` | NÃO COMPATÍVEL | resolver tenant/membership, claims e revogação; evitar enumeração |
| Dashboard/relatórios | `/dashboard/{summary,sales-series,portfolio}` e 10 `/reports/*` | NÃO COMPATÍVEL | toda agregação, subquery e período por tenant |
| Clientes/contatos | `/clients*`, aliases `/companies*`, `/contacts*`, import, duplicate, diagnostics | NÃO COMPATÍVEL | tenant do contexto; uniqueness, bulk e merge dentro do tenant |
| Oportunidades/produtos/pedidos | `/opportunities*`, `/products*`, `/erp-orders*` | NÃO COMPATÍVEL | lookup e transação tenant-scoped; idempotência e sequence por tenant |
| Agenda/atividades/eventos | `/activities*`, `/events*`, `/agenda*` | NÃO COMPATÍVEL | checar tenant em todos os IDs relacionados e geolocalização |
| IA | `/ai*`, `/api/ai/crm-assistant/query`, `/assistant-whatsapp/contact` | NÃO COMPATÍVEL | retrieval/cache/prompt/result por tenant; quotas e logs segregados |
| ERP UltraFV3 | `/erp*`, sync, scheduler, history, diagnostics, user ERP login e proxies | NÃO COMPATÍVEL | configuração/credencial/filial/run/lock/cache por tenant; limitar diagnóstico |
| Config/admin | users, goals, KPIs, objectives, territories, cultures, knowledge, automations/settings | NÃO COMPATÍVEL | membership/RBAC no tenant; separar administração de plataforma |
| Saúde | `/api/platform-health/{snapshot,audit}` | NÃO COMPATÍVEL | snapshot tenant-scoped; console global separado e somente operador |
| Communications | `GET /communications/integrations/meta-whatsapp/status` | PARCIAL | obter tenant do contexto, nunca usar conta global implícita |
| Webhooks | `GET/POST /webhooks/communications/meta-whatsapp` e alias `/api` | PARCIAL | resolver tenant pela conta externa antes de persistir; assinatura, idempotência e quarentena |
| CNPJ | `GET /clients/cnpj-lookup/:cnpj` | PARCIAL | consulta externa pode ser global, mas rate/quota/log e associação são tenant-scoped |

**Incompatibilidade comum a todos os endpoints de negócio:** autenticação e role não estabelecem
tenant, acesso por ID não tem predicado empresarial e o Prisma é chamado nas próprias rotas. Não se
alteram contratos nesta Sprint; a Sprint 1.0 deve versionar apenas mudanças externas inevitáveis e
preservar aliases durante janela anunciada.

## SQL, consultas e migrations

- O runtime usa Prisma extensivamente sem filtro de tenant. Não existem repositories.
- Raw SQL parametrizado: reserva `nextval('erp_order_number_seq')`, advisory lock por
  `opportunity.id` e quatro consultas de saúde sobre `Client`/`Contact`; todas são **NÃO COMPATÍVEIS**
  até receberem namespace/predicado tenant. `SET TRANSACTION READ ONLY` é **READY/global** como
  controle transacional, mas a consulta que o segue ainda precisa de tenant.
- SQL administrativo inclui 36 migrations, scripts de recovery/diagnóstico e artefatos em `docs/sql`.
  Migrations/ledger são globais; SQL de negócio precisa de parâmetro tenant e guardrail. Scripts de
  incidente de julho devem permanecer congelados e executados somente segundo seus runbooks.
- Todo plano deve ser revisado com `EXPLAIN (ANALYZE, BUFFERS)` em fixture representativa; índices
  tenant-first evitam scan global, mas exigem medir cardinalidade e write amplification.

## Mapa de dependências

| Origem | Dependência | Risco de propagação |
| --- | --- | --- |
| JWT/membership | middleware/contexto | contexto errado contamina toda operação |
| contexto | repositories/raw SQL | ausência permite leitura/escrita cruzada |
| `User` | quase todos os domínios | modelo de membership define ownership e permissões |
| `Client` | contatos, oportunidades, agenda, atividades, timeline, comunicações, ERP | FK simples permite ligação entre tenants |
| `Opportunity` | itens, logs, agenda, atividades, pedidos | transações e locks precisam do mesmo tenant |
| ERP config/user | sync run/lock/cache/order | credencial ou lock global paralisa/vaza outra empresa |
| integração WhatsApp | webhook/conversa/mensagem/cliente | conta externa é a chave segura de resolução inicial |
| caches/IA | consultas e respostas | chave incompleta pode devolver dados de outro tenant |
| jobs | todas as rotinas ERP/comerciais | fan-out sem fairness causa starvation e blast radius |
| observabilidade | logs/métricas/auditoria | ausência de dimensão impede investigação e billing |

## Mapa de riscos

| Risco | Severidade | Controle/gate |
| --- | --- | --- |
| IDOR ou consulta sem tenant | Crítica | repository deny-by-default, FK composta, RLS e testes A×B |
| Backfill atribuir linha à empresa errada | Crítica | mapeamento assinado, contagens/hashes, quarentena e revisão humana |
| unique global bloquear ou colidir tenants | Alta | recriar unique tenant-first antes de liberar gravação |
| cache/token/lock/job cruzado | Crítica | namespace obrigatório, teste concorrente e métricas por tenant |
| webhook sem resolução inequívoca | Crítica | mapa de conta externa, assinatura e quarantine/DLQ |
| ERP misturar filial, usuário ou pedido | Crítica | credenciais/config/idempotência/sequence tenant-scoped |
| RLS dar falsa confiança ou quebrar operação | Alta | política fail-closed, role runtime sem bypass, testes e break-glass auditado |
| regressão/performance por índices compostos | Alta | explain/load test, rollout gradual e SLO |
| rollback após writes multi-tenant | Crítica | forward-compatible schema, dual-write auditado, restore ensaiado; não remover colunas cedo |
| logs/analytics/billing sem isolamento | Alta | ACL, retenção e agregação tenant-aware |

## Estratégia oficial de migração

1. **Gate 0 — decisão e ownership:** manter os gates da ADR 003 aceita; nomear Arquitetura, Segurança, DBA e Produto;
   congelar alegação multiempresa e definir SLO/RPO/RTO.
2. **Control plane:** implementar `Tenant`, lifecycle e membership; tenant default representa a
   empresa atual. Ainda sem liberar múltiplas empresas.
3. **Expand:** em migration futura separada, adicionar colunas anuláveis/novas chaves sem remover
   nada. Esta Sprint não a cria.
4. **Backfill:** classificar todas as linhas e relações para o tenant default; órfãos/ambiguidade vão
   para quarentena. Comparar contagens, hashes e FKs antes/depois.
5. **Data access:** mover Prisma para repositories tenant-required; corrigir raw SQL, joins, scripts,
   caches, logs e jobs. Proibir Prisma global por lint/teste arquitetural.
6. **Dual enforcement:** dual-read shadow e, quando necessário, dual-write idempotente; medir
   divergência sem retornar dados shadow ao usuário.
7. **Constrain:** depois de zero divergência, tornar tenant obrigatório, criar uniques/FKs compostas,
   ativar RLS defensiva e remover constraints globais incompatíveis.
8. **Prova:** fixtures de tenants A/B, fuzz/IDOR, concorrência de jobs, webhooks, ERP, cache, restore,
   carga e observabilidade.
9. **Pilot:** tenant default, tenant interno e um piloto explícito por feature flag/allowlist; ampliar
   por coortes somente com gates verdes.
10. **Contract:** após janela de compatibilidade, remover caminhos globais/aliases obsoletos e
    colunas antigas em Sprint própria.

## Estratégia de compatibilidade

- O tenant atual vira `default`; usuários existentes recebem membership determinística.
- Access tokens antigos permanecem válidos apenas numa janela curta e resolvem exclusivamente o
  tenant default; refresh emite claims novos. Nunca se escolhe tenant por header livre.
- IDs e respostas permanecem; `tenantId` não precisa ser exposto em APIs de negócio. Seleção de
  tenant, se necessária, usa endpoint/control plane autenticado e token novo.
- Schema usa expand/contract: código antigo tolera colunas novas e código novo tolera backfill
  incompleto somente em shadow. Nenhuma leitura empresarial retorna linha sem tenant.
- ERP e WhatsApp mantêm contas existentes vinculadas ao tenant default antes do piloto.

## Plano de rollout

| Fase | Entrada | Saída/gate |
| --- | --- | --- |
| 0 Observação | baseline e ADR | métricas de queries sem contexto, owners e runbooks |
| 1 Default-only | control plane/backfill | 100% linhas classificadas ou em quarentena; nenhuma exposição nova |
| 2 Shadow | repositories/dual-read | divergência zero no período aprovado |
| 3 Enforce | constraints/RLS | testes A×B, restore e carga verdes |
| 4 Internal | segundo tenant interno | zero cross-tenant, SLO e auditoria aprovados |
| 5 Pilot | allowlist de cliente | suporte/onboarding/rollback exercitados |
| 6 GA | gates comerciais/jurídicos | coortes graduais e remoção posterior de legado |

## Plano de rollback

- Antes de enforcement: desligar flags, voltar leitura ao caminho antigo e preservar shadow logs.
- Durante pilot: bloquear criação/tráfego do tenant afetado, drenar jobs pelo tenant e restaurar a
  versão anterior **sem** desfazer colunas aditivas.
- Depois de writes: não fazer downgrade destrutivo. Reconciliar via ledger/outbox e, se houver
  corrupção, restaurar backup em ambiente isolado, validar por tenant e planejar recovery aprovado.
- RLS deve ter kill switch operacional controlado apenas para contenção, nunca para servir tráfego
  normal sem filtro. Toda ação break-glass é auditada.
- Contract/descarte de legado só após duas releases estáveis e backup/restore multi-tenant provado.

## Roadmap para Sprint 1.0+

| Marco | Entrega | Critério de conclusão |
| --- | --- | --- |
| 1.0A | ADR aceita, threat model, desenho/control plane default-only e memberships projetadas | tenant confiável e nenhum produto multiempresa anunciado |
| 1.0B | expand/backfill default e reconciliação | contagens/FKs/hashes, quarentena zero ou aprovada |
| 1.0C | repositories, auth/context, raw SQL e policies | nenhum Prisma de negócio sem tenant; testes arquiteturais |
| 1.0D | caches, jobs, logs, ERP, WhatsApp e IA | namespace e testes concorrentes A×B |
| 1.0E | constraints compostas, RLS e performance | isolamento negativo, carga e restore aprovados |
| 1.0F | piloto e GA por coorte | SLO, suporte, LGPD, billing/onboarding e rollback exercitados |

## Technical Debt derivada

TD-ER-004 deixa de ser uma descrição genérica e passa a apontar este plano. Permanecem como itens
separados TD-ER-005 (sessão), TD-ER-006 (LGPD), TD-ER-009/010 (SLO/capacidade), TD-ER-011
(contratos) e TD-ER-012 (raw SQL). Novos subitens rastreáveis: data-access inexistente,
uniqueness/FKs globais, tenant context/JWT, jobs-caches-logs, ERP/webhook e prova/rollout.

## Evidência e limites

O inventário foi produzido por leitura integral das fontes obrigatórias, schema, rotas, services,
scripts, migrations, testes e histórico local. Ele descreve o checkout, não produção. Alterações
futuras devem regenerar contagens e reexecutar a auditoria antes da primeira migration de tenancy.


## Atualização Sprint 1.0A

A ADR 003 foi aceita com condições, e o threat model, RACI, modelos e contratos default-only estão no
[Brief 1.0A](sprints/SPRINT_1_0A_MULTI_TENANCY_FOUNDATION.md). Isso atualiza a decisão, não o
diagnóstico: não há migration, memberships persistidas, isolamento transversal ou segundo tenant;
o sistema continua single-tenant e Multiempresa permanece 🔴. A expansão futura está no
[plano 1.0B](tenancy/MIGRATION_EXPAND_PLAN.md).

## Atualização Sprint 1.0B.1

O control plane foi modelado em PR com migration aditiva, tenant default determinístico,
memberships por usuário, runner/ledger e adapter Prisma não integrado. Nenhum dos 23 models centrais
foi tenantizado e nenhum handler/JWT mudou. A prova é local/descartável: apply e estado de produção
continuam desconhecidos; Multiempresa permanece 🔴 e a expansão de dados fica para 1.0B.2.

## Estado da operacionalização 1.0B.1-OP

Em 🔵 PR, foram separados preview, DDL, dry-run e DML do tenant default. O runtime continua single-tenant/disabled, nenhum model empresarial recebeu `tenantId`, nenhum segundo tenant foi criado e Multiempresa permanece 🔴. Evidência operacional real e todos os gates do [Brief](sprints/SPRINT_1_0B_1_OP_CONTROL_PLANE_OPERATION.md) são pré-condições de 1.0B.2.
