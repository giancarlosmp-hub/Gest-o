import { ErpOperationalOrderStatus, ErpOrderFulfillmentStatus, ErpOrderSyncStatus, Prisma } from "@prisma/client";
import { classifyPortfolioStatus, isCoolingActive, type PortfolioStatus } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { resolvePurchaseDate } from "./commercialAutomationsService.js";

type PortfolioClient = { id: string; lastPurchaseDate: Date | null; financialProfile: Prisma.JsonValue | null };

export type LastPurchase = { date: Date; source: "erp" | "pedidoCrm" };

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

// Última compra efetiva, a mesma que classifica a carteira: data do ERP (fallback DATA_ULTFATURA) ou o pedido
// sent não cancelado mais recente. Empate fica com o ERP. Sem nenhuma das duas, null (prospect).
export const resolveLastPurchase = (client: PortfolioClient, lastSentCrmOrderByClient: Map<string, Date>): LastPurchase | null => {
  const erpDate = resolvePurchaseDate(client);
  const crmOrderDate = lastSentCrmOrderByClient.get(client.id) ?? null;
  if (crmOrderDate && (!erpDate || crmOrderDate > erpDate)) return { date: crmOrderDate, source: "pedidoCrm" };
  return erpDate ? { date: erpDate, source: "erp" } : null;
};

export const isClientCoolingActive = (client: PortfolioClient, lastSentCrmOrderByClient: Map<string, Date>, now: Date) =>
  isCoolingActive(resolvePurchaseDate(client), lastSentCrmOrderByClient.get(client.id) ?? null, now);

// Recortes da carteira usados pelo Assistente Comercial e pelo alerta da Central do Dia, sempre sem arquivados:
// - semComprar: inativo recente e depois ex-cliente, cada grupo da compra mais recente para a mais antiga;
// - esfriando: ativo há mais de 9 meses sem comprar, da compra mais antiga (mais perto de inativar) para a mais recente;
// - primeiraVenda: prospects (nunca compraram), por nome.
export type PortfolioSegment = "semComprar" | "esfriando" | "primeiraVenda";
export type PortfolioSegmentEntry = { id: string; status: PortfolioStatus; lastPurchase: LastPurchase | null };

const WITHOUT_PURCHASE_ORDER: Partial<Record<PortfolioStatus, number>> = { inativoRecente: 0, exCliente: 1 };

export const listPortfolioSegment = async (segment: PortfolioSegment, scope: Prisma.ClientWhereInput, now: Date): Promise<PortfolioSegmentEntry[]> => {
  const where: Prisma.ClientWhereInput = { ...scope, isArchived: false };
  const [candidates, lastSentCrmOrderByClient] = await Promise.all([
    prisma.client.findMany({ where, select: { id: true, name: true, lastPurchaseDate: true, financialProfile: true } }),
    loadLastSentCrmOrderByClient(where)
  ]);
  const rows = candidates.map((client) => ({
    id: client.id,
    name: client.name,
    status: portfolioStatusOf(client, lastSentCrmOrderByClient, now),
    lastPurchase: resolveLastPurchase(client, lastSentCrmOrderByClient),
    cooling: isClientCoolingActive(client, lastSentCrmOrderByClient, now)
  }));
  const time = (entry: { lastPurchase: LastPurchase | null }) => entry.lastPurchase?.date.getTime() ?? 0;

  const selected =
    segment === "semComprar"
      ? rows
          .filter((row) => row.status in WITHOUT_PURCHASE_ORDER)
          .sort((a, b) => WITHOUT_PURCHASE_ORDER[a.status]! - WITHOUT_PURCHASE_ORDER[b.status]! || time(b) - time(a))
      : segment === "esfriando"
        ? rows.filter((row) => row.cooling).sort((a, b) => time(a) - time(b))
        : rows.filter((row) => row.status === "prospect").sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return selected.map(({ id, status, lastPurchase }) => ({ id, status, lastPurchase }));
};
