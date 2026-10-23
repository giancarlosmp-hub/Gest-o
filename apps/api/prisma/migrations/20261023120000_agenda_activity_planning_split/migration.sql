-- Agenda (planejamento) x Atividades (execução): catálogo único de tipos,
-- status "Não realizado" e motivos opcionais. Somente aditiva.
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'reuniao_online';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'reuniao_presencial';
ALTER TYPE "AgendaEventType" ADD VALUE IF NOT EXISTS 'ligacao';
ALTER TYPE "AgendaEventType" ADD VALUE IF NOT EXISTS 'whatsapp';
ALTER TYPE "AgendaEventType" ADD VALUE IF NOT EXISTS 'visita';
ALTER TYPE "AgendaEventType" ADD VALUE IF NOT EXISTS 'proposta';
ALTER TYPE "AgendaEventType" ADD VALUE IF NOT EXISTS 'fechamento';
ALTER TYPE "AgendaEventStatus" ADD VALUE IF NOT EXISTS 'nao_realizado';

ALTER TABLE "AgendaEvent" ADD COLUMN "notDoneReason" TEXT;
ALTER TABLE "Activity" ADD COLUMN "noNextStepReason" TEXT;
