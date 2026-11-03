-- Origem da oportunidade (gravada por automações; nula nas criadas pela tela/API) e índice
-- das paradas por cliente e check-out (última visita do planejamento). Somente aditiva.
ALTER TABLE "Opportunity" ADD COLUMN IF NOT EXISTS "origin" TEXT;

CREATE INDEX IF NOT EXISTS "AgendaStop_clientId_checkOutAt_idx" ON "AgendaStop"("clientId", "checkOutAt");
