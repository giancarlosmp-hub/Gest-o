# PR 18A.3 — Diagnóstico UltraFV3 partners, all-sellers, scheduler e ERP Code 5050

## Escopo e pendências fora desta PR

Esta investigação cobre exclusivamente a recuperação da sincronização automática UltraFV3, o fluxo de clientes por vendedor, a investigação read-only do ERP Code 5050, matching/idempotência, troca de vendedor sem duplicação e resultado parcial confiável.

Pendências separadas, registradas sem correção nesta PR:
- Produção ainda retorna `404` em `/clients/alerts/cooling`.
- Produção ainda retornou `403` “Vendedor fora do escopo permitido” na Agenda.
- Preview apresentou comportamento diferente da produção.

## Checkout local

Baseline local: branch `work`, HEAD `0781948c0b1a6d958e24ef99e9e37bbacc5a40f6`. O comando `git remote -v || true` não retornou remotes; tratado como checkout isolado, sem blocker e sem alegação de deploy/publicação real.

## Fluxo real identificado

UI `ErpIntegrationPanel` chama `POST /erp/ultrafv3/sync/partners/all-sellers` para carteira completa e `POST /erp/ultrafv3/sync/partners/by-user/:userId` para execução individual. As rotas chamam `syncPartnersForAllConfiguredSellers()` e `syncPartnersByUser()`.

Fluxo all-sellers: seleciona usuários `role=vendedor`, ativos e com `erpLoginUsername`/`erpLoginPasswordEncrypted`; cada vendedor é processado sequencialmente; a senha é descriptografada por `getConfiguredSellerCredentials`; o client UltraFV3 chama `GET /partners`; o payload é convertido por `toArray`; a persistência usa `persistPartnerRowsForSeller` e `persistPartnerPayload`; o matching prioriza `code`, depois documento seguro, depois identidade exata conservadora; a atualização conecta `ownerSeller` ao vendedor recebido; duplicados ambíguos não são mesclados automaticamente; o agregador soma `processed`, `created`, `updated`, `sellerChangedCount`, `emptyCount` e `errorCount`; a rota retorna `200`, `207` ou `502` conforme `status`.

## Arquivos/funções responsáveis

- Sync individual: `syncPartnersByUser` em `apps/api/src/services/ultraFv3SyncService.ts`.
- Sync all-sellers: `syncPartnersForAllConfiguredSellers` em `apps/api/src/services/ultraFv3SyncService.ts`.
- Sync completo: `syncAllUltraFv3Catalogs`/job em `apps/api/src/services/ultraFv3SyncService.ts`.
- Scheduler automático: `apps/api/src/services/erpSyncScheduler.ts`, inicializado por `server.ts`/`scripts/bootstrap.ts`.
- Status: `writeSyncStatus`, `getUltraFv3SyncStatus`, `ErpSyncRun` e `AppConfig`.
- Autenticação por vendedor: `getConfiguredSellerCredentials`, `decryptErpCredential`, `ultraFv3Client.requestWithCredentials`.
- Matching/deduplicação: `findPartnerClientCandidates`, `choosePrimaryPartnerClient`, `mergeDuplicateClientsIntoPrimary`.
- Arquivamento: só ocorre em merge de duplicado; não há exclusão física.
- Atualização de owner: `ownerSeller: { connect: { id: ownerSellerId } }`.
- Busca `GET /clients`: rota `/clients` pesquisa `name`, `fantasyName`, `code`, CNPJ, cidade, UF, região e segmento.

## Correções implementadas

1. `all-sellers` passa a responder contrato operacional: `status`, `sellerCount`, `successCount`, `emptyCount`, `errorCount`, `processed`, `created`, `updated`, `sellerChangedCount`, `skipped`, `results`.
2. HTTP agora diferencia sucesso total (`200`), parcial (`207`) e falha total (`502`).
3. Zero legítimo é `EMPTY_SUCCESS`, não falha silenciosa nem sucesso indistinto.
4. Um vendedor com erro continua não interrompendo vendedores seguintes.
5. UI não mostra toast de falha total quando houve processamento parcial; exibe mensagens padronizadas.
6. Card global foi rotulado como métrica de processados para não misturar carteira ativa com criados/atualizados.
7. Normalização de ERP Code foi reforçada e exportada para preservar string/number, zeros à esquerda e campos alternativos (`PARCEIRO_OUT`, `IDPARCEIRO`).
8. Coletor de `/partners` por vendedor registra páginas consultadas, acumulado, páginas vazias, payload malformado e página repetida; possui limite contra loop infinito.
9. Modo read-only `npm run erp:investigate-partner -- --erp-code=5050` consulta vendedores configurados, aplica normalização em memória, faz matching CRM somente leitura e retorna relatório sanitizado.
10. Endpoint HTTP read-only protegido por perfil (`GET /erp/investigate/:erpCode` e `POST /erp/investigate`) usa o mesmo serviço do CLI, fica disponível em DEV/PREVIEW e desaparece em produção salvo `FEATURE_ERP_INVESTIGATION=true`.

## ERP Code 5050

A PR adiciona a ferramenta para localizar exatamente o 5050 em produção controlada, mas não declara o caso real corrigido sem execução com credenciais reais. O comando reporta: `ERP_RETURNED`, vendedor/página/campo, `NORMALIZED`, match CRM por ERP Code, ativo/arquivado, duplicidade, primary, owner atual/recebido, `WOULD_CREATE`, `WOULD_UPDATE`, `WOULD_CHANGE_OWNER`, `ARCHIVED_MATCH`, `AMBIGUOUS_MATCH`, `NOT_RETURNED_BY_ERP` e cobertura de busca UI/API.

## DATA_BAIXA

Auditoria local encontrou leitura de `DATA_BAIXA`, `DT_BAIXA`, `DATABAIXA`, `dataBaixa` e `inactiveAt` nos diagnósticos existentes. Esta PR não altera regra de inativação aprovada; adiciona cobertura smoke para garantir que a investigação não execute archive/update/delete.

## Scheduler automático

O endpoint HTTP de investigação existe para QA/Postman/Insomnia/navegador sem entrar no container, mas não fica exposto em produção por padrão.

O scheduler permanece dependente de `ERP_SYNC_SCHEDULER_ENABLED` e configuração persistida. A correção desta PR mantém o serviço all-sellers confiável para uso pelo automático; se o ambiente externo não tiver `ERP_SYNC_SCHEDULER_ENABLED=true`, o reasonCode operacional continua sendo configuração externa pendente, sem inventar valor. Validação real de `lastRunAt`, `nextRunAt`, locks, instâncias e credenciais por vendedor exige produção controlada.

## Preview vs produção

Validável localmente/preview: contratos, UI, 207, mocks/smokes, paginação simulada, idempotência estática e investigação read-only sem credenciais. Validável só em produção controlada: `/partners` real, ERP 5050 real, scheduler real, paginação real e troca real de carteira.

## Decisão

**APROVADA PARA PREVIEW**. Manter como validação operacional pendente antes de merge final a execução read-only do 5050 e uma janela controlada do scheduler em produção.
