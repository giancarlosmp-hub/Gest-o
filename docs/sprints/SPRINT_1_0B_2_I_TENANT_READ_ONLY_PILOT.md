# Sprint 1.0B.2-I — primeiro piloto read-only tenant-aware

**Estado:** implementado para revisão em 09/08/2026; produção não acessada. Estratégia A, **shadow comparison**. O predecessor `4b2519c` contém a PR #790 e as provas de `ClientTenantRepository`, `resolveTenantContext`, `PrismaTenantControlPlaneReader`, `AgendaStopTenantRepository` e o gate de descendentes.

## Inventário e escolha

O fluxo escolhido é `GET /clients` (e o alias `/api/clients`), autenticado pelo `authMiddleware` que verifica o Bearer JWT atual. O router CRUD aplica o rate limit geral; não há `authorize` adicional. `sellerWhere(req)` limita vendedor ao próprio `ownerSellerId`; diretor/gerente mantêm visão legada e podem filtrar `ownerSellerId`/`vendedorId`. A listagem aceita busca (`q`: nome, fantasia, código, CNPJ, cidade, UF, região e segmento), UF, região, tipo PF/PJ, vendedor, paginação de 1–100 e ordenação validada. Sem parâmetros, retorna o array legado completo; com parâmetros, `{items,total,page,pageSize}`. Ambas as variantes incluem somente `ownerSeller {id,name}` e executam count no caso paginado.

O frontend consome essa listagem para carteira/seletores; scripts, ERP, IA, imports, mutations, lookup público de CNPJ, detalhes, cooling alerts e dashboards permanecem legados. Não existia métrica tenant-aware. Este é o menor fluxo interno autenticado que já centraliza RBAC e filtros. A resposta continua integralmente legada; o piloto repete apenas `count` com o mesmo predicado funcional e `tenantId`, sem include, payload ou IDs. Risco residual: latência de duas leituras do control plane e um count apenas quando explicitamente ativo; mismatch não muda a resposta de preview, mas é evento WARN e falha no harness de teste.

## Matriz de modos

| TENANCY_MODE | TENANT_READ_PILOT_ENABLED | ambiente | efeito |
|---|---:|---|---|
| `disabled` | qualquer valor seguro (`false` em produção) | todos | só legado; retorno antes de resolver/criar reader/repository; zero evento tenant |
| `default-only` | `false` | test/preview | só legado |
| `default-only` | `true` | `NODE_ENV=test` ou `DEPLOYMENT_ENV=preview` | resposta legada + count shadow tenant-scoped |
| `default-only` | `true` | produção/outro | startup lança `TENANT_READ_PILOT_UNSAFE_CONFIGURATION` |

Não existe modo genérico `enabled`/`tenant-aware`. Ativação também exige `DEFAULT_TENANT_ID`. Produção fixa `TENANCY_MODE=disabled` e `TENANT_READ_PILOT_ENABLED=false` no Compose.

## Contexto, query e observabilidade

Depois do JWT ser verificado, o piloto passa explicitamente somente `req.user.id` e `req.user.role` ao resolver request-scoped. O resolver carrega todas as memberships, exige exatamente uma ativa, tenant default ativo e compatível e nega ausência, inatividade, suspensão ou ambiguidade. Header, cookie, query e body não são inputs. Não há singleton mutável, global tenant, AsyncLocalStorage, mudança no JWT ou fallback sem tenant.

`ClientTenantRepository.countMatching(context, where)` reaplica o predicado funcional/RBAC e grava `tenantId` por último. Não há mutation ou include no shadow. O único evento contém `requestId`, tenant técnico validado, `resolutionSource`, `contextVersion`, modo `shadow`, counts legado/scoped, `MATCH|MISMATCH` e duração em ms. Token, e-mail, cliente, documento, payload, URL de banco e dados retornados não são registrados.

## Evidência A×B e preview

O harness HTTP abre dois apps sintéticos, usa tokens legados assinados/verificados pelo middleware real, tenants/clientes A e B, executa A/B concorrentemente e comprova MATCH isolado. Também cobre header/query/body hostis, usuário ambíguo, membership inativa, tenant suspenso, modo disabled sem chamada ao reader/repository, piloto desligado pela mesma configuração disabled, startup produtivo inseguro e contador de mutations igual a zero.

O preview atual popula dados fictícios, mas não demonstra preparação coerente de `tenantId` e `TenantMembership`. Portanto o piloto permanece **test-only** nesta entrega: o workflow de deploy preview não foi habilitado e nenhum sucesso foi inventado. Para habilitar futuramente, preparar e validar o dataset isolado e então declarar `DEPLOYMENT_ENV=preview`, `TENANCY_MODE=default-only`, `TENANT_READ_PILOT_ENABLED=true` e `DEFAULT_TENANT_ID`.

## Rollback, limitações e próxima subfase

Rollback imediato: manter/retornar `TENANT_READ_PILOT_ENABLED=false`; para inércia total, `TENANCY_MODE=disabled`. Remover a chamada `runShadow` é rollback de código sem DDL/DML. Permanecem legados todos os demais acessos Client e todos os outros domínios. Não houve migration, backfill, RLS, deploy, VPS ou produção. Próxima subfase: certificar dados do preview, observar MATCH sob carga sintética e somente então decidir sobre endpoint piloto dedicado; nenhum cutover é autorizado.

`READY_FOR_1_0B_2_I_REVIEW = YES`  
`READY_FOR_TENANT_READ_PILOT_PREVIEW = NO`  
`READY_FOR_ACTIVITY_DUAL_PARENT_MIGRATION = NO`  
`READY_FOR_TENANT_AWARE_RUNTIME = NO`  
`READY_FOR_BACKFILL_PRODUCTION = NO`  
`READY_FOR_MULTI_TENANT_CUTOVER = NO`  
`TENANCY_MODE_PRODUCTION = disabled`  
`TENANT_READ_PILOT_ENABLED_PRODUCTION = false`  
`PRODUCTION_ACCESSED = NO`
