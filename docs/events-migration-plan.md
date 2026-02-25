# Plano curto de migração: comentários para eventos

1. **Estrutura de dados**
   - Adicionar o model `Event` com relação opcional a `Client` e `Opportunity`, mais `ownerSellerId` e `createdAt`.
   - Adicionar enum `EventType` para classificar (`comentario`, `mudanca_etapa`, `status`).

2. **API e fluxo novo**
   - Criar endpoint `POST /events` para registrar eventos.
   - Criar endpoint `GET /events` com filtros por `opportunityId` e `clientId` para montar timeline.
   - Passar telas para salvar comentário via `events` em vez de concatenar texto em `opportunity.notes`.

3. **Backfill (legado)**
   - Executar script único `npm run events:migrate-notes -w @salesforce-pro/api` para converter `Opportunity.notes` existentes em eventos.
   - Script idempotente: evita duplicar evento se já existir evento com mesmo `description` para a oportunidade.

4. **Operação após migração**
   - `notes` pode permanecer temporariamente para compatibilidade.
   - Timeline passa a usar somente `events` como fonte principal.
