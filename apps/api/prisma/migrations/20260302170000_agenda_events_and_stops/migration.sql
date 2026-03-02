-- CreateEnum
CREATE TYPE "AgendaEventType" AS ENUM ('reuniao_online', 'reuniao_presencial', 'roteiro_visita', 'followup');

-- CreateEnum
CREATE TYPE "AgendaEventStatus" AS ENUM ('agendado', 'realizado', 'vencido');

-- CreateTable
CREATE TABLE "AgendaEvent" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "AgendaEventType" NOT NULL,
    "startDateTime" TIMESTAMP(3) NOT NULL,
    "endDateTime" TIMESTAMP(3) NOT NULL,
    "status" "AgendaEventStatus" NOT NULL DEFAULT 'agendado',
    "notes" TEXT,
    "city" TEXT,
    "clientId" TEXT,
    "sellerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgendaEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgendaStop" (
    "id" TEXT NOT NULL,
    "agendaEventId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "clientId" TEXT,
    "city" TEXT,
    "address" TEXT,
    "plannedTime" TIMESTAMP(3),
    "notes" TEXT,
    "arrivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgendaStop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgendaEvent_sellerId_startDateTime_idx" ON "AgendaEvent"("sellerId", "startDateTime");

-- CreateIndex
CREATE INDEX "AgendaEvent_startDateTime_endDateTime_idx" ON "AgendaEvent"("startDateTime", "endDateTime");

-- CreateIndex
CREATE UNIQUE INDEX "AgendaStop_agendaEventId_order_key" ON "AgendaStop"("agendaEventId", "order");

-- AddForeignKey
ALTER TABLE "AgendaEvent" ADD CONSTRAINT "AgendaEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgendaEvent" ADD CONSTRAINT "AgendaEvent_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgendaStop" ADD CONSTRAINT "AgendaStop_agendaEventId_fkey" FOREIGN KEY ("agendaEventId") REFERENCES "AgendaEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgendaStop" ADD CONSTRAINT "AgendaStop_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
