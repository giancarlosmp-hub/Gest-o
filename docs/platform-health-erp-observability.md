# Saúde da Plataforma — observabilidade ERP canônica

## Baseline de 12/08/2026

O checkout local começa no merge da PR #798 (`9ddbd04`), que sucede os merges #797 (`50970a5`) e
#749 (`39f3d46`, implementação original). Não há remote configurado; logo PRs/checks atuais e head
remoto não foram consultados. Produção não foi acessada e o workflow **ERP Production Recovery** não
foi executado. A execução manual informada pelo operador (14/14, cerca de 4.010 registros,
`22098651-5c8b-4ed6-a503-61b8b325c6ef`) é evidência fornecida, não prova do scheduler.

## Causa raiz e fluxos

A causa reproduzida era dupla: a API agregava `ErpSyncRun`, mas não selecionava `correlationId`, não
separava pais/filhos e origens nem consultava scheduler/lock; o frontend, após rejeição HTTP, mantinha
`data` indefinido e os `?.`, `|| 0`, `?? 0` e arrays vazios renderizavam erro como zero/ausência. O
`finally` encerrava o spinner interno, porém o texto de atualização dependia somente de `generatedAt`
e permanecia em “carregando...”.

Fluxo manual: `POST /erp/sync-all` → `startUltraFv3FullSyncJob` → linha pai `syncAll/manual` →
`syncAllUltraFv3Catalogs` → serviços de cada etapa, cada um com seu próprio `ErpSyncRun/manual` e o
mesmo correlation ID → `/platform-health/snapshot` → UI. Configurações (`getUltraFv3SyncHistory`) e
Saúde consultam `ErpSyncRun`, com limites/agregações diferentes; pai e filhos são linhas distintas.

Fluxo automático: bootstrap → `startErpSyncScheduler` → gate de ambiente + `AppConfig`
`erp.automaticSync.config` → cálculo horário em `America/Sao_Paulo` → lock por escopo em
`ErpSyncLock` → pai `automatic/scheduler` e etapas `scheduler` → liberação do lock → estado
`nextRunAt` → snapshot → UI. `recovery` é origem reservada no contrato de apresentação, mas não é
valor do enum atual e não é inferida/reclassificada; o recovery aprovado busca uma execução real
`scheduler`.

O contrato v2 retorna `dataState=available|empty|error`. A projeção pura classifica como pai apenas
`manual/syncAll` e `scheduler/automatic`; os demais scopes são `stage` e carregam
`parentCorrelationId` somente quando existe pai correlacionado. Última execução, quantidade, duração,
taxas, retries e tendências usam apenas pais concluídos, impedindo soma pai+filhos. Etapa órfã nunca
vira evidência executiva. Scheduler, próxima execução, lock, `correlationId` e warnings permanecem
explícitos; exceções da coleta respondem 503 sanitizado.

## Matriz indicador → fonte

| Indicador | Fonte real | Query/serviço | Vazio legítimo | Erro | Evidência |
|---|---|---|---|---|---|
| última execução/tempo/registros/origem | pais `ErpSyncRun` | projeção pura sobre `syncAll/manual` e `automatic/scheduler` | `empty`/Sem pai | snapshot 503 | testes comportamentais 1–10 |
| última manual | `ErpSyncRun.trigger=manual` | agregação do snapshot | Sem execução manual | snapshot 503 | casos 1, 3 |
| última automática/sucesso | `scope=automatic`, `trigger=scheduler` | snapshot + scheduler | Não comprovado | snapshot 503 | casos 2, 3, 12 |
| scheduler/next run | AppConfig, env e estado do scheduler | `getErpAutomaticSyncState` | Não comprovado | snapshot 503 | casos 2, 12 |
| lock | `ErpSyncLock` | `findMany take=20` | sem lock registrado | snapshot 503 | gate de contrato |
| taxas/retries | `ErpSyncRun.status` | agregação bounded | `null` sem runs | snapshot 503 | casos 4, 7 |
| qualidade de clientes | `Client`, `Contact` e JSON financeiro | counts e SQL parametrizado | zero após resposta `available` | snapshot 503 | casos 7–8 |
| auditoria | `ClientCodeAudit` | paginação até 100; export até 5000 | `empty` | audit 503/error | casos 9–10 |
| alertas | runs, scheduler e qualidade | `buildAlerts` + alertas operacionais | nenhum somente após coleta válida | tela de erro | casos 11–12, 18 |
| tendências | `ErpSyncRun`, `ClientCodeAudit` | janela 7/30/90 | lista vazia válida | snapshot 503 | caso 13 |

`ClientCodeAudit` é alimentado por `clientCodeAuditService` quando `Client.code` realmente muda; os
campos instrumentados de qualidade são calculados no banco, sem N+1. O schema torna
`ownerSellerId` obrigatório: `inactiveSeller` consulta `ownerSeller.isActive=false`, enquanto
`missingSeller=null` declara “sem vendedor” não instrumentado. Não existe campo canônico de carteira,
portanto `missingPortfolio=null`. Nenhuma dessas ausências semânticas é exibida como zero.

Os 20 cenários citados são testes TypeScript comportamentais de funções puras com fixtures e
asserções de valores. O script estático é somente um guard complementar de arquitetura/wiring.

## Operação, rollback e limites

Validar com `npm run test:platform-health-erp-observability`. O rollback é reverter esta entrega e
republicar API/WEB pelo processo oficial; não há migration, DDL, backfill ou mudança empresarial.
Risco restante: `ErpSyncRun` histórico pode não estar no schema/runtime produtivo efetivo e o estado
em memória do scheduler só é prova da instância consultada. Somente observação produtiva posterior
pode comprovar scheduler, `nextRunAt`, lock liberado e execução `trigger=scheduler`.

`TENANCY_MODE=disabled` e `TENANT_READ_PILOT_ENABLED=false` permanecem invariantes. A Sprint
1.0B.2-O continua pausada.
