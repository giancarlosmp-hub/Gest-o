import { ErpOrderSyncStatus } from "@prisma/client";
import { VALID_ERP_ORDER_SYNC_STATUS, findOpenErpOrderErrorOpportunityIds, hasErpOperationalAlert } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";

type ErpOrderSyncReader = Pick<typeof prisma, "erpOrderSync">;

// Lê só as tentativas `error` e as `sent` das mesmas oportunidades; a regra fica na função compartilhada.
export async function countOpenErpOrderErrors(db: ErpOrderSyncReader = prisma) {
  const errorAttempts = await db.erpOrderSync.findMany({
    where: { status: ErpOrderSyncStatus.error },
    select: { opportunityId: true, status: true, createdAt: true, manualResolution: { select: { id: true } } },
  });
  if (!errorAttempts.length) return 0;
  const sentAttempts = await db.erpOrderSync.findMany({
    where: { status: ErpOrderSyncStatus.sent, opportunityId: { in: [...new Set(errorAttempts.map((attempt) => attempt.opportunityId))] } },
    select: { opportunityId: true, status: true, createdAt: true },
  });
  return findOpenErpOrderErrorOpportunityIds([
    ...errorAttempts.map((attempt) => ({ opportunityId: attempt.opportunityId, status: attempt.status, createdAt: attempt.createdAt, hasManualResolution: Boolean(attempt.manualResolution) })),
    ...sentAttempts.map((attempt) => ({ ...attempt, hasManualResolution: false })),
  ]).length;
}

// Fonte única dos cards de pedidos da Integração ERP e da Saúde da Plataforma.
// errorOrders é o histórico (tentativas `error`); openErrorOrders conta oportunidades com erro em aberto.
export async function getErpOrderOperationalSummary(db: ErpOrderSyncReader = prisma) {
  const [sentOrders, pendingOrders, errorOrders, openErrorOrders, fulfilledOrders, lastOrderSync] = await Promise.all([
    db.erpOrderSync.count({ where: { status: ErpOrderSyncStatus.sent } }),
    db.erpOrderSync.count({ where: { status: ErpOrderSyncStatus.pending } }),
    db.erpOrderSync.count({ where: { status: ErpOrderSyncStatus.error } }),
    countOpenErpOrderErrors(db),
    // "Sincronizados": só pedido válido (`sent`) com situação conferida; tentativa recusada não entra.
    db.erpOrderSync.count({ where: { status: VALID_ERP_ORDER_SYNC_STATUS, orderStatus: { not: null } } }),
    db.erpOrderSync.findFirst({
      orderBy: [{ updatedAt: "desc" }],
      select: { updatedAt: true, sentAt: true, statusSyncedAt: true },
    }),
  ]);

  return {
    sentOrders,
    pendingOrders,
    errorOrders,
    openErrorOrders,
    syncedOrders: fulfilledOrders,
    lastOrderActivityAt: lastOrderSync?.statusSyncedAt?.toISOString()
      ?? lastOrderSync?.sentAt?.toISOString()
      ?? lastOrderSync?.updatedAt.toISOString()
      ?? null,
  };
}

// GET /erp/ultrafv3/healthcheck: 207 só com falha de sincronização ou pedido com erro em aberto.
export function buildErpHealthcheckResponse<TStatus extends Record<string, { status?: string | null }>, TIntegration extends { isConfigured: boolean }>(
  status: TStatus,
  integration: TIntegration,
  operational: Awaited<ReturnType<typeof getErpOrderOperationalSummary>>,
) {
  const scopeErrors = Object.values(status).filter((item) => item.status === "error").length;
  const hasOperationalErrors = hasErpOperationalAlert({ scopeErrors, openErrorOrders: operational.openErrorOrders });
  return {
    httpStatus: hasOperationalErrors ? 207 : 200,
    body: { ok: integration.isConfigured && !hasOperationalErrors, integration, operational, status },
  };
}
