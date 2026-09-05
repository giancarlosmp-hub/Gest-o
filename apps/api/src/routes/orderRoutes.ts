import { Router, type Request } from "express";
import { ErpOrderSyncStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { appUsageRateLimit } from "../middlewares/rateLimit.js";
import { sanitizeErpOrderErrorMessage } from "../services/erpOrderService.js";

const router = Router();
router.use(authMiddleware, appUsageRateLimit);

const querySchema = z.object({
  search: z.string().trim().max(120).optional(), status: z.string().trim().max(40).optional(),
  sellerId: z.string().trim().max(80).optional(), clientId: z.string().trim().max(80).optional(),
  origin: z.enum(["opportunity"]).optional(), branch: z.string().trim().max(30).optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(), page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const first = (row: Record<string, unknown>, keys: string[]) => keys.map((key) => row[key]).find((value) => value !== undefined && value !== null && String(value).trim() !== "");
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value: unknown) => value === undefined || value === null ? null : String(value).trim() || null;
const responseRoot = (value: unknown) => {
  const root = object(value); const nested = object(root.data || root.result || root.pedido || root.order);
  return Object.keys(nested).length ? nested : root;
};
const statusGroup = (sync: string, operational: string | null, fulfillment: string | null) => {
  if (sync === "error") return "error";
  if (sync === "pending") return "pending";
  const raw = (operational || "").toUpperCase();
  if (raw === "CANCELADO" || fulfillment === "cancelado") return "cancelled";
  if (raw === "FINALIZADO" || fulfillment === "entregue") return "finished";
  if (raw === "PARCIAL" || fulfillment === "parcial") return "partial";
  return "processing";
};

async function tenantIdFor(req: Request) {
  const memberships = await prisma.tenantMembership.findMany({ where: { userId: req.user!.id, status: "active", tenant: { status: "active" } }, select: { tenantId: true } });
  if (memberships.length !== 1) throw Object.assign(new Error("Contexto de tenant ausente ou ambíguo."), { status: 403 });
  return memberships[0].tenantId;
}

const baseWhere = (req: Request, tenantId: string): Prisma.ErpOrderSyncWhereInput => ({
  opportunity: { client: { tenantId }, ...(req.user!.role === "vendedor" ? { ownerSellerId: req.user!.id } : {}) },
});

const serialize = (order: any) => {
  const payload = object(order.payloadSent); const erp = responseRoot(order.erpResponse); const statusPayload = responseRoot(order.lastStatusPayload);
  const source = Object.keys(statusPayload).length ? statusPayload : erp;
  const ordered = number(first(source, ["QTD_PEDIDO"]) ?? first(payload, ["QTD_PEDIDO"]));
  const billed = number(first(source, ["QTD_FATURADO"])); const shipped = number(first(source, ["QTD_EXPEDIDO"]));
  const cancelled = number(first(source, ["QTD_CANCELADO"])); const pending = number(first(source, ["QTD_AEXPEDIR"]));
  const operational = order.operationalStatusRaw || text(first(source, ["SITUACAO_PEDIDO", "situacao", "status"]));
  return {
    id: order.id, internalNumber: order.numPedido, erpOrderId: order.erpOrderId, erpOrderNumber: order.erpOrderNumber,
    importId: order.pedidoIdImportacao, createdAt: order.createdAt, expectedDeliveryDate: first(payload, ["DATA_PREV_ENTREGA"]),
    lastSyncAt: order.statusSyncedAt || order.sentAt || order.updatedAt, syncStatus: order.status,
    opportunityStatus: order.opportunity.stage, operationalOrderStatus: order.operationalOrderStatus,
    requestAuthorizationStatus: order.requestAuthorizationStatus,
    fulfillmentStatus: order.orderStatus, operationalStatus: operational, statusGroup: statusGroup(order.status, operational, order.orderStatus),
    client: order.opportunity.client, seller: order.seller, opportunity: { id: order.opportunity.id, title: order.opportunity.title, stage: order.opportunity.stage },
    branch: text(first(payload, ["CODFILIAL"])), origin: "opportunity", totalValue: number(first(payload, ["VALOR_LIQUIDO"])) || number(order.opportunity.value),
    quantities: { ordered, billed, shipped, cancelled, pending }, invoice: { available: false, reason: "Associação pedido–NFe não instrumentada" },
    hasError: Boolean(order.syncErrors),
  };
};

router.get("/orders", async (req, res) => {
  try {
    const parsed = querySchema.safeParse(req.query); if (!parsed.success) return res.status(400).json({ message: "Filtros inválidos", errors: parsed.error.issues });
    const tenantId = await tenantIdFor(req); const q = parsed.data; const where: Prisma.ErpOrderSyncWhereInput = { ...baseWhere(req, tenantId) };
    if (q.sellerId && req.user!.role !== "vendedor") where.sellerId = q.sellerId;
    if (q.clientId) where.opportunity = { ...(where.opportunity as object), clientId: q.clientId };
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) };
    if (q.search) where.OR = [
      { numPedido: { contains: q.search, mode: "insensitive" } }, { erpOrderNumber: { contains: q.search, mode: "insensitive" } },
      { opportunity: { client: { tenantId, OR: [{ name: { contains: q.search, mode: "insensitive" } }, { code: { contains: q.search, mode: "insensitive" } }] } } },
    ];
    const rows = await prisma.erpOrderSync.findMany({ where, include: { seller: { select: { id: true, name: true } }, opportunity: { select: { id: true, title: true, stage: true, value: true, client: { select: { id: true, code: true, name: true, fantasyName: true } } } } }, orderBy: [{ createdAt: "desc" }] });
    let items = rows.map(serialize);
    if (q.status) items = items.filter((item) => item.statusGroup === q.status || item.operationalStatus?.toLowerCase() === q.status?.toLowerCase());
    if (q.branch) items = items.filter((item) => item.branch === q.branch);
    const summary = items.reduce((acc, item) => { acc.count++; acc.totalValue += item.totalValue; acc[item.statusGroup]++; return acc; }, { count: 0, totalValue: 0, pending: 0, processing: 0, partial: 0, finished: 0, cancelled: 0, error: 0 } as Record<string, number>);
    const start = (q.page - 1) * q.pageSize;
    return res.json({ items: items.slice(start, start + q.pageSize), summary, pagination: { page: q.page, pageSize: q.pageSize, total: items.length }, filters: { sellers: Array.from(new Map(items.map((item) => [item.seller.id, item.seller])).values()) } });
  } catch (error) { return res.status((error as any)?.status || 500).json({ message: sanitizeErpOrderErrorMessage(error instanceof Error ? error.message : error) }); }
});

router.get("/orders/:id", async (req, res) => {
  try {
    const tenantId = await tenantIdFor(req);
    const order = await prisma.erpOrderSync.findFirst({ where: { id: req.params.id, ...baseWhere(req, tenantId) }, include: { seller: { select: { id: true, name: true } }, statusHistory: { orderBy: { occurredAt: "desc" } }, opportunity: { select: { id: true, title: true, stage: true, value: true, notes: true, client: { select: { id: true, code: true, name: true, fantasyName: true } }, items: { orderBy: { lineNumber: "asc" } } } } } });
    if (!order) return res.status(404).json({ message: "Pedido não encontrado" });
    const payload = object(order.payloadSent); const erp = responseRoot(order.erpResponse); const erpItems = array(first(erp, ["ITENS", "itens"])).map(object);
    const itemByLine = new Map(erpItems.map((item) => [number(first(item, ["ITEM", "item"])), item]));
    const items = order.opportunity.items.map((item) => { const remote = itemByLine.get(item.lineNumber) || {}; return { id: item.id, lineNumber: item.lineNumber, productCode: item.erpProductCode, productClassCode: item.erpProductClassCode, description: item.productNameSnapshot, unit: item.unit, quantities: { ordered: item.quantity, billed: number(first(remote, ["QTD_FATURADO"])), shipped: number(first(remote, ["QTD_EXPEDIDO"])), cancelled: number(first(remote, ["QTD_CANCELADO"])), pending: number(first(remote, ["QTD_AEXPEDIR"])) }, values: { unit: item.unitPrice, gross: item.grossTotal, discount: item.discountTotal, net: item.netTotal } }; });
    return res.json({ ...serialize(order), notes: text(first(payload, ["OBS_PEDIDO"])), items, history: order.statusHistory.map((event) => ({ ...event, errorMessage: event.errorMessage ? sanitizeErpOrderErrorMessage(event.errorMessage) : null })), errors: order.syncErrors ? [{ message: sanitizeErpOrderErrorMessage(first(object(array(order.syncErrors)[0]), ["message"]) || "Falha de sincronização"), at: order.statusSyncedAt || order.updatedAt }] : [] });
  } catch (error) { return res.status((error as any)?.status || 500).json({ message: sanitizeErpOrderErrorMessage(error instanceof Error ? error.message : error) }); }
});

export default router;
