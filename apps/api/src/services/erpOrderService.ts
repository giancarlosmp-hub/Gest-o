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
import { ULTRAFV3_ORDER_REQUEST_TIMEOUT_MS, UltraFv3IntegrationError, ultraFv3Client, type UltraFv3Credentials } from "./ultraFv3Client.js";
import { decryptErpCredential } from "./erpCredentialCrypto.js";
import { requestUltraFv3ReadOnlyWithCredentialsRetry, requestUltraFv3ReadOnlyWithRetry } from "./ultraFv3SyncService.js";

const SALESMEN_CONFIG_KEY = "erp.ultrafv3.salesmen";
const SALESMEN_ORDER_SEQUENCE_ENDPOINT = "/salesmen";
const ERP_ORDER_ADVISORY_LOCK_NAMESPACE = 73_001;
const NUM_PEDIDO_PATTERN = /^[A-Za-z0-9._/-]{1,40}$/;

class ErpOrderSubmissionMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const erpOrderSubmissionMutex = new ErpOrderSubmissionMutex();
const erpOrderNumPedidoMutex = new ErpOrderSubmissionMutex();

const resolveOrderItemProductClassCode = (item: Pick<OpportunityItem, "erpProductClassCode" | "lineNumber">) => {
  const directClassCode = item.erpProductClassCode?.trim();
  if (directClassCode) return directClassCode;
  const lineNumber = Number(item.lineNumber);
  return Number.isInteger(lineNumber) && lineNumber > 0 ? String(lineNumber) : "";
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SENSITIVE_KEY_PATTERN = /authorization|token|password|senha|secret|credential/i;
const DOCUMENT_KEY_PATTERN = /document|documento|cpf|cnpj/i;

const redactSensitiveText = (value: string) => value
  .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer ***")
  .replace(/(authorization|token|password|senha)\s*[:=]\s*[^,;\s]+/gi, "$1=***")
  .replace(/\b(\d{3})\d{6}(\d{2})\b/g, "$1***$2")
  .replace(/\b(\d{3})\d{9}(\d{2})\b/g, "$1***$2")
  .replace(/\b(\d{3})[.]\d{3}[.]\d{3}-?(\d{2})\b/g, "$1.***-$2")
  .replace(/\b(\d{2})[.]\d{3}[.]\d{3}[/]\d{4}-?(\d{2})\b/g, "$1.***-$2");

const maskDocument = (value: unknown) => {
  const text = String(value ?? "").trim();
  const digits = text.replace(/\D/g, "");
  if (!digits) return text ? "***" : "";
  if (digits.length <= 4) return "***";
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
};

const sanitizeUltraValue = (value: unknown, key = ""): unknown => {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "***";
  if (DOCUMENT_KEY_PATTERN.test(key)) return maskDocument(value);
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUltraValue(item));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, sanitizeUltraValue(childValue, childKey)]));
  return value;
};

export const sanitizeErpOrderPayload = (payload: unknown) => sanitizeUltraValue(payload);
export const sanitizeErpOrderErrorMessage = (message: unknown) => redactSensitiveText(String(message || "Falha ao gerar pedido ERP."));

const getResponseField = (payload: unknown, key: string) =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[key]
    : undefined;

const toUsefulText = (value: unknown) => {
  if (typeof value === "string" && value.trim()) return redactSensitiveText(value.trim());
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") return JSON.stringify(sanitizeUltraValue(value));
  return "";
};

type SanitizedUltraOrderFailure = {
  status: number | null;
  endpoint: "/orders";
  message: string;
  error?: unknown;
  erro?: unknown;
  Message?: unknown;
  Retorno?: unknown;
  correlationId: string;
  PEDIDO_ID_IMPORTACAO: string;
  NUM_PEDIDO: string;
  payload: unknown;
};

const sanitizeUltraOrderFailure = (
  error: unknown,
  context: { pedidoIdImportacao: string; numPedido: string; payload: unknown },
): SanitizedUltraOrderFailure => {
  const integrationError = error instanceof UltraFv3IntegrationError ? error : null;
  const diagnostics = integrationError?.diagnostics;
  const response = diagnostics?.ultraResponse;
  const fields = Object.fromEntries(
    ["error", "erro", "Message", "Retorno"]
      .map((key) => [key, getResponseField(response, key)] as const)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, sanitizeUltraValue(value, key)]),
  );
  const ultraMessage = toUsefulText(getResponseField(response, "message"))
    || toUsefulText(getResponseField(response, "Message"))
    || toUsefulText(getResponseField(response, "error"))
    || toUsefulText(getResponseField(response, "erro"))
    || toUsefulText(getResponseField(response, "Retorno"))
    || diagnostics?.message
    || (error instanceof Error ? error.message : String(error));
  const status = diagnostics?.status ?? integrationError?.status ?? null;
  return {
    status,
    endpoint: "/orders",
    message: `UltraFV3 rejeitou POST /orders${status ? ` (status ${status})` : ""}: ${ultraMessage}`,
    ...fields,
    correlationId: diagnostics?.correlationId || context.pedidoIdImportacao,
    PEDIDO_ID_IMPORTACAO: context.pedidoIdImportacao,
    NUM_PEDIDO: context.numPedido,
    payload: sanitizeErpOrderPayload(context.payload),
  };
};

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

const roundMoney = (value: number) => Number(value.toFixed(2));

const isBlankRequiredValue = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const ULTRAFV3_ORDER_REQUIRED_FIELDS = [
  "PARCEIRO",
  "NUM_PEDIDO",
  "DATA_PEDIDO",
  "DATA_PREV_ENTREGA",
  "VENDEDOR",
  "OPERADOR",
  "CODOPER",
  "CODFILIAL",
  "TABELA_PRECO",
  "CODCONDREC",
  "FORMA",
  "VALOR_BRUTO",
  "VALOR_DESCONTO",
  "VALOR_LIQUIDO",
  "QTD_PEDIDO",
  "TIPO_MOVIMENTO",
  "ITENS",
] as const;

const ULTRAFV3_ORDER_FORBIDDEN_FIELDS = [
  "CODVENDEDOR",
  "FILIAL",
  "OPERACAO",
  "FORMA_PAGAMENTO",
  "CONDICAO_RECEBIMENTO",
] as const;

const ULTRAFV3_ORDER_ITEM_REQUIRED_FIELDS = [
  "CODPRODUTO",
  "CODPRODUTO_CLAS",
  "ITEM",
  "QTD_PEDIDO",
  "PRECO",
  "PRECO_LISTA",
  "VALOR_BRUTO",
  "VALOR_DESCONTO",
  "VALOR_LIQUIDO",
  "DESCRICAO_UNMED",
  "UND_MEDIDA",
  "QTD_UNMED",
  "MOTIVO_CANCELAMENTO",
  "OBS",
  "ICMS_DESON_DESCTO_FINANCEIRO",
] as const;

export type UltraFv3OrderPayload = Record<string, unknown> & {
  PEDIDO_ID_IMPORTACAO: string;
  NUM_PEDIDO: string;
  ITENS: Array<Record<string, unknown>>;
};

export const validateUltraFv3OrderPayload = (payload: UltraFv3OrderPayload) => {
  const errors: string[] = [];
  for (const field of ULTRAFV3_ORDER_REQUIRED_FIELDS) {
    if (field === "ITENS") {
      if (!Array.isArray(payload.ITENS) || payload.ITENS.length === 0) errors.push("ITENS deve conter ao menos um item.");
      continue;
    }
    if (isBlankRequiredValue(payload[field])) errors.push(`Campo obrigatório ausente: ${field}.`);
  }
  for (const field of ULTRAFV3_ORDER_FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) errors.push(`Campo não permitido no POST /orders: ${field}.`);
  }
  if (typeof payload.NUM_PEDIDO !== "string") errors.push("NUM_PEDIDO deve ser string.");
  if (typeof payload.PEDIDO_ID_IMPORTACAO !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.PEDIDO_ID_IMPORTACAO)) {
    errors.push("PEDIDO_ID_IMPORTACAO deve ser UUID v4.");
  }
  if (payload.TIPO_MOVIMENTO !== "PEDIDO") errors.push('TIPO_MOVIMENTO deve ser "PEDIDO".');

  payload.ITENS?.forEach((item, index) => {
    const itemPath = `ITENS[${index}]`;
    for (const field of ULTRAFV3_ORDER_ITEM_REQUIRED_FIELDS) {
      if (field === "MOTIVO_CANCELAMENTO" || field === "OBS") {
        if (item[field] === undefined || item[field] === null) errors.push(`Campo obrigatório ausente: ${itemPath}.${field}.`);
        continue;
      }
      if (isBlankRequiredValue(item[field])) errors.push(`Campo obrigatório ausente: ${itemPath}.${field}.`);
    }
    if (item.ITEM !== index + 1) errors.push(`${itemPath}.ITEM deve ser sequencial iniciando em 1.`);
    if (item.QTD_UNMED !== 1) errors.push(`${itemPath}.QTD_UNMED deve ser 1.`);
    if (item.MOTIVO_CANCELAMENTO !== "") errors.push(`${itemPath}.MOTIVO_CANCELAMENTO deve ser string vazia.`);
    if (item.OBS !== "") errors.push(`${itemPath}.OBS deve ser string vazia.`);
    if (item.ICMS_DESON_DESCTO_FINANCEIRO !== "N") errors.push(`${itemPath}.ICMS_DESON_DESCTO_FINANCEIRO deve ser "N".`);
  });

  return errors;
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

type SalesmanOrderSequenceDiagnostics = {
  sellerErpCode: string;
  receivedSalesmenCount: number;
  hasNumeroPedido: boolean;
  numeroPedidoPathUsed: string | null;
  matchedSalesmanFound: boolean;
  operatorFound: boolean;
};

type SalesmanOrderSequenceResolution = {
  numPedido: string;
  operatorCode: string;
  diagnostics: SalesmanOrderSequenceDiagnostics;
};

const getNestedRecord = (payload: unknown, path: string[]) => {
  let current: unknown = payload;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null;
};

const resolveSalesmenPayload = (body: unknown) => {
  const candidates = [
    { record: getNestedRecord(body, ["data"]), path: "body.data" },
    { record: getNestedRecord(body, []), path: "body" },
    { record: getNestedRecord(body, ["response", "data"]), path: "body.response.data" },
    { record: getNestedRecord(body, ["data", "data"]), path: "body.data.data" },
  ];
  let numeroPedido = "";
  let numeroPedidoPathUsed: string | null = null;
  let salesmen: unknown[] = [];
  for (const candidate of candidates) {
    if (!candidate.record) continue;
    if (!numeroPedido) {
      const value = pickFirstString(candidate.record, ["NUMERO_PEDIDO"]);
      if (value) {
        numeroPedido = value;
        numeroPedidoPathUsed = `${candidate.path}.NUMERO_PEDIDO`;
      }
    }
    if (!salesmen.length && Array.isArray(candidate.record.SALESMAN)) salesmen = candidate.record.SALESMAN;
  }
  return { numeroPedido, numeroPedidoPathUsed, salesmen };
};

async function loadSalesmenBody(options: { forceRefresh?: boolean; credentials?: UltraFv3Credentials; correlationId?: string } = {}) {
  if (!options.credentials) {
    const stored = options.forceRefresh
      ? null
      : await prisma.appConfig.findUnique({
          where: { key: SALESMEN_CONFIG_KEY },
          select: { value: true },
        });
    if (stored?.value) {
      try {
        return JSON.parse(stored.value) as unknown;
      } catch {
        // fall back to UltraFV3
      }
    }

    const response = await ultraFv3Client.request<unknown>(SALESMEN_ORDER_SEQUENCE_ENDPOINT, { correlationId: options.correlationId });
    await prisma.appConfig.upsert({
      where: { key: SALESMEN_CONFIG_KEY },
      update: { value: JSON.stringify(response) },
      create: { key: SALESMEN_CONFIG_KEY, value: JSON.stringify(response) },
    });
    return response;
  }

  return requestUltraFv3ReadOnlyWithCredentialsRetry<unknown>(SALESMEN_ORDER_SEQUENCE_ENDPOINT, options.credentials, options.correlationId || randomUUID());
}

async function resolveSalesmanOrderSequenceUnsafe(sellerErpCode: string, credentials: UltraFv3Credentials, correlationId: string): Promise<SalesmanOrderSequenceResolution> {
  const body = await loadSalesmenBody({ forceRefresh: true, credentials, correlationId });
  const { numeroPedido, numeroPedidoPathUsed, salesmen } = resolveSalesmenPayload(body);
  const matchedSalesman = salesmen.find((row) => {
    if (!row || typeof row !== "object") return false;
    return pickFirstString(row as Record<string, unknown>, [
      "CODVENDEDOR",
      "code",
      "erpCode",
      "sellerCode",
      "salesmanCode",
      "vendedorCodigo",
      "codigo",
      "CODIGO",
      "codVendedor",
    ]) === sellerErpCode;
  });
  const operatorCode = matchedSalesman && typeof matchedSalesman === "object"
    ? pickFirstString(matchedSalesman as Record<string, unknown>, ["OPERADOR", "operator", "operador", "operatorCode"])
    : "";
  const validNumeroPedido = NUM_PEDIDO_PATTERN.test(numeroPedido) ? numeroPedido : "";
  const diagnostics: SalesmanOrderSequenceDiagnostics = {
    sellerErpCode,
    receivedSalesmenCount: salesmen.length,
    hasNumeroPedido: Boolean(validNumeroPedido),
    numeroPedidoPathUsed,
    matchedSalesmanFound: Boolean(matchedSalesman),
    operatorFound: Boolean(operatorCode),
  };
  logApiEvent(validNumeroPedido && matchedSalesman ? "INFO" : "WARN", "[erp order] resolved UltraFV3 salesman order sequence", diagnostics);
  return { numPedido: validNumeroPedido, operatorCode, diagnostics };
}

async function resolveSalesmanOrderSequence(sellerErpCode: string, credentials: UltraFv3Credentials, correlationId: string): Promise<SalesmanOrderSequenceResolution> {
  return erpOrderNumPedidoMutex.runExclusive(async () => {
    logApiEvent("INFO", "[erp order] acquired NUM_PEDIDO generation lock", {
      sellerErpCode,
      correlationId,
      endpoint: SALESMEN_ORDER_SEQUENCE_ENDPOINT,
    });
    try {
      return await resolveSalesmanOrderSequenceUnsafe(sellerErpCode, credentials, correlationId);
    } finally {
      logApiEvent("INFO", "[erp order] released NUM_PEDIDO generation lock", {
        sellerErpCode,
        correlationId,
        endpoint: SALESMEN_ORDER_SEQUENCE_ENDPOINT,
      });
    }
  });
}

async function createErpOrderFromOpportunityUnsafe(
  opportunity: OpportunityForErpOrder,
  rawParams: OrderParameterCodes,
  correlationId: string,
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
  const itemWithoutProductClass = opportunity.items.find((item) => !resolveOrderItemProductClassCode(item));
  if (itemWithoutProductClass)
    throw Object.assign(new Error(`Payload inválido: item ${itemWithoutProductClass.lineNumber} sem classificação ERP (CODPRODUTO_CLAS). Se o produto aparece como "Linha ${itemWithoutProductClass.lineNumber} · ${itemWithoutProductClass.unit || "sem unidade"}", confirme o CODPRODUTO_CLAS sincronizado ou informe a linha como classificação.`), { status: 400 });
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

  await ultraFv3Client.authenticateWithCredentials(sellerCredentials);
  logApiEvent("INFO", "[erp order] requesting UltraFV3 /salesmen order sequence", {
    ...operationContext,
    correlationId: pedidoIdImportacao,
    endpoint: SALESMEN_ORDER_SEQUENCE_ENDPOINT,
  });
  const sequenceResolution = await resolveSalesmanOrderSequence(sellerErpCode, sellerCredentials, pedidoIdImportacao);
  const numPedido = String(sequenceResolution.numPedido);
  const effectiveOperatorCode = sequenceResolution.operatorCode || operatorCode;
  const numericSellerErpCode = Number(sellerErpCode);
  const numericOperatorCode = Number(effectiveOperatorCode);
  if (!numPedido || !effectiveOperatorCode || !sequenceResolution.diagnostics.matchedSalesmanFound || !Number.isFinite(numericSellerErpCode) || !Number.isFinite(numericOperatorCode)) {
    const diagnostics = sequenceResolution.diagnostics;
    throw Object.assign(
      new Error(
        `Não foi possível resolver NUM_PEDIDO/OPERADOR válido em /salesmen para o vendedor ERP vinculado. diagnostics=${JSON.stringify(diagnostics)}`,
      ),
      { status: 400, diagnostics },
    );
  }

  const itens = opportunity.items.map((item, index) => ({
    CODPRODUTO: item.erpProductCode,
    CODPRODUTO_CLAS: resolveOrderItemProductClassCode(item),
    ITEM: index + 1,
    QTD_PEDIDO: Number(item.quantity),
    PRECO: Number(item.unitPrice),
    PRECO_LISTA: Number(item.unitPrice),
    VALOR_BRUTO: roundMoney(Number(item.grossTotal || 0)),
    VALOR_DESCONTO: roundMoney(Number(item.discountTotal || 0)),
    VALOR_LIQUIDO: roundMoney(Number(item.netTotal || 0)),
    DESCRICAO_UNMED: item.unit,
    UND_MEDIDA: item.unit,
    QTD_UNMED: 1,
    MOTIVO_CANCELAMENTO: "",
    OBS: "",
    ICMS_DESON_DESCTO_FINANCEIRO: "N",
  }));
  const valorBruto = roundMoney(opportunity.items.reduce((sum, item) => sum + Number(item.grossTotal || 0), 0));
  const valorDesconto = roundMoney(opportunity.items.reduce((sum, item) => sum + Number(item.discountTotal || 0), 0));
  const valorLiquido = roundMoney(opportunity.items.reduce((sum, item) => sum + Number(item.netTotal || 0), 0));
  const qtdPedido = roundMoney(opportunity.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0));

  const payload: UltraFv3OrderPayload = {
    PEDIDO_ID_IMPORTACAO: pedidoIdImportacao,
    NUM_PEDIDO: String(numPedido),
    PARCEIRO: clientErpCode,
    DATA_PEDIDO: formatDateDot(now),
    DATA_PREV_ENTREGA: formatDateDot(now),
    VENDEDOR: numericSellerErpCode,
    OPERADOR: numericOperatorCode,
    CODOPER: params.operationCode,
    CODFILIAL: params.branchCode,
    TABELA_PRECO: params.priceTableCode,
    CODCONDREC: params.receivingConditionCode,
    FORMA: params.paymentMethodCode,
    VALOR_BRUTO: valorBruto,
    VALOR_DESCONTO: valorDesconto,
    VALOR_LIQUIDO: valorLiquido,
    QTD_PEDIDO: qtdPedido,
    TIPO_MOVIMENTO: "PEDIDO",
    ITENS: itens,
  };

  const payloadValidationErrors = validateUltraFv3OrderPayload(payload);
  if (payloadValidationErrors.length) {
    throw Object.assign(new Error("Payload UltraFV3 /orders inválido; envio bloqueado antes de chamar o ERP."), {
      status: 400,
      errors: payloadValidationErrors,
      endpoint: "/orders",
      payload: sanitizeErpOrderPayload(payload),
      parameterDiagnostics,
    });
  }

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
      salesmenDiagnostics: sequenceResolution.diagnostics,
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

  logApiEvent("INFO", "[erp order] sanitized final payload sent to UltraFV3", {
    endpoint: "/orders",
    correlationId: pedidoIdImportacao,
    NUM_PEDIDO: payload.NUM_PEDIDO,
    PEDIDO_ID_IMPORTACAO: payload.PEDIDO_ID_IMPORTACAO,
    CODVENDEDOR: payload.VENDEDOR,
    OPERADOR: payload.OPERADOR,
    payload: sanitizeUltraValue({ ...payload, PARCEIRO: maskDocument(payload.PARCEIRO) }),
  });

  try {
    logApiEvent("INFO", "[erp order] submitting UltraFV3 /orders", {
      ...operationContext,
      correlationId: pedidoIdImportacao,
      erpOrderSyncId: sync.id,
      timeoutMs: ULTRAFV3_ORDER_REQUEST_TIMEOUT_MS,
    });
    const erpResponse = await ultraFv3Client.requestWithCredentials<unknown>("/orders", sellerCredentials, {
      method: "POST",
      body: payload,
      correlationId: pedidoIdImportacao,
      timeoutMs: ULTRAFV3_ORDER_REQUEST_TIMEOUT_MS,
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
    const failure = sanitizeUltraOrderFailure(error, { pedidoIdImportacao, numPedido, payload });
    try {
      await prisma.erpOrderSync.update({
        where: { id: sync.id },
        data: {
          status: ErpOrderSyncStatus.error,
          erpResponse: toJson(failure),
          syncErrors: toJson([{ ...failure, at: new Date().toISOString() }]),
        },
      });
    } catch (persistenceError) {
      logApiEvent("ERROR", "[erp order] failed to persist UltraFV3 submission failure", {
        ...operationContext,
        erpOrderSyncId: sync.id,
        correlationId: pedidoIdImportacao,
        error: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
      });
    }
    logApiEvent("ERROR", "[erp order] UltraFV3 order submission failed", {
      ...operationContext,
      erpOrderSyncId: sync.id,
      failure,
    });
    throw Object.assign(new Error(failure.message), {
      pedidoIdImportacao,
      status: error instanceof UltraFv3IntegrationError && error.code === "timeout" ? 504 : 502,
      ultraFv3Failure: failure,
      endpoint: failure.endpoint,
      payload: failure.payload,
    });
  }
}

export async function createErpOrderFromOpportunity(
  opportunity: OpportunityForErpOrder,
  rawParams: OrderParameterCodes,
  options: { correlationId?: string } = {},
) {
  const correlationId = options.correlationId || randomUUID();
  const simulateOnly = rawParams.simulateOnly === true;
  logApiEvent("INFO", "[erp order] generation flow started", {
    opportunityId: opportunity.id,
    correlationId,
    simulateOnly,
  });

  try {
    const runGeneration = () => createErpOrderFromOpportunityUnsafe(opportunity, rawParams, correlationId);
    const result = simulateOnly
      ? await runGeneration()
      : await erpOrderSubmissionMutex.runExclusive(async () => {
          logApiEvent("INFO", "[erp order] acquired global UltraFV3 submission lock", {
            opportunityId: opportunity.id,
            correlationId,
          });
          try {
            return await runGeneration();
          } finally {
            logApiEvent("INFO", "[erp order] released global UltraFV3 submission lock", {
              opportunityId: opportunity.id,
              correlationId,
            });
          }
        });
    logApiEvent("INFO", "[erp order] generation flow completed", {
      opportunityId: opportunity.id,
      correlationId,
      simulateOnly,
      erpOrderSyncId: result.id,
      numPedido: result.numPedido,
    });
    return result;
  } catch (error) {
    const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const status = error instanceof UltraFv3IntegrationError
      ? error.code === "timeout" ? 504 : 502
      : typeof source.status === "number" ? source.status : 502;
    const message = sanitizeErpOrderErrorMessage(error instanceof Error ? error.message : error);
    logApiEvent(status >= 500 ? "ERROR" : "WARN", "[erp order] generation flow failed", {
      opportunityId: opportunity.id,
      correlationId,
      simulateOnly,
      status,
      error: message,
    });
    if (error instanceof Error) {
      Object.assign(error, { status, correlationId });
      throw error;
    }
    throw Object.assign(new Error(message || "Falha ao gerar pedido ERP."), { status, correlationId });
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
