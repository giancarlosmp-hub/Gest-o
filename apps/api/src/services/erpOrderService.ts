import {
  ErpOrderFulfillmentStatus,
  ErpOrderSyncStatus,
  Prisma,
  type OpportunityItem,
  type User,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { ultraFv3Client } from "./ultraFv3Client.js";

const SALESMEN_CONFIG_KEY = "erp.ultrafv3.salesmen";
const ERP_ORDER_ADVISORY_LOCK_NAMESPACE = 73_001;
const NUM_PEDIDO_PATTERN = /^[A-Za-z0-9._/-]{1,40}$/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type OrderParameterCodes = {
  paymentMethodCode: string;
  receivingConditionCode: string;
  priceTableCode: string;
  branchCode: string;
  operationCode: string;
};

type OpportunityForErpOrder = {
  id: string;
  stage: string;
  client: { code: string | null };
  ownerSeller: Pick<User, "id" | "erpCode" | "erpOperatorCode">;
  items: OpportunityItem[];
};

const pickFirstValue = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim() !== "")
      return value;
  }
  return null;
};

const pickFirstString = (payload: Record<string, unknown>, keys: string[]) => {
  const value = pickFirstValue(payload, keys);
  return value === null ? "" : String(value).trim();
};

const toArray = (payload: unknown) => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of [
      "data",
      "items",
      "rows",
      "result",
      "results",
      "content",
    ]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
};

const toJson = (payload: unknown): Prisma.InputJsonValue => {
  if (payload === undefined) return {} as Prisma.InputJsonValue;
  return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
};

const formatDateDot = (date: Date) => {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}.${month}.${year}`;
};

const normalizeOrderStatus = (
  payload: Record<string, unknown>,
): ErpOrderFulfillmentStatus | null => {
  const raw = pickFirstString(payload, [
    "status",
    "orderStatus",
    "situacao",
    "SITUACAO",
    "STATUS",
    "descricaoStatus",
  ]).toLowerCase();
  if (!raw) return null;
  if (/cancel/.test(raw)) return ErpOrderFulfillmentStatus.cancelado;
  if (/entreg/.test(raw)) return ErpOrderFulfillmentStatus.entregue;
  if (/parcial/.test(raw)) return ErpOrderFulfillmentStatus.parcial;
  if (/fatur|emitid|nota/.test(raw)) return ErpOrderFulfillmentStatus.faturado;
  if (/pend|abert|analise|análise|aguard/.test(raw))
    return ErpOrderFulfillmentStatus.pendente;
  return null;
};

const extractErpOrderNumber = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  return (
    pickFirstString(record, [
      "NUM_PEDIDO",
      "numPedido",
      "numeroPedido",
      "orderNumber",
      "pedido",
      "PEDIDO",
      "idPedido",
    ]) || null
  );
};

async function loadSalesmenRows(options: { forceRefresh?: boolean } = {}) {
  const stored = options.forceRefresh
    ? null
    : await prisma.appConfig.findUnique({
        where: { key: SALESMEN_CONFIG_KEY },
        select: { value: true },
      });
  if (stored?.value) {
    try {
      const parsed = JSON.parse(stored.value) as unknown;
      const rows = toArray(parsed);
      if (rows.length) return rows;
    } catch {
      // fall back to UltraFV3
    }
  }

  const response = await ultraFv3Client.request<unknown>("/salesmen");
  const rows = toArray(response);
  await prisma.appConfig.upsert({
    where: { key: SALESMEN_CONFIG_KEY },
    update: { value: JSON.stringify(rows) },
    create: { key: SALESMEN_CONFIG_KEY, value: JSON.stringify(rows) },
  });
  return rows;
}

async function resolveSalesmanOrderSequence(sellerErpCode: string) {
  const rows = await loadSalesmenRows({ forceRefresh: true });
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const payload = row as Record<string, unknown>;
    const code = pickFirstString(payload, [
      "code",
      "erpCode",
      "sellerCode",
      "salesmanCode",
      "vendedorCodigo",
      "codigo",
      "CODIGO",
      "codVendedor",
    ]);
    if (code !== sellerErpCode) continue;
    const numPedido = pickFirstString(payload, [
      "NUM_PEDIDO",
      "numPedido",
      "numeroPedido",
      "nextOrderNumber",
      "proximoPedido",
      "pedidoAtual",
    ]);
    return NUM_PEDIDO_PATTERN.test(numPedido) ? numPedido : "";
  }
  return "";
}

export async function createErpOrderFromOpportunity(
  opportunity: OpportunityForErpOrder,
  params: OrderParameterCodes,
) {
  if (opportunity.stage !== "ganho")
    throw Object.assign(
      new Error("Apenas oportunidades na etapa Ganha podem gerar pedido ERP."),
      { status: 400 },
    );
  if (!opportunity.client.code)
    throw Object.assign(new Error("Cliente sem código ERP."), { status: 400 });

  const sellerErpCode = opportunity.ownerSeller.erpCode?.trim();
  const operatorCode = opportunity.ownerSeller.erpOperatorCode?.trim();
  if (!sellerErpCode)
    throw Object.assign(new Error("Vendedor sem CODVENDEDOR ERP vinculado."), {
      status: 400,
    });
  if (!operatorCode)
    throw Object.assign(new Error("Vendedor sem OPERADOR ERP vinculado."), {
      status: 400,
    });
  if (!opportunity.items.length)
    throw Object.assign(new Error("Oportunidade sem itens para envio."), {
      status: 400,
    });
  if (opportunity.items.some((item) => !item.erpProductCode?.trim()))
    throw Object.assign(new Error("Há item sem código ERP."), { status: 400 });
  if (opportunity.items.some((item) => !item.unit?.trim()))
    throw Object.assign(new Error("Há item sem unidade de medida."), {
      status: 400,
    });

  const now = new Date();
  const pedidoIdImportacao = randomUUID();
  const operationContext = {
    opportunityId: opportunity.id,
    sellerId: opportunity.ownerSeller.id,
    sellerErpCode,
    operatorCode,
  };
  logApiEvent(
    "INFO",
    "[erp order] validating UltraFV3 order before submission",
    operationContext,
  );

  const numPedido = await resolveSalesmanOrderSequence(sellerErpCode);
  if (!numPedido)
    throw Object.assign(
      new Error(
        "Não foi possível resolver NUM_PEDIDO válido em /salesmen para o vendedor ERP vinculado.",
      ),
      { status: 400 },
    );

  const itens = opportunity.items.map((item) => ({
    CODPRODUTO: item.erpProductCode,
    CLASSIFICACAO: item.erpProductClassCode,
    QTD_PEDIDO: Number(item.quantity),
    PRECO: Number(item.unitPrice),
    UND_MEDIDA: item.unit,
    DESCONTO: Number(item.discountTotal || 0),
    VALOR_LIQUIDO: Number(item.netTotal || 0),
  }));
  const valorBruto = Number(
    opportunity.items
      .reduce((sum, item) => sum + Number(item.grossTotal || 0), 0)
      .toFixed(2),
  );
  const valorLiquido = Number(
    opportunity.items
      .reduce((sum, item) => sum + Number(item.netTotal || 0), 0)
      .toFixed(2),
  );

  const payload = {
    PEDIDO_ID_IMPORTACAO: pedidoIdImportacao,
    NUM_PEDIDO: numPedido,
    OPERADOR: operatorCode,
    DATA_EMISSAO: formatDateDot(now),
    DATA_ENTREGA: formatDateDot(now),
    TIPO_MOVIMENTO: "PEDIDO",
    FORMA: params.paymentMethodCode,
    CODCONDREC: params.receivingConditionCode,
    TABELA_PRECO: params.priceTableCode,
    CODFILIAL: params.branchCode,
    CODOPER: params.operationCode,
    PARCEIRO: opportunity.client.code,
    VENDEDOR: sellerErpCode,
    VALOR_BRUTO: valorBruto,
    VALOR_LIQUIDO: valorLiquido,
    ITENS: itens,
  };

  const sync = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ERP_ORDER_ADVISORY_LOCK_NAMESPACE}, hashtext(${opportunity.id}))`;

    const existingOpenSync = await tx.erpOrderSync.findFirst({
      where: {
        opportunityId: opportunity.id,
        status: { in: [ErpOrderSyncStatus.pending, ErpOrderSyncStatus.sent] },
      },
      orderBy: [{ createdAt: "desc" }],
    });

    if (existingOpenSync) {
      throw Object.assign(
        new Error(
          "Oportunidade já possui sincronização ERP pendente/enviada. Consulte o histórico antes de reenviar.",
        ),
        {
          status: 409,
          existingErpOrderSyncId: existingOpenSync.id,
          pedidoIdImportacao: existingOpenSync.pedidoIdImportacao,
        },
      );
    }

    return tx.erpOrderSync.create({
      data: {
        opportunityId: opportunity.id,
        sellerId: opportunity.ownerSeller.id,
        pedidoIdImportacao,
        numPedido,
        status: ErpOrderSyncStatus.pending,
        payloadSent: toJson(payload),
      },
    });
  });

  logApiEvent("INFO", "[erp order] pending UltraFV3 order sync persisted", {
    ...operationContext,
    pedidoIdImportacao,
    numPedido,
    erpOrderSyncId: sync.id,
  });

  try {
    const erpResponse = await ultraFv3Client.request<unknown>("/orders", {
      method: "POST",
      body: payload,
    });
    const erpOrderNumber = extractErpOrderNumber(erpResponse) || numPedido;
    const updated = await prisma.erpOrderSync.update({
      where: { id: sync.id },
      data: {
        status: ErpOrderSyncStatus.sent,
        erpOrderNumber,
        erpResponse: toJson(erpResponse),
        syncErrors: Prisma.JsonNull,
        sentAt: new Date(),
      },
    });
    logApiEvent("INFO", "[erp order] order sent to UltraFV3", {
      ...operationContext,
      pedidoIdImportacao,
      numPedido,
      erpOrderNumber,
      erpOrderSyncId: sync.id,
    });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.erpOrderSync.update({
      where: { id: sync.id },
      data: {
        status: ErpOrderSyncStatus.error,
        erpResponse: toJson({ message }),
        syncErrors: toJson([{ message, at: new Date().toISOString() }]),
      },
    });
    logApiEvent("ERROR", "[erp order] UltraFV3 order submission failed", {
      ...operationContext,
      pedidoIdImportacao,
      numPedido,
      erpOrderSyncId: sync.id,
      error: message,
    });
    throw Object.assign(error instanceof Error ? error : new Error(message), {
      pedidoIdImportacao,
      status: 502,
    });
  }
}

export async function syncErpOrderStatuses(opportunityId?: string) {
  const orders = await prisma.erpOrderSync.findMany({
    where: {
      status: ErpOrderSyncStatus.sent,
      ...(opportunityId ? { opportunityId } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
  });

  let syncedCount = 0;
  let errorCount = 0;
  for (const order of orders) {
    const query =
      order.erpOrderNumber || order.numPedido || order.pedidoIdImportacao;
    try {
      const response = await ultraFv3Client.request<unknown>(
        `/orderStatus?pedido=${encodeURIComponent(query)}`,
      );
      const rows = toArray(response);
      const statusPayload = (
        rows[0] && typeof rows[0] === "object"
          ? rows[0]
          : response && typeof response === "object"
            ? response
            : {}
      ) as Record<string, unknown>;
      const orderStatus =
        normalizeOrderStatus(statusPayload) ??
        order.orderStatus ??
        ErpOrderFulfillmentStatus.pendente;
      await prisma.erpOrderSync.update({
        where: { id: order.id },
        data: {
          orderStatus,
          lastStatusPayload: toJson(response),
          syncErrors: Prisma.JsonNull,
          statusSyncedAt: new Date(),
        },
      });
      syncedCount += 1;
      logApiEvent("INFO", "[erp order status] UltraFV3 order status synced", {
        erpOrderSyncId: order.id,
        opportunityId: order.opportunityId,
        pedidoIdImportacao: order.pedidoIdImportacao,
        query,
        orderStatus,
      });
    } catch (error) {
      errorCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      await prisma.erpOrderSync.update({
        where: { id: order.id },
        data: {
          syncErrors: toJson([
            { message, at: new Date().toISOString(), operation: "orderStatus" },
          ]),
          statusSyncedAt: new Date(),
        },
      });
      logApiEvent(
        "ERROR",
        "[erp order status] UltraFV3 order status sync failed",
        {
          erpOrderSyncId: order.id,
          opportunityId: order.opportunityId,
          pedidoIdImportacao: order.pedidoIdImportacao,
          query,
          error: message,
        },
      );
      await sleep(250);
    }
  }

  return { syncedCount, errorCount };
}
