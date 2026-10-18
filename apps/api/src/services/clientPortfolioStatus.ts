import { ErpOrderSyncStatus, Prisma } from "@prisma/client";
import { classifyPortfolioStatus, type PortfolioStatus } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { resolvePurchaseDate } from "./commercialAutomationsService.js";

type PortfolioClient = { id: string; lastPurchaseDate: Date | null; financialProfile: Prisma.JsonValue | null };

// Último pedido do CRM enviado ao ERP com sucesso (status sent), por cliente. Pendente ou recusado não conta.
export const loadLastSentCrmOrderByClient = async (clientWhere: Prisma.ClientWhereInput) => {
  const orders = await prisma.erpOrderSync.findMany({
    where: { status: ErpOrderSyncStatus.sent, opportunity: { client: clientWhere } },
    select: { sentAt: true, createdAt: true, opportunity: { select: { clientId: true } } }
  });
  const lastByClient = new Map<string, Date>();
  for (const order of orders) {
    const sentAt = order.sentAt ?? order.createdAt;
    const current = lastByClient.get(order.opportunity.clientId);
    if (!current || sentAt > current) lastByClient.set(order.opportunity.clientId, sentAt);
  }
  return lastByClient;
};

export const portfolioStatusOf = (client: PortfolioClient, lastSentCrmOrderByClient: Map<string, Date>, now: Date): PortfolioStatus =>
  classifyPortfolioStatus(resolvePurchaseDate(client), lastSentCrmOrderByClient.get(client.id) ?? null, now);
