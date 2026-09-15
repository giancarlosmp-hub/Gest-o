import { prisma } from "../config/prisma.js";

export type EffectiveOrder = {
  id: string;
  tenantId: string | null;
  operationalOrderStatus: string;
  erpOrderId?: string | null;
  erpOrderNumber?: string | null;
  pedidoIdImportacao: string;
  supersedesErpOrderSyncId?: string | null;
  payloadSent?: unknown;
};
export type EffectiveWinState = {
  value: number;
  count: 0 | 1;
  disregarded: boolean;
  partialCancellation: boolean;
  reason: string | null;
  originalValue: number;
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const amount = (order: EffectiveOrder) => {
  const value = Number(object(order.payloadSent).VALOR_LIQUIDO);
  return Number.isFinite(value) && value >= 0 ? value : null;
};
const identity = (order: EffectiveOrder) => order.erpOrderId || order.erpOrderNumber || order.pedidoIdImportacao;

/** Pure, idempotent projection. Commercial stage/history are intentionally not mutated. */
export function effectiveWonContribution(opportunity: { tenantId: string | null; value: number; erpOrderSyncs?: EffectiveOrder[] }): EffectiveWinState {
  const linked = (opportunity.erpOrderSyncs || []).filter((order) => order.tenantId === opportunity.tenantId);
  const unchanged = { value: opportunity.value, count: 1 as const, disregarded: false, partialCancellation: false, reason: null, originalValue: opportunity.value };
  if (!linked.length) return unchanged;

  const explicitlySupersededIds = new Set(linked.map((order) => order.supersedesErpOrderSyncId).filter((id): id is string => Boolean(id)));
  const unique = new Map<string, EffectiveOrder>();
  for (const order of linked) {
    if (explicitlySupersededIds.has(order.id)) continue;
    unique.set(identity(order), order);
  }
  const effectiveOrders = [...unique.values()];
  const cancelled = effectiveOrders.filter((order) => order.operationalOrderStatus === "CANCELADO");
  if (!cancelled.length) return unchanged;
  const valid = effectiveOrders.filter((order) => order.operationalOrderStatus !== "CANCELADO");
  if (!valid.length) return { value: 0, count: 0, disregarded: true, partialCancellation: false, reason: "Ganho desconsiderado — pedido cancelado no ERP", originalValue: opportunity.value };

  // With multiple effective orders, each remaining order keeps only its explicit ERP amount.
  // Never estimate a proportional share of the opportunity value.
  const validAmounts = valid.map(amount);
  if (validAmounts.some((value) => value === null)) {
    return { ...unchanged, partialCancellation: true, reason: "Cancelamento entre múltiplos pedidos — valor efetivo não confirmado por falta do valor de pedido remanescente" };
  }
  const validTotal = validAmounts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const allAmounts = effectiveOrders.map(amount);
  const declaredTotal = allAmounts.every((value) => value !== null)
    ? allAmounts.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  const mismatch = declaredTotal !== null && Math.abs(declaredTotal - opportunity.value) > 0.01;
  return {
    value: validTotal,
    count: 1,
    disregarded: false,
    partialCancellation: true,
    reason: mismatch
      ? "Ganho parcialmente considerado pelos valores explícitos dos pedidos; valor da oportunidade diverge da soma dos pedidos"
      : "Ganho parcialmente considerado — pedido cancelado no ERP",
    originalValue: opportunity.value,
  };
}

export async function loadEffectiveWonContributions(opportunities: Array<{ id: string; value: number; client: { tenantId: string | null } }>) {
  if (!opportunities.length) return new Map<string, EffectiveWinState>();
  const tenantByOpportunity = new Map(opportunities.map((opportunity) => [opportunity.id, opportunity.client.tenantId]));
  const orders = await prisma.erpOrderSync.findMany({
    where: { opportunityId: { in: opportunities.map((opportunity) => opportunity.id) } },
    select: { id: true, opportunityId: true, tenantId: true, operationalOrderStatus: true, erpOrderId: true, erpOrderNumber: true, pedidoIdImportacao: true, supersedesErpOrderSyncId: true, payloadSent: true },
  });
  const byOpportunity = new Map<string, EffectiveOrder[]>();
  for (const order of orders) {
    if (tenantByOpportunity.get(order.opportunityId) !== order.tenantId) continue;
    byOpportunity.set(order.opportunityId, [...(byOpportunity.get(order.opportunityId) || []), order]);
  }
  return new Map(opportunities.map((opportunity) => [opportunity.id, effectiveWonContribution({ tenantId: opportunity.client.tenantId, value: opportunity.value, erpOrderSyncs: byOpportunity.get(opportunity.id) || [] })]));
}

export function withEffectiveWin<T extends { id: string; stage: string; value: number; client: { tenantId: string | null } }>(opportunity: T, states: Map<string, EffectiveWinState>) {
  return { ...opportunity, effectiveWin: opportunity.stage === "ganho" ? states.get(opportunity.id) ?? effectiveWonContribution({ tenantId: opportunity.client.tenantId, value: opportunity.value }) : null };
}

/** Shared aggregate used by dashboards, reports and exports without changing their date/access filters. */
export async function loadEffectiveWonTotals(where: Record<string, unknown>) {
  const opportunities = await prisma.opportunity.findMany({
    where: where as never,
    select: { id: true, ownerSellerId: true, value: true, client: { select: { tenantId: true } } },
  });
  const states = await loadEffectiveWonContributions(opportunities);
  return opportunities.reduce<Record<string, { value: number; count: number }>>((totals, opportunity) => {
    const state = states.get(opportunity.id)!;
    totals[opportunity.ownerSellerId] ??= { value: 0, count: 0 };
    totals[opportunity.ownerSellerId].value += state.value;
    totals[opportunity.ownerSellerId].count += state.count;
    return totals;
  }, {});
}
