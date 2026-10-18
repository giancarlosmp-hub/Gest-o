import { ErpOperationalOrderStatus, ErpOrderFulfillmentStatus, ErpOrderSyncStatus, Prisma } from "@prisma/client";
import { classifyPortfolioStatus, type PortfolioStatus } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { resolvePurchaseDate } from "./commercialAutomationsService.js";

type PortfolioClient = { id: string; lastPurchaseDate: Date | null; financialProfile: Prisma.JsonValue | null };

// Último pedido do CRM enviado ao ERP com sucesso (status sent), por cliente. Pendente ou recusado não conta,
// nem o cancelado depois no ERP (orderStatus cancelado ou operationalOrderStatus CANCELADO, o mesmo critério de
// orderStatusGroup). O filtro fica em memória: NOT do Prisma em coluna nula também descartaria os sem status.
export const loadLastSentCrmOrderByClient = async (clientWhere: Prisma.ClientWhereInput) => {
  const orders = await prisma.erpOrderSync.findMany({
    where: { status: ErpOrderSyncStatus.sent, opportunity: { client: clientWhere } },
    select: { sentAt: true, createdAt: true, orderStatus: true, operationalOrderStatus: true, opportunity: { select: { clientId: true } } }
  });
  const lastByClient = new Map<string, Date>();
  for (const order of orders) {
    if (order.orderStatus === ErpOrderFulfillmentStatus.cancelado || order.operationalOrderStatus === ErpOperationalOrderStatus.CANCELADO) continue;
    const sentAt = order.sentAt ?? order.createdAt;
    const current = lastByClient.get(order.opportunity.clientId);
    if (!current || sentAt > current) lastByClient.set(order.opportunity.clientId, sentAt);
  }
  return lastByClient;
};

export const portfolioStatusOf = (client: PortfolioClient, lastSentCrmOrderByClient: Map<string, Date>, now: Date): PortfolioStatus =>
  classifyPortfolioStatus(resolvePurchaseDate(client), lastSentCrmOrderByClient.get(client.id) ?? null, now);
