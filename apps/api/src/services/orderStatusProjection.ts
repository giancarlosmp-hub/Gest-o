import { sanitizeErpOrderErrorMessage } from "./erpOrderService.js";

export function orderStatusGroup(sync: string, operational: string | null, fulfillment: string | null) {
  if (sync === "error") return "error";
  if (sync === "pending") return "pending";
  const raw = (operational || "").toUpperCase();
  if (raw === "CANCELADO" || fulfillment === "cancelado") return "cancelled";
  if (raw === "FINALIZADO" || fulfillment === "entregue") return "finished";
  if (raw === "PARCIAL" || fulfillment === "parcial") return "partial";
  if (["DIGITADO", "ACEITO", "EXPEDINDO", "FATURAR", "SUSPENSO"].includes(raw)) return "processing";
  return "unknown";
}

export const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const first = (row: Record<string, unknown>, keys: string[]) => keys.map((key) => row[key]).find((value) => value !== undefined && value !== null && String(value).trim() !== "");
export const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
export const nullableNumber = (value: unknown) => value === undefined || value === null || String(value).trim() === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
export const text = (value: unknown) => value === undefined || value === null ? null : String(value).trim() || null;
export const responseRoot = (value: unknown): Record<string, unknown> => {
  if (Array.isArray(value)) return object(value[0]);
  const root = object(value); const nested = root.response ?? root.data ?? root.result ?? root.pedido ?? root.order;
  return nested === undefined ? root : responseRoot(nested);
};

const REJECTION_MESSAGE_MAX_LENGTH = 160;
export const rejectionMessage = (syncErrors: unknown) => {
  const message = sanitizeErpOrderErrorMessage(first(object(array(syncErrors)[0]), ["message"]) || "Falha de sincronização");
  return message.length > REJECTION_MESSAGE_MAX_LENGTH ? `${message.slice(0, REJECTION_MESSAGE_MAX_LENGTH - 1)}…` : message;
};

export const serializeOrderAttempt = (order: any) => {
  const payload = object(order.payloadSent); const erp = responseRoot(order.erpResponse); const statusPayload = responseRoot(order.lastStatusPayload);
  const source = Object.keys(statusPayload).length ? statusPayload : erp;
  // Tentativa recusada não é pedido: a situação e as quantidades vindas do ERP não são exibidas.
  const rejected = order.status === "error";
  const ordered = number(first(source, ["QTD_PEDIDO"]) ?? first(payload, ["QTD_PEDIDO"]));
  const billed = rejected ? null : nullableNumber(first(source, ["QTD_FATURADO"])); const shipped = rejected ? null : nullableNumber(first(source, ["QTD_EXPEDIDO"]));
  const cancelled = rejected ? null : nullableNumber(first(source, ["QTD_CANCELADO"])); const pending = rejected ? null : nullableNumber(first(source, ["QTD_AEXPEDIR"]));
  const operational = rejected ? null : order.operationalStatusRaw || text(first(source, ["SITUACAO_PEDIDO", "situacao", "status"]));
  const fulfillmentStatus = rejected ? null : order.orderStatus;
  return {
    id: order.id, internalNumber: order.numPedido, erpOrderId: order.erpOrderId, erpOrderNumber: order.erpOrderNumber,
    importId: order.pedidoIdImportacao, createdAt: order.createdAt, expectedDeliveryDate: first(payload, ["DATA_PREV_ENTREGA"]),
    lastSyncAt: order.statusSyncedAt, syncStatus: order.status,
    opportunityStatus: order.opportunity.stage, operationalOrderStatus: rejected ? "UNKNOWN" : order.operationalOrderStatus,
    requestAuthorizationStatus: order.requestAuthorizationStatus,
    fulfillmentStatus, operationalStatus: operational, statusGroup: orderStatusGroup(order.status, operational, fulfillmentStatus),
    client: order.opportunity.client, seller: order.seller, opportunity: { id: order.opportunity.id, title: order.opportunity.title, stage: order.opportunity.stage },
    branch: text(first(payload, ["CODFILIAL"])), origin: "opportunity", totalValue: number(first(payload, ["VALOR_LIQUIDO"])) || number(order.opportunity.value),
    quantities: { ordered, billed, shipped, cancelled, pending }, invoice: { available: false, reason: "Associação pedido–NFe não instrumentada" },
    hasError: Boolean(order.syncErrors), rejectionMessage: rejected ? rejectionMessage(order.syncErrors) : null,
  };
};

// Na tela Pedidos, Pedidos e Valor total contam toda tentativa não recusada (`sent` e `pending`),
// para fechar com Aguardando + Em processamento + Parciais + Finalizados + Cancelados. A tentativa
// recusada (`error`) aparece só em "Recusados pelo ERP". O ganho efetivo segue só com `sent`.
export function summarizeOrders(items: Array<{ syncStatus: string; statusGroup: string; totalValue: number }>) {
  return items.reduce((acc, item) => {
    if (item.syncStatus !== "error") { acc.count++; acc.totalValue += item.totalValue; }
    acc[item.statusGroup]++;
    return acc;
  }, { count: 0, totalValue: 0, pending: 0, processing: 0, partial: 0, finished: 0, cancelled: 0, error: 0 } as Record<string, number>);
}
