import {
  ErpOrderFulfillmentStatus,
  ErpOrderSyncStatus,
  Prisma,
  type OpportunityItem,
  type Product,
  type User,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { normalizeErpParameterCode, type ErpOrderGenerationInput, type ErpOrderParameterValue } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { ultraFv3Client, type UltraFv3Credentials } from "./ultraFv3Client.js";
import { decryptErpCredential } from "./erpCredentialCrypto.js";
import { requestUltraFv3ReadOnlyWithCredentialsRetry, requestUltraFv3ReadOnlyWithRetry } from "./ultraFv3SyncService.js";

const SALESMEN_CONFIG_KEY = "erp.ultrafv3.salesmen";
const ERP_ORDER_ADVISORY_LOCK_NAMESPACE = 73_001;
const NUM_PEDIDO_PATTERN = /^[A-Za-z0-9._/-]{1,40}$/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type OrderParameterCodes = Pick<
  ErpOrderGenerationInput,
  "paymentMethodCode" | "receivingConditionCode" | "priceTableCode" | "branchCode" | "operationCode" | "simulateOnly"
>;

type NormalizedOrderParameterCodes = {
  paymentMethodCode: string;
  receivingConditionCode: string;
  priceTableCode: string;
  branchCode: string;
  operationCode: string;
  simulateOnly: boolean;
};

export type ErpOrderParameterDiagnostics = {
  paymentMethodCodeRaw: unknown;
  paymentMethodCodeNormalized: string;
  receivingConditionCodeRaw: unknown;
  receivingConditionCodeNormalized: string;
  priceTableCodeRaw: unknown;
  priceTableCodeNormalized: string;
  branchCodeRaw: unknown;
  branchCodeNormalized: string;
  operationCodeRaw: unknown;
  operationCodeNormalized: string;
};

const toSafeParameterRawValue = (value: ErpOrderParameterValue | undefined): unknown => {
  if (typeof value === "string" || typeof value === "number" || value == null) return value ?? null;
  if (typeof value !== "object" || Array.isArray(value)) return null;

  const safe: Record<string, unknown> = {};
  for (const key of ["code", "value", "label"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number") safe[key] = candidate;
  }
  return safe;
};

export const normalizeErpOrderParameterCodes = (params: Partial<OrderParameterCodes>): NormalizedOrderParameterCodes => ({
  paymentMethodCode: normalizeErpParameterCode(params.paymentMethodCode),
  receivingConditionCode: normalizeErpParameterCode(params.receivingConditionCode),
  priceTableCode: normalizeErpParameterCode(params.priceTableCode),
  branchCode: normalizeErpParameterCode(params.branchCode),
  operationCode: normalizeErpParameterCode(params.operationCode),
  simulateOnly: params.simulateOnly === true,
});

export const getErpOrderParameterDiagnostics = (params: Partial<OrderParameterCodes>): ErpOrderParameterDiagnostics => {
  const normalized = normalizeErpOrderParameterCodes(params);
  return {
    paymentMethodCodeRaw: toSafeParameterRawValue(params.paymentMethodCode),
    paymentMethodCodeNormalized: normalized.paymentMethodCode,
    receivingConditionCodeRaw: toSafeParameterRawValue(params.receivingConditionCode),
    receivingConditionCodeNormalized: normalized.receivingConditionCode,
    priceTableCodeRaw: toSafeParameterRawValue(params.priceTableCode),
    priceTableCodeNormalized: normalized.priceTableCode,
    branchCodeRaw: toSafeParameterRawValue(params.branchCode),
    branchCodeNormalized: normalized.branchCode,
    operationCodeRaw: toSafeParameterRawValue(params.operationCode),
    operationCodeNormalized: normalized.operationCode,
  };
};

type OpportunityForErpOrder = {
  id: string;
  stage: string;
  client: {
    code: string | null;
    erpCode?: string | null;
    externalCode?: string | null;
    erpClientCode?: string | null;
    rawPayload?: Prisma.JsonValue | null;
  };
  ownerSeller: Pick<User, "id" | "erpCode" | "erpOperatorCode" | "erpLoginUsername" | "erpLoginPasswordEncrypted">;
  items: Array<OpportunityItem & { product?: Pick<Product, "stockQuantity"> | null }>;
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


const referenceCodeKeys: Record<string, string[]> = {
  priceTables: ["TABELA", "CODTABELA", "COD_TABELA", "ID_TABELA", "TABELA_PRECO", "code", "codigo", "CODIGO", "id", "ID", "value"],
  operations: ["CODOPER", "OPERACAO", "COD_OPERACAO", "code", "codigo", "CODIGO", "id", "ID", "value"],
};

async function assertReferenceCode(scope: "priceTables" | "operations", code: string, message: string) {
  const normalizedCode = normalizeErpParameterCode(code);
  const stored = await prisma.appConfig.findUnique({
    where: { key: `erp.ultrafv3.${scope}` },
    select: { value: true },
  });
  if (!stored?.value) return;
  try {
    const rows = toArray(JSON.parse(stored.value));
    if (!rows.length) return;
    const exists = rows.some((row) => {
      if (!row || typeof row !== "object") return false;
      return normalizeErpParameterCode(pickFirstString(row as Record<string, unknown>, referenceCodeKeys[scope])) === normalizedCode;
    });
    if (!exists) throw Object.assign(new Error(message), { status: 400 });
  } catch (error) {
    if (error instanceof Error && (error as any).status) throw error;
  }
}

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

async function loadSalesmenRows(options: { forceRefresh?: boolean; credentials?: UltraFv3Credentials; correlationId?: string } = {}) {
  if (!options.credentials) {
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

    const response = await ultraFv3Client.request<unknown>("/salesmen", { correlationId: options.correlationId });
    const rows = toArray(response);
    await prisma.appConfig.upsert({
      where: { key: SALESMEN_CONFIG_KEY },
      update: { value: JSON.stringify(rows) },
      create: { key: SALESMEN_CONFIG_KEY, value: JSON.stringify(rows) },
    });
    return rows;
  }

  const response = await requestUltraFv3ReadOnlyWithCredentialsRetry<unknown>("/salesmen", options.credentials, options.correlationId || randomUUID());
  return toArray(response);
}

async function resolveSalesmanOrderSequence(sellerErpCode: string, credentials: UltraFv3Credentials, correlationId: string) {
  const rows = await loadSalesmenRows({ forceRefresh: true, credentials, correlationId });
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
  rawParams: OrderParameterCodes,
) {
  const params = normalizeErpOrderParameterCodes(rawParams);
  const parameterDiagnostics = getErpOrderParameterDiagnostics(rawParams);
  const missingParameter = Object.entries(params).find(([key, value]) => key !== "simulateOnly" && !value);
  if (missingParameter)
    throw Object.assign(new Error(`Payload inválido: código ERP ausente em ${missingParameter[0]}.`), {
      status: 400,
      parameterDiagnostics,
    });

  if (opportunity.stage !== "ganho")
    throw Object.assign(
      new Error("Operação inválida: apenas oportunidades na etapa Ganha podem gerar pedido ERP."),
      { status: 400 },
    );

  const clientPayload = opportunity.client as Record<string, unknown>;
  const rawClientPayload = clientPayload.rawPayload && typeof clientPayload.rawPayload === "object"
    ? (clientPayload.rawPayload as Record<string, unknown>)
    : {};
  const clientErpCode = pickFirstString(clientPayload, ["code", "erpCode", "externalCode", "erpClientCode"])
    || pickFirstString(rawClientPayload, ["PARCEIRO", "CODPARCEIRO", "CODCLIENTE", "code", "erpCode", "codigo", "CODIGO", "partnerCode"]);
  if (!clientErpCode)
    throw Object.assign(new Error(`Cliente sem código ERP para gerar pedido. opportunityId=${opportunity.id}; campos disponíveis: code=${String((opportunity.client as Record<string, unknown>).code || "")}, raw.PARCEIRO=${String(rawClientPayload.PARCEIRO || "")}, raw.CODPARCEIRO=${String(rawClientPayload.CODPARCEIRO || "")}, raw.CODCLIENTE=${String(rawClientPayload.CODCLIENTE || "")}. Sugestão: sincronizar /partners novamente (bug de sync se continuar vazio).`), { status: 400 });

  const sellerErpCode = opportunity.ownerSeller.erpCode?.trim();
  const operatorCode = opportunity.ownerSeller.erpOperatorCode?.trim();
  const sellerFv3Username = opportunity.ownerSeller.erpLoginUsername?.trim();
  if (!sellerErpCode)
    throw Object.assign(new Error("Vendedor sem vínculo ERP: informe o CODVENDEDOR no cadastro do usuário."), {
      status: 400,
    });
  if (!operatorCode)
    throw Object.assign(new Error("Vendedor sem OPERADOR: campo ausente em ownerSeller.erpOperatorCode. Sugestão: testar Login FV3 do vendedor para capturar OPERADOR automaticamente."), {
      status: 400,
    });
  if (!sellerFv3Username || !opportunity.ownerSeller.erpLoginPasswordEncrypted)
    throw Object.assign(new Error("Vendedor sem Login FV3/Senha FV3: configure as credenciais UltraFV3 no cadastro do usuário antes de gerar pedido ERP."), {
      status: 400,
    });
  const sellerCredentials = {
    username: sellerFv3Username,
    password: decryptErpCredential(opportunity.ownerSeller.erpLoginPasswordEncrypted),
  };
  if (!opportunity.items.length)
    throw Object.assign(new Error("Operação inválida: oportunidade sem itens para envio ao ERP."), {
      status: 400,
    });
  if (opportunity.items.some((item) => !item.erpProductCode?.trim()))
    throw Object.assign(new Error("Payload inválido: há item sem código ERP."), { status: 400 });
  if (opportunity.items.some((item) => !item.unit?.trim()))
    throw Object.assign(new Error("Payload inválido: há item sem unidade de medida."), {
      status: 400,
    });
  if (opportunity.items.some((item) => Number(item.unitPrice) <= 0 || Number(item.netTotal) <= 0))
    throw Object.assign(new Error("Payload inválido: pedido ERP bloqueado por item com preço zerado."), {
      status: 400,
    });
  const insufficientStockItem = opportunity.items.find((item) => {
    const stockQuantity = item.product?.stockQuantity;
    return typeof stockQuantity === "number" && stockQuantity < Number(item.quantity || 0);
  });
  if (insufficientStockItem)
    throw Object.assign(
      new Error(`Estoque insuficiente para ${insufficientStockItem.productNameSnapshot}. Disponível: ${insufficientStockItem.product?.stockQuantity ?? 0}.`),
      { status: 400 },
    );

  try {
    await assertReferenceCode("priceTables", params.priceTableCode, "Tabela preço inválida para emissão ERP.");
    await assertReferenceCode("operations", params.operationCode, "Operação inválida para emissão ERP.");
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { parameterDiagnostics });
    throw error;
  }

  const now = new Date();
  const pedidoIdImportacao = randomUUID();
  const operationContext = {
    opportunityId: opportunity.id,
    sellerId: opportunity.ownerSeller.id,
    sellerErpCode,
    operatorCode,
    authMode: "seller",
    orderParameterCodes: {
      paymentMethodCode: params.paymentMethodCode,
      receivingConditionCode: params.receivingConditionCode,
      priceTableCode: params.priceTableCode,
      branchCode: params.branchCode,
      operationCode: params.operationCode,
    },
  };
  logApiEvent(
    "INFO",
    "[erp order] validating UltraFV3 order before submission",
    operationContext,
  );

  const sellerToken = await ultraFv3Client.authenticateWithCredentials(sellerCredentials);
  const tokenOperatorCode = sellerToken.tokenPayload.operator?.trim() || null;
  const tokenSalesmanCode = sellerToken.tokenPayload.salesman?.trim() || null;
  const effectiveOperatorCode = tokenOperatorCode || operatorCode;
  const effectiveSellerErpCode = tokenSalesmanCode || sellerErpCode;

  const numPedido = await resolveSalesmanOrderSequence(effectiveSellerErpCode, sellerCredentials, pedidoIdImportacao);
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
    OPERADOR: effectiveOperatorCode,
    DATA_EMISSAO: formatDateDot(now),
    DATA_ENTREGA: formatDateDot(now),
    TIPO_MOVIMENTO: "PEDIDO",
    FORMA: params.paymentMethodCode,
    CODCONDREC: params.receivingConditionCode,
    TABELA_PRECO: params.priceTableCode,
    CODFILIAL: params.branchCode,
    CODOPER: params.operationCode,
    PARCEIRO: clientErpCode,
    VENDEDOR: effectiveSellerErpCode,
    VALOR_BRUTO: valorBruto,
    VALOR_LIQUIDO: valorLiquido,
    ITENS: itens,
  };

  if (params.simulateOnly) {
    logApiEvent("INFO", "[erp order simulation] UltraFV3 order payload validated without submission", {
      ...operationContext,
      pedidoIdImportacao,
      numPedido,
    });
    return {
      id: `simulation-${pedidoIdImportacao}`,
      opportunityId: opportunity.id,
      sellerId: opportunity.ownerSeller.id,
      pedidoIdImportacao,
      numPedido,
      erpOrderNumber: null,
      status: ErpOrderSyncStatus.pending,
      orderStatus: null,
      payloadSent: toJson(payload),
      erpResponse: toJson({ simulation: true, message: "Payload validado em modo simulação ERP. Pedido real não enviado." }),
      syncErrors: null,
      lastStatusPayload: null,
      sentAt: null,
      statusSyncedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  const sync = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ERP_ORDER_ADVISORY_LOCK_NAMESPACE}, hashtext(${opportunity.id}))`;

    const existingSuccessfulSync = await tx.erpOrderSync.findFirst({
      where: {
        opportunityId: opportunity.id,
        status: ErpOrderSyncStatus.sent,
        NOT: { orderStatus: ErpOrderFulfillmentStatus.cancelado },
      },
      orderBy: [{ createdAt: "desc" }],
    });

    if (existingSuccessfulSync) {
      throw Object.assign(
        new Error(
          "Oportunidade já possui pedido ERP enviado com sucesso. Reenvio bloqueado para evitar duplicidade.",
        ),
        {
          status: 409,
          existingErpOrderSyncId: existingSuccessfulSync.id,
          pedidoIdImportacao: existingSuccessfulSync.pedidoIdImportacao,
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
    const erpResponse = await ultraFv3Client.requestWithCredentials<unknown>("/orders", sellerCredentials, {
      method: "POST",
      body: payload,
      correlationId: pedidoIdImportacao,
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
        syncErrors: toJson([{ message, at: new Date().toISOString(), correlationId: pedidoIdImportacao }]),
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
      const correlationId = randomUUID();
      logApiEvent("INFO", "[erp order status] querying UltraFV3 orderStatus", {
        erpOrderSyncId: order.id,
        opportunityId: order.opportunityId,
        pedidoIdImportacao: order.pedidoIdImportacao,
        query,
        correlationId,
      });
      const response = await requestUltraFv3ReadOnlyWithRetry<unknown>(
        `/orderStatus?pedido=${encodeURIComponent(query)}`,
        correlationId,
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


export async function getErpOrderOperationalSummary() {
  const [sentOrders, pendingOrders, errorOrders, fulfilledOrders, lastOrderSync] = await Promise.all([
    prisma.erpOrderSync.count({ where: { status: ErpOrderSyncStatus.sent } }),
    prisma.erpOrderSync.count({ where: { status: ErpOrderSyncStatus.pending } }),
    prisma.erpOrderSync.count({ where: { status: ErpOrderSyncStatus.error } }),
    prisma.erpOrderSync.count({ where: { orderStatus: { not: null } } }),
    prisma.erpOrderSync.findFirst({
      orderBy: [{ updatedAt: "desc" }],
      select: { updatedAt: true, sentAt: true, statusSyncedAt: true },
    }),
  ]);

  return {
    sentOrders,
    pendingOrders,
    errorOrders,
    syncedOrders: fulfilledOrders,
    lastOrderActivityAt: lastOrderSync?.statusSyncedAt?.toISOString()
      ?? lastOrderSync?.sentAt?.toISOString()
      ?? lastOrderSync?.updatedAt.toISOString()
      ?? null,
  };
}
