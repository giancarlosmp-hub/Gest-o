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
import { assertErpRuntimeConfigForOrderSubmission } from "./erpRuntimeConfig.js";
import { logApiEvent } from "../utils/logger.js";
import { ULTRAFV3_ORDER_REQUEST_TIMEOUT_MS, ULTRAFV3_REQUEST_TIMEOUT_MS, UltraFv3IntegrationError, ultraFv3Client, type UltraFv3Credentials } from "./ultraFv3Client.js";
import { decryptErpCredential } from "./erpCredentialCrypto.js";
import { requestUltraFv3ReadOnlyWithCredentialsRetry, requestUltraFv3ReadOnlyWithRetry } from "./ultraFv3SyncService.js";

const SALESMEN_CONFIG_KEY = "erp.ultrafv3.salesmen";
const SALESMEN_ORDER_SEQUENCE_ENDPOINT = "/salesmen";
const SALESMEN_ORDER_SEQUENCE_TIMEOUT_MS = 10_000;
const logErpOrderRouteStage = (
  message: "[ERP ORDER BEFORE SALESMEN]" | "[ERP ORDER AFTER SALESMEN]" | "[ERP ORDER BEFORE ULTRAFV3 ORDERS]" | "[ERP ORDER AFTER ULTRAFV3 ORDERS]",
  context: {
    correlationId: string;
    opportunityId: string;
    userId: string | null;
    routeStage: string;
    startedAt: number;
    pedidoIdImportacao?: string;
    erpOrderSyncId?: string;
    endpoint?: string;
  },
  extra: Record<string, unknown> = {},
) => {
  logApiEvent("INFO", message, {
    correlationId: context.correlationId,
    opportunityId: context.opportunityId,
    userId: context.userId,
    durationMs: Date.now() - context.startedAt,
    routeStage: context.routeStage,
    ...(context.pedidoIdImportacao ? { pedidoIdImportacao: context.pedidoIdImportacao } : {}),
    ...(context.erpOrderSyncId ? { erpOrderSyncId: context.erpOrderSyncId } : {}),
    ...(context.endpoint ? { endpoint: context.endpoint } : {}),
    ...extra,
  });
};

const ERP_ORDER_ADVISORY_LOCK_NAMESPACE = 73_001;
const NUM_PEDIDO_MAX_LENGTH = 15;
export const NUM_PEDIDO_PATTERN = /^\d{1,15}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
// Produção versionada em docker-compose possui um único serviço/processo `api`
// sem replicas/cluster/PM2. Este mutex protege essa topologia. Se a API passar
// a rodar em múltiplos processos/containers, substituir por advisory lock
// PostgreSQL global envolvendo GET /salesmen e POST /orders.

const resolveOrderItemProductClassCode = (item: Pick<OpportunityItem, "erpProductClassCode">) => item.erpProductClassCode?.trim() || "";

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

const buildFinalValidatedOrderPayloadLog = (payload: UltraFv3OrderPayload) => ({
  NUM_PEDIDO: payload.NUM_PEDIDO,
  PARCEIRO: maskDocument(payload.PARCEIRO),
  VENDEDOR: payload.VENDEDOR,
  OPERADOR: payload.OPERADOR,
  CODOPER: payload.CODOPER,
  CODFILIAL: payload.CODFILIAL,
  TABELA_PRECO: payload.TABELA_PRECO,
  CODCONDREC: payload.CODCONDREC,
  FORMA: payload.FORMA,
  DATA_PEDIDO: payload.DATA_PEDIDO,
  DATA_PREV_ENTREGA: payload.DATA_PREV_ENTREGA,
  ITENS: payload.ITENS.map((item) => ({
    CODPRODUTO: item["CODPRODUTO"],
    CODPRODUTO_CLAS: item["CODPRODUTO_CLAS"],
    QTD_PEDIDO: item["QTD_PEDIDO"],
    PRECO: item["PRECO"],
    UND_MEDIDA: item["UND_MEDIDA"],
  })),
});

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
  "paymentMethodCode" | "receivingConditionCode" | "priceTableCode" | "branchCode" | "operationCode" | "expectedDeliveryDate" | "erpOrderObservation" | "simulateOnly"
>;

type NormalizedOrderParameterCodes = {
  paymentMethodCode: string;
  receivingConditionCode: string;
  priceTableCode: string;
  branchCode: string;
  operationCode: string;
  expectedDeliveryDate: string;
  erpOrderObservation: string;
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
  expectedDeliveryDateRaw: unknown;
  expectedDeliveryDateNormalized: string;
  erpOrderObservationRaw: unknown;
  erpOrderObservationNormalized: string;
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
  expectedDeliveryDate: typeof params.expectedDeliveryDate === "string" ? params.expectedDeliveryDate.trim() : "",
  erpOrderObservation: typeof params.erpOrderObservation === "string" ? params.erpOrderObservation : "",
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
    expectedDeliveryDateRaw: typeof params.expectedDeliveryDate === "string" ? params.expectedDeliveryDate : null,
    expectedDeliveryDateNormalized: normalized.expectedDeliveryDate,
    erpOrderObservationRaw: typeof params.erpOrderObservation === "string" ? params.erpOrderObservation : null,
    erpOrderObservationNormalized: normalized.erpOrderObservation,
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
  ownerSeller: Pick<User, "id" | "name" | "erpCode" | "erpOperatorCode" | "erpLoginUsername" | "erpLoginPasswordEncrypted">;
  items: Array<OpportunityItem & { product?: Pick<Product, "stockQuantity" | "unit" | "className" | "rawErpPayload"> | null }>;
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

const parseIsoDateOnlyAsUtc = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
};

const toUltraNumber = (value: unknown) => {
  const numberValue = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(numberValue) ? numberValue : Number.NaN;
};

const getRawProductPayload = (item: OpportunityForErpOrder["items"][number]) =>
  item.product?.rawErpPayload && typeof item.product.rawErpPayload === "object" && !Array.isArray(item.product.rawErpPayload)
    ? item.product.rawErpPayload as Record<string, unknown>
    : {};

const resolveOrderItemProductClassDescription = (item: OpportunityForErpOrder["items"][number]) => {
  const rawPayload = getRawProductPayload(item);
  return item.product?.className?.trim()
    || pickFirstString(rawPayload, ["DSCPRODUTO_CLAS", "DESCRICAO_CLASSE", "DSC_CLASSIFICACAO", "classificationName", "className", "nomeClassificacao"])
    || null;
};

const resolveOrderItemUnitFields = (item: OpportunityForErpOrder["items"][number]) => {
  const rawPayload = getRawProductPayload(item);
  const unit = (item.unit?.trim() || item.product?.unit?.trim() || pickFirstString(rawPayload, ["UND_MEDIDA", "unit", "unidade", "UNIDADE", "unitCode", "un"])).toUpperCase();
  const rawDescription = pickFirstString(rawPayload, ["DESCRICAO_UNMED", "DSCUNMED", "DESCRICAO_UNIDADE", "DSC_UNIDADE", "unitDescription", "descricaoUnidade"]);
  const descricaoUnmed = rawDescription || (unit === "SC" ? "SACO" : unit);
  return { UND_MEDIDA: unit, DESCRICAO_UNMED: descricaoUnmed.toUpperCase() };
};

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
  "VALOR_ACRESCIMO",
  "VALOR_DESCONTO",
  "VALOR_LIQUIDO",
  "QTD_PEDIDO",
  "PRIORIDADE",
  "TIPO_MOVIMENTO",
  "PEDIDO_ID_IMPORTACAO",
  "DATA_CANCELAMENTO",
  "OBS_PEDIDO",
  "OBSERVACAO_INTERNA",
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
  "PEDIDO_ID",
  "CODPRODUTO",
  "CODPRODUTO_CLAS",
  "ITEM",
  "QTD_PEDIDO",
  "PRECO",
  "PRECO_LISTA",
  "VALOR_BRUTO",
  "VALOR_ACRESCIMO",
  "VALOR_DESCONTO",
  "VALOR_LIQUIDO",
  "DESCRICAO_UNMED",
  "UND_MEDIDA",
  "QTD_UNMED",
  "PESO_EMBALAGEM",
  "PESO_PRODUTO",
  "MOTIVO_CANCELAMENTO",
  "VALOR_ICMS_DESON",
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
    if (["PEDIDO_ID", "OBSERVACAO_INTERNA"].includes(field) ? payload[field] !== null : ["DATA_CANCELAMENTO", "OBS_PEDIDO"].includes(field) ? payload[field] === undefined || payload[field] === null : isBlankRequiredValue(payload[field])) errors.push(`Campo obrigatório ausente: ${field}.`);
  }
  for (const field of ULTRAFV3_ORDER_FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) errors.push(`Campo não permitido no POST /orders: ${field}.`);
  }
  const datePattern = /^\d{2}\.\d{2}\.\d{4}$/;
  for (const field of ["PARCEIRO", "VENDEDOR", "OPERADOR", "CODOPER", "CODFILIAL", "TABELA_PRECO", "CODCONDREC", "FORMA"] as const) {
    if (typeof payload[field] !== "number" || !Number.isFinite(payload[field])) errors.push(`${field} deve ser number.`);
  }
  for (const field of ["DATA_PEDIDO", "DATA_PREV_ENTREGA"] as const) {
    if (typeof payload[field] !== "string" || !datePattern.test(payload[field])) errors.push(`${field} deve estar no formato DD.MM.YYYY.`);
  }
  if (payload.PEDIDO_ID !== null) errors.push("PEDIDO_ID deve ser null.");
  if (payload.VALOR_ACRESCIMO !== 0) errors.push("VALOR_ACRESCIMO deve ser 0.");
  if (payload.DATA_CANCELAMENTO !== "") errors.push("DATA_CANCELAMENTO deve ser string vazia.");
  if (typeof payload.OBS_PEDIDO !== "string") errors.push("OBS_PEDIDO deve ser string.");
  if (payload.OBSERVACAO_INTERNA !== null) errors.push("OBSERVACAO_INTERNA deve ser null.");
  if (typeof payload.NUM_PEDIDO !== "string") errors.push("NUM_PEDIDO deve ser string.");
  else if (!normalizeUltraFv3OrderNumber(payload.NUM_PEDIDO)) errors.push(`NUM_PEDIDO deve ser string numérica maior que zero, sem zeros à esquerda e com no máximo ${NUM_PEDIDO_MAX_LENGTH} caracteres.`);
  else if (payload.NUM_PEDIDO === payload.PEDIDO_ID_IMPORTACAO) errors.push("NUM_PEDIDO não pode ser igual ao PEDIDO_ID_IMPORTACAO.");
  else if (payload.NUM_PEDIDO.includes("-") || UUID_V4_PATTERN.test(payload.NUM_PEDIDO)) errors.push("NUM_PEDIDO não pode conter UUID.");
  else if (/^PMR/i.test(payload.NUM_PEDIDO)) errors.push("NUM_PEDIDO não pode usar código interno PMR do CRM.");
  if (typeof payload.PEDIDO_ID_IMPORTACAO !== "string" || !UUID_V4_PATTERN.test(payload.PEDIDO_ID_IMPORTACAO)) {
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
      if (["PEDIDO_ID", "PESO_PRODUTO"].includes(field) ? item[field] !== null : isBlankRequiredValue(item[field])) errors.push(`Campo obrigatório ausente: ${itemPath}.${field}.`);
    }
    if (item.PEDIDO_ID !== null) errors.push(`${itemPath}.PEDIDO_ID deve ser null.`);
    if (item.ITEM !== index + 1) errors.push(`${itemPath}.ITEM deve ser sequencial iniciando em 1.`);
    if (typeof item["CODPRODUTO"] !== "number" || !Number.isFinite(item["CODPRODUTO"])) errors.push(`${itemPath}.CODPRODUTO deve ser number.`);
    if (typeof item["CODPRODUTO_CLAS"] !== "number" || !Number.isFinite(item["CODPRODUTO_CLAS"])) errors.push(`${itemPath}.CODPRODUTO_CLAS deve ser number.`);
    if (typeof item["PRECO"] !== "number" || !Number.isFinite(item["PRECO"]) || item["PRECO"] <= 0) errors.push(`${itemPath}.PRECO deve ser number maior que 0.`);
    if (item.VALOR_ACRESCIMO !== 0) errors.push(`${itemPath}.VALOR_ACRESCIMO deve ser 0.`);
    if (typeof item["UND_MEDIDA"] !== "string" || !item["UND_MEDIDA"].trim()) errors.push(`${itemPath}.UND_MEDIDA deve ser string preenchida.`);
    if (typeof item.DESCRICAO_UNMED !== "string" || !item.DESCRICAO_UNMED.trim()) errors.push(`${itemPath}.DESCRICAO_UNMED deve ser string preenchida.`);
    if (item.QTD_UNMED !== 1) errors.push(`${itemPath}.QTD_UNMED deve ser 1.`);
    if (item.PESO_EMBALAGEM !== 0) errors.push(`${itemPath}.PESO_EMBALAGEM deve ser 0.`);
    if (item.PESO_PRODUTO !== null) errors.push(`${itemPath}.PESO_PRODUTO deve ser null.`);
    if (item.MOTIVO_CANCELAMENTO !== "") errors.push(`${itemPath}.MOTIVO_CANCELAMENTO deve ser string vazia.`);
    if (item.OBS !== "") errors.push(`${itemPath}.OBS deve ser string vazia.`);
    if (item.VALOR_ICMS_DESON !== 0) errors.push(`${itemPath}.VALOR_ICMS_DESON deve ser 0.`);
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
  const keys = [
    "PEDIDO_ID",
    "PEDIDO_NUMERO",
    "NUMERO_PEDIDO_ERP",
    "NUM_PEDIDO_ERP",
    "NROPEDIDO",
    "NR_PEDIDO",
    "CODPEDIDO",
    "COD_PEDIDO",
    "ID_PEDIDO",
    "idPedido",
    "pedidoId",
    "numeroPedidoErp",
    "erpOrderNumber",
    "orderNumber",
    "pedido",
    "PEDIDO",
  ];
  const visit = (value: unknown, depth = 0): string | null => {
    if (!value || typeof value !== "object" || depth > 4) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    const direct = keys
      .map((key) => record[key])
      .find((candidate) =>
        ["string", "number", "bigint"].includes(typeof candidate) &&
        String(candidate).trim() !== "",
      );
    if (direct !== undefined) return String(direct).trim();
    for (const nestedKey of ["data", "response", "result", "retorno", "Retorno", "order", "pedido"]) {
      const found = visit(record[nestedKey], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(payload);
};

const getFunctionalOrderErrorMessage = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const explicitSuccess = pickFirstString(record, ["success", "sucesso", "OK", "ok", "SUCCESS", "SUCESSO"]).toLowerCase();
  const statusText = pickFirstString(record, ["status", "STATUS", "situacao", "SITUACAO", "resultado", "RESULTADO"]).toLowerCase();
  const errorText = toUsefulText(record.error)
    || toUsefulText(record.erro)
    || toUsefulText(record.ERROR)
    || toUsefulText(record.ERRO)
    || toUsefulText(record.errors)
    || toUsefulText(record.ERROS);
  if (explicitSuccess && /^(false|0|n|nao|não)$/.test(explicitSuccess)) {
    return errorText || "UltraFV3 retornou sucesso=false no corpo da resposta.";
  }
  if (statusText && /(erro|error|falha|failed|rejeit)/i.test(statusText)) {
    return errorText || `UltraFV3 retornou status funcional de erro: ${statusText}.`;
  }
  if (errorText) return errorText;
  for (const nestedKey of ["data", "response", "result", "retorno", "Retorno"]) {
    const nestedError = getFunctionalOrderErrorMessage(record[nestedKey]);
    if (nestedError) return nestedError;
  }
  return null;
};

const isUncertainErpOrderFailure = (sync: Pick<Prisma.ErpOrderSyncGetPayload<{}>, "syncErrors" | "erpResponse" | "status">) => {
  if (sync.status === ErpOrderSyncStatus.pending) return true;
  const text = JSON.stringify(sanitizeUltraValue(sync.syncErrors ?? sync.erpResponse ?? {}));
  return /(\"status\":504|timeout|Timeout|fora do ar|inacessível|unavailable|ECONNRESET|network|AbortError|TimeoutError)/i.test(text);
};

type SalesmanOrderSequenceDiagnostics = {
  endpoint: "/salesmen";
  sellerId: string;
  sellerName: string;
  sellerErpCode: string;
  sellerErpCodeNormalized: string;
  authContext: "seller" | "global" | "seller_reference";
  receivedSalesmenCount: number;
  firstSellerCodesReceived: string[];
  availableSellerCodeFields: string[];
  hasNumeroPedido: boolean;
  numeroPedidoPathUsed: string | null;
  matchedSalesmanFound: boolean;
  matchedSalesmanCode: string | null;
  matchedSalesmanCodeField: string | null;
  matchedSalesmanName: string | null;
  matchedSalesmanLogin: string | null;
  matchedSalesmanFields: string[];
  operatorFound: boolean;
  operatorFieldUsed: string | null;
  comparisonMode: "exact" | "normalized" | null;
};

type SalesmanOrderSequenceResolution = {
  numPedido: string;
  operatorCode: string;
  diagnostics: SalesmanOrderSequenceDiagnostics;
};

type SalesmanOrderSequenceContext = {
  sellerId: string;
  sellerName: string;
  sellerErpCode: string;
  authContext: SalesmanOrderSequenceDiagnostics["authContext"];
};


const SALESMAN_CODE_KEYS = [
  "CODVENDEDOR",
  "VENDEDOR",
  "code",
  "erpCode",
  "sellerCode",
  "salesmanCode",
  "vendedorCodigo",
  "codigo",
  "CODIGO",
  "codVendedor",
  "COD_VENDEDOR",
  "CODVEN",
];
const SALESMAN_NUM_PEDIDO_KEYS = ["NUMERO_PEDIDO", "NUM_PEDIDO", "numPedido", "numeroPedido"];
const SALESMAN_OPERATOR_KEYS = [
  "OPERADOR",
  "CODOPERADOR",
  "COD_OPERADOR",
  "CODIGO_OPERADOR",
  "operator",
  "operador",
  "operatorCode",
  "erpOperatorCode",
  "operadorCodigo",
  "codigoOperador",
];
const SALESMAN_NAME_KEYS = [
  "NOME",
  "nome",
  "name",
  "description",
  "fullName",
  "sellerName",
  "salesmanName",
  "razaoSocial",
];
const SALESMAN_DOCUMENT_KEYS = ["CPF", "CNPJ", "cpf", "cnpj", "document", "documentNumber", "cnpjCpf"];
const SALESMAN_LOGIN_KEYS = [
  "LOGIN",
  "login",
  "USUARIO",
  "usuario",
  "USERNAME",
  "username",
  "email",
  "EMAIL",
  ...SALESMAN_DOCUMENT_KEYS,
];


const getErpLoginType = (value: unknown) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11) return "cpf";
  if (digits.length === 14) return "cnpj";
  return String(value ?? "").trim() ? "usuario" : "ausente";
};

const normalizeErpLinkCodeForComparison = (value: unknown) => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (digitsOnly && /^[0-9\s._/-]+$/.test(trimmed)) {
    const withoutLeadingZeros = digitsOnly.replace(/^0+/, "");
    return withoutLeadingZeros || "0";
  }
  return trimmed.toLowerCase();
};

const pickFirstStringWithKey = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim() !== "")
      return { value: String(value).trim(), key };
  }
  return { value: "", key: null as string | null };
};

const getSalesmanCodeMatch = (row: Record<string, unknown>, sellerErpCode: string) => {
  const expectedNormalized = normalizeErpLinkCodeForComparison(sellerErpCode);
  for (const key of SALESMAN_CODE_KEYS) {
    const value = row[key];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    const raw = String(value).trim();
    if (raw === sellerErpCode) return { matched: true, code: raw, field: key, mode: "exact" as const };
    if (normalizeErpLinkCodeForComparison(raw) === expectedNormalized)
      return { matched: true, code: raw, field: key, mode: "normalized" as const };
  }
  return { matched: false, code: null, field: null, mode: null };
};

const collectSalesmanCodeFields = (rows: unknown[]) => Array.from(new Set(rows.flatMap((row) => {
  if (!row || typeof row !== "object" || Array.isArray(row)) return [] as string[];
  const payload = row as Record<string, unknown>;
  return SALESMAN_CODE_KEYS.filter((key) => payload[key] !== undefined && payload[key] !== null && String(payload[key]).trim() !== "");
}))).slice(0, 20);

const collectFirstSalesmanCodes = (rows: unknown[]) => rows
  .slice(0, 10)
  .map((row) => row && typeof row === "object" && !Array.isArray(row) ? pickFirstString(row as Record<string, unknown>, SALESMAN_CODE_KEYS) : "")
  .filter(Boolean);

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

export type RequestedSalesmanContext = { sellerErpCode: string };
export type ResolvedSalesmenOrderContext = { numeroPedido: string; operador: number; codVendedor: number; selectedPath: string };

export function normalizeUltraFv3OrderNumber(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  const parsed = Number(text);
  if (!NUM_PEDIDO_PATTERN.test(text) || !Number.isSafeInteger(parsed) || parsed <= 0) return "";
  if (text.length > 1 && text.startsWith("0")) return "";
  return text;
}

const visitSalesmenRecords = (node: unknown, path: string, output: Array<{ path: string; record: Record<string, unknown> }>, depth = 0) => {
  if (depth > 5 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => visitSalesmenRecords(item, `${path}[${index}]`, output, depth + 1));
    return;
  }
  if (typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const hasSalesmanFields = SALESMAN_NUM_PEDIDO_KEYS.some((key) => record[key] !== undefined)
    || SALESMAN_CODE_KEYS.some((key) => record[key] !== undefined)
    || SALESMAN_OPERATOR_KEYS.some((key) => record[key] !== undefined);
  if (hasSalesmanFields) output.push({ path, record });
  const envelopeNumeroPedido = pickFirstString(record, SALESMAN_NUM_PEDIDO_KEYS);
  if (envelopeNumeroPedido && Array.isArray(record.SALESMAN)) {
    record.SALESMAN.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        output.push({ path: `${path}.SALESMAN[${index}]`, record: { NUMERO_PEDIDO: envelopeNumeroPedido, ...(item as Record<string, unknown>) } });
      }
    });
  }
  for (const [key, value] of Object.entries(record)) {
    if (["data", "response", "SALESMAN", "salesmen", "items", "rows", "results", "content"].includes(key) || Array.isArray(value)) {
      visitSalesmenRecords(value, `${path}.${key}`, output, depth + 1);
    }
  }
};

export function resolveSalesmenOrderContext(response: unknown, requestedSeller: RequestedSalesmanContext): ResolvedSalesmenOrderContext {
  const records: Array<{ path: string; record: Record<string, unknown> }> = [];
  visitSalesmenRecords(response, "body", records);
  const candidates = records.map(({ path, record }) => {
    const numeroPedidoPick = pickFirstStringWithKey(record, SALESMAN_NUM_PEDIDO_KEYS);
    const operatorPick = pickFirstStringWithKey(record, SALESMAN_OPERATOR_KEYS);
    const codePick = pickFirstStringWithKey(record, SALESMAN_CODE_KEYS);
    return { path, numeroPedido: normalizeUltraFv3OrderNumber(numeroPedidoPick.value), operador: operatorPick.value, codVendedor: codePick.value, match: getSalesmanCodeMatch(record, requestedSeller.sellerErpCode) };
  });
  const valid = candidates.filter((candidate) => candidate.numeroPedido && candidate.operador && candidate.codVendedor && candidate.match.matched);
  const exact = valid.filter((candidate) => candidate.match.mode === "exact");
  const selectedPool = exact.length ? exact : valid;
  if (selectedPool.length !== 1) {
    throw Object.assign(new Error(selectedPool.length ? "erp_ambiguous_salesman_order_number" : "erp_invalid_order_number"), {
      code: selectedPool.length ? "erp_ambiguous_salesman_order_number" : "erp_invalid_order_number",
      candidates: candidates.map((candidate) => ({ path: candidate.path, numeroPedido: candidate.numeroPedido || null, codVendedor: candidate.codVendedor || null, operador: candidate.operador || null, matched: candidate.match.matched, matchMode: candidate.match.mode })),
    });
  }
  const selected = selectedPool[0];
  return { numeroPedido: selected.numeroPedido, operador: Number(selected.operador), codVendedor: Number(selected.codVendedor), selectedPath: selected.path };
}

export function buildSalesmenDiagnostic(response: unknown, requestedSeller: RequestedSalesmanContext, httpStatus = 200) {
  const records: Array<{ path: string; record: Record<string, unknown> }> = [];
  visitSalesmenRecords(response, "body", records);
  let selected: ResolvedSalesmenOrderContext | null = null;
  let selectionReason = "not_selected";
  try {
    selected = resolveSalesmenOrderContext(response, requestedSeller);
    selectionReason = "matched_requested_seller";
  } catch (error) {
    selectionReason = error instanceof Error ? error.message : "selection_failed";
  }
  const root = response && typeof response === "object" ? response as Record<string, unknown> : null;
  const data = root && root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data as Record<string, unknown> : null;
  return {
    httpStatus,
    rootType: Array.isArray(response) ? "array" : typeof response,
    rootKeys: root && !Array.isArray(root) ? Object.keys(root).slice(0, 40) : [],
    dataKeys: data ? Object.keys(data).slice(0, 40) : [],
    recordsCount: records.length,
    requestedSeller: requestedSeller.sellerErpCode,
    candidatePaths: records.slice(0, 50).map(({ path, record }) => ({
      path,
      keys: Object.keys(record).slice(0, 60),
      codVendedor: pickFirstString(record, SALESMAN_CODE_KEYS) || null,
      codVendedorType: typeof record[SALESMAN_CODE_KEYS.find((key) => record[key] !== undefined) || ""],
      operador: pickFirstString(record, SALESMAN_OPERATOR_KEYS) || null,
      operadorType: typeof record[SALESMAN_OPERATOR_KEYS.find((key) => record[key] !== undefined) || ""],
      numeroPedido: pickFirstString(record, SALESMAN_NUM_PEDIDO_KEYS) || null,
      numeroPedidoType: typeof record[SALESMAN_NUM_PEDIDO_KEYS.find((key) => record[key] !== undefined) || ""],
    })),
    selectedPath: selected?.selectedPath ?? null,
    selectedNumeroPedido: selected?.numeroPedido ?? null,
    selectionReason,
  };
}

const resolveSalesmenPayload = (body: unknown, sellerErpCode: string) => {
  const records: Array<{ path: string; record: Record<string, unknown> }> = [];
  visitSalesmenRecords(body, "body", records);
  const context = resolveSalesmenOrderContext(body, { sellerErpCode });
  return { numeroPedido: context.numeroPedido, numeroPedidoPathUsed: `${context.selectedPath}.NUMERO_PEDIDO`, salesmen: records.map((entry) => entry.record), selectedPath: context.selectedPath };
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

    const response = await ultraFv3Client.request<unknown>(SALESMEN_ORDER_SEQUENCE_ENDPOINT, { correlationId: options.correlationId, timeoutMs: SALESMEN_ORDER_SEQUENCE_TIMEOUT_MS });
    await prisma.appConfig.upsert({
      where: { key: SALESMEN_CONFIG_KEY },
      update: { value: JSON.stringify(response) },
      create: { key: SALESMEN_CONFIG_KEY, value: JSON.stringify(response) },
    });
    return response;
  }

  const response = await requestUltraFv3ReadOnlyWithCredentialsRetry<unknown>(SALESMEN_ORDER_SEQUENCE_ENDPOINT, options.credentials, options.correlationId || randomUUID(), 1, SALESMEN_ORDER_SEQUENCE_TIMEOUT_MS);
  await prisma.appConfig.upsert({
    where: { key: SALESMEN_CONFIG_KEY },
    update: { value: JSON.stringify(response) },
    create: { key: SALESMEN_CONFIG_KEY, value: JSON.stringify(response) },
  });
  return response;
}

async function resolveSalesmanOrderSequenceUnsafe(context: SalesmanOrderSequenceContext, credentials: UltraFv3Credentials, correlationId: string): Promise<SalesmanOrderSequenceResolution> {
  const body = await loadSalesmenBody({ forceRefresh: true, credentials, correlationId });
  const { numeroPedido, numeroPedidoPathUsed, salesmen, selectedPath } = resolveSalesmenPayload(body, context.sellerErpCode);
  const matchedEntry = salesmen
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return { row: null, match: { matched: false, code: null, field: null, mode: null } };
      return { row: row as Record<string, unknown>, match: getSalesmanCodeMatch(row as Record<string, unknown>, context.sellerErpCode) };
    })
    .find((entry) => entry.match.matched);
  const matchedSalesman = matchedEntry?.row ?? null;
  const operatorPick = matchedSalesman
    ? pickFirstStringWithKey(matchedSalesman, SALESMAN_OPERATOR_KEYS)
    : { value: "", key: null };
  const namePick = matchedSalesman
    ? pickFirstStringWithKey(matchedSalesman, SALESMAN_NAME_KEYS)
    : { value: "", key: null };
  const loginPick = matchedSalesman
    ? pickFirstStringWithKey(matchedSalesman, SALESMAN_LOGIN_KEYS)
    : { value: "", key: null };
  const operatorCode = operatorPick.value;
  const validNumeroPedido = normalizeUltraFv3OrderNumber(numeroPedido);
  const diagnostics: SalesmanOrderSequenceDiagnostics = {
    endpoint: SALESMEN_ORDER_SEQUENCE_ENDPOINT,
    sellerId: context.sellerId,
    sellerName: context.sellerName,
    sellerErpCode: context.sellerErpCode,
    sellerErpCodeNormalized: normalizeErpLinkCodeForComparison(context.sellerErpCode),
    authContext: context.authContext,
    receivedSalesmenCount: salesmen.length,
    firstSellerCodesReceived: collectFirstSalesmanCodes(salesmen),
    availableSellerCodeFields: collectSalesmanCodeFields(salesmen),
    hasNumeroPedido: Boolean(validNumeroPedido),
    numeroPedidoPathUsed: selectedPath ? `${selectedPath}.NUMERO_PEDIDO` : numeroPedidoPathUsed,
    matchedSalesmanFound: Boolean(matchedSalesman),
    matchedSalesmanCode: matchedEntry?.match.code ?? null,
    matchedSalesmanCodeField: matchedEntry?.match.field ?? null,
    matchedSalesmanName: namePick.value || null,
    matchedSalesmanLogin: loginPick.value || null,
    matchedSalesmanFields: matchedSalesman ? Object.keys(matchedSalesman).slice(0, 60) : [],
    operatorFound: Boolean(operatorCode),
    operatorFieldUsed: operatorPick.key,
    comparisonMode: matchedEntry?.match.mode ?? null,
  };
  logApiEvent(validNumeroPedido && matchedSalesman && operatorCode ? "INFO" : "WARN", "[ultrafv3/order] order-number-selected", diagnostics);
  return { numPedido: validNumeroPedido, operatorCode, diagnostics };
}

async function resolveSalesmanOrderSequence(context: SalesmanOrderSequenceContext, credentials: UltraFv3Credentials, correlationId: string): Promise<SalesmanOrderSequenceResolution> {
  return erpOrderNumPedidoMutex.runExclusive(async () => {
    logApiEvent("INFO", "[ultrafv3/order] lock-acquired", {
      sellerId: context.sellerId,
      sellerName: context.sellerName,
      sellerErpCode: context.sellerErpCode,
      authContext: context.authContext,
      correlationId,
      endpoint: SALESMEN_ORDER_SEQUENCE_ENDPOINT,
    });
    try {
      return await resolveSalesmanOrderSequenceUnsafe(context, credentials, correlationId);
    } finally {
      logApiEvent("INFO", "[ultrafv3/order] lock-released", {
        sellerId: context.sellerId,
        sellerName: context.sellerName,
        sellerErpCode: context.sellerErpCode,
        authContext: context.authContext,
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
  const routeStageStartedAt = Date.now();
  const params = normalizeErpOrderParameterCodes(rawParams);
  const parameterDiagnostics = getErpOrderParameterDiagnostics(rawParams);
  const missingParameter = Object.entries(params).find(
    ([key, value]) => !["simulateOnly", "erpOrderObservation"].includes(key) && !value,
  );
  if (missingParameter)
    throw Object.assign(new Error(`Payload inválido: código ERP ausente em ${missingParameter[0]}.`), {
      status: 422,
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
  const numericClientErpCode = toUltraNumber(clientErpCode);
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
    throw Object.assign(new Error(`Payload inválido: item ${itemWithoutProductClass.lineNumber} sem classificação ERP (CODPRODUTO_CLAS). Produto ${itemWithoutProductClass.productNameSnapshot} / Linha ${itemWithoutProductClass.lineNumber} · ${itemWithoutProductClass.unit || "sem unidade"}. Confirme a classificação sincronizada antes de enviar ao UltraFV3.`), { status: 400 });
  if (opportunity.items.some((item) => !item.unit?.trim()))
    throw Object.assign(new Error("Payload inválido: há item sem unidade de medida."), {
      status: 400,
    });
  if (opportunity.items.some((item) => Number(item.unitPrice) <= 0 || Number(item.netTotal) <= 0))
    throw Object.assign(new Error("Payload inválido: pedido ERP bloqueado por item com preço zerado."), {
      status: 400,
    });
  try {
    await assertReferenceCode("priceTables", params.priceTableCode, "Tabela preço inválida para emissão ERP.");
    await assertReferenceCode("operations", params.operationCode, "Operação inválida para emissão ERP.");
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { parameterDiagnostics });
    throw error;
  }

  const now = new Date();
  const expectedDeliveryDate = parseIsoDateOnlyAsUtc(params.expectedDeliveryDate);
  if (!expectedDeliveryDate)
    throw Object.assign(new Error("Payload inválido: Data prevista de entrega obrigatória no formato YYYY-MM-DD."), { status: 400, parameterDiagnostics });
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
    hasErpOrderObservation: Boolean(params.erpOrderObservation),
  };
  logApiEvent(
    "INFO",
    "[erp order] validating UltraFV3 order before submission",
    operationContext,
  );

  await ultraFv3Client.authenticateWithCredentials(sellerCredentials);
  logErpOrderRouteStage("[ERP ORDER BEFORE SALESMEN]", {
    correlationId,
    opportunityId: opportunity.id,
    userId: opportunity.ownerSeller.id,
    routeStage: "before-salesmen",
    startedAt: routeStageStartedAt,
    pedidoIdImportacao,
    endpoint: SALESMEN_ORDER_SEQUENCE_ENDPOINT,
  });
  logApiEvent("INFO", "[ultrafv3/order] salesmen-request-start", {
    ...operationContext,
    correlationId: pedidoIdImportacao,
    routeCorrelationId: correlationId,
    endpoint: SALESMEN_ORDER_SEQUENCE_ENDPOINT,
  });
  const sequenceResolution = await resolveSalesmanOrderSequence({
    sellerId: opportunity.ownerSeller.id,
    sellerName: opportunity.ownerSeller.name,
    sellerErpCode,
    authContext: "seller",
  }, sellerCredentials, pedidoIdImportacao);
  logErpOrderRouteStage("[ERP ORDER AFTER SALESMEN]", {
    correlationId,
    opportunityId: opportunity.id,
    userId: opportunity.ownerSeller.id,
    routeStage: "after-salesmen",
    startedAt: routeStageStartedAt,
    pedidoIdImportacao,
    endpoint: SALESMEN_ORDER_SEQUENCE_ENDPOINT,
  }, {
    salesmenDiagnostics: sequenceResolution.diagnostics,
  });
  const salesmenNumPedido = String(sequenceResolution.numPedido || "");
  const effectiveOperatorCode = sequenceResolution.operatorCode || operatorCode;
  const numPedido = salesmenNumPedido;
  const numericSellerErpCode = Number(sellerErpCode);
  const numericOperatorCode = Number(effectiveOperatorCode);
  const erpLoginType = getErpLoginType(sellerFv3Username);
  const oldPessoaTypeConflictDetected = erpLoginType === "cpf" && /cnpj|pessoa\s*juri/i.test(JSON.stringify(sanitizeUltraValue(opportunity.ownerSeller)));
  const operatorResolutionDiagnostics = {
    userId: opportunity.ownerSeller.id,
    sellerName: opportunity.ownerSeller.name,
    sellerErpCode,
    erpLoginType,
    crmOperator: operatorCode || null,
    salesmenOperator: sequenceResolution.operatorCode || null,
    salesmenNumPedido: salesmenNumPedido || null,
    resolvedOperator: effectiveOperatorCode || null,
    resolvedNumPedido: numPedido || null,
    matchedBy: sequenceResolution.diagnostics.matchedSalesmanFound ? sequenceResolution.diagnostics.matchedSalesmanCodeField : null,
    oldPessoaTypeConflictDetected,
    authContext: sequenceResolution.diagnostics.authContext,
    reason: sequenceResolution.operatorCode
      ? "salesmen_operator"
      : operatorCode
        ? "crm_operator_fallback"
        : "missing_operator",
  };
  logApiEvent("INFO", "[erp order] resolved seller ERP operator/sequence", operatorResolutionDiagnostics);
  if (!effectiveOperatorCode || !sequenceResolution.diagnostics.matchedSalesmanFound || !Number.isFinite(numericSellerErpCode) || !Number.isFinite(numericOperatorCode)) {
    const diagnostics = { ...sequenceResolution.diagnostics, operatorResolution: operatorResolutionDiagnostics };
    const message = !diagnostics.matchedSalesmanFound
      ? `Vendedor ERP ${sellerErpCode} não retornou no /salesmen para a credencial utilizada.`
      : !effectiveOperatorCode
        ? `Vendedor ${sellerErpCode} sem operador ERP configurado no CRM e no UltraFV3.`
        : `Vínculo ERP inválido para vendedor ${sellerErpCode}.`;
    logApiEvent("WARN", "[erp order] seller ERP operator resolution blocked order", {
      ...operatorResolutionDiagnostics,
      reason: !diagnostics.matchedSalesmanFound
        ? "salesman_not_found"
        : !effectiveOperatorCode
          ? "missing_operator"
          : "invalid_numeric_codes",
    });
    throw Object.assign(
      new Error(message),
      { status: 400, diagnostics, endpoint: SALESMEN_ORDER_SEQUENCE_ENDPOINT },
    );
  }
  if (!salesmenNumPedido) {
    logApiEvent("WARN", "[erp order] /salesmen did not return a valid numeric NUMERO_PEDIDO; order submission blocked", operatorResolutionDiagnostics);
    throw Object.assign(
      new Error("Não foi possível obter do UltraFV3 um número sequencial válido para o pedido. Nenhum pedido foi enviado."),
      { status: 422, diagnostics: sequenceResolution.diagnostics, endpoint: SALESMEN_ORDER_SEQUENCE_ENDPOINT },
    );
  }

  const itens = opportunity.items.map((item, index) => {
    const unitFields = resolveOrderItemUnitFields(item);
    return {
      PEDIDO_ID: null,
      ITEM: index + 1,
      CODPRODUTO: toUltraNumber(item.erpProductCode),
      CODPRODUTO_CLAS: toUltraNumber(resolveOrderItemProductClassCode(item)),
      QTD_PEDIDO: Number(item.quantity),
      PRECO: Number(item.unitPrice),
      PRECO_LISTA: Number(item.unitPrice),
      VALOR_BRUTO: roundMoney(Number(item.grossTotal || 0)),
      VALOR_ACRESCIMO: 0,
      VALOR_DESCONTO: roundMoney(Number(item.discountTotal || 0)),
      VALOR_LIQUIDO: roundMoney(Number(item.netTotal || 0)),
      DESCRICAO_UNMED: unitFields.DESCRICAO_UNMED,
      UND_MEDIDA: unitFields.UND_MEDIDA,
      QTD_UNMED: 1,
      PESO_EMBALAGEM: 0,
      PESO_PRODUTO: null,
      MOTIVO_CANCELAMENTO: "",
      OBS: "",
      VALOR_ICMS_DESON: 0,
      ICMS_DESON_DESCTO_FINANCEIRO: "N",
      DESCRICAO_CLASSIFICACAO: resolveOrderItemProductClassDescription(item),
    };
  });
  const classificationDiagnostics = itens.map((item) => ({
    ITEM: item.ITEM,
    CODPRODUTO: item["CODPRODUTO"],
    CODPRODUTO_CLAS: item["CODPRODUTO_CLAS"],
    descricaoClassificacao: item.DESCRICAO_CLASSIFICACAO,
    unidadeEnviada: item["UND_MEDIDA"],
    descricaoUnidadeEnviada: item.DESCRICAO_UNMED,
  }));

  const valorBruto = roundMoney(opportunity.items.reduce((sum, item) => sum + Number(item.grossTotal || 0), 0));
  const valorDesconto = roundMoney(opportunity.items.reduce((sum, item) => sum + Number(item.discountTotal || 0), 0));
  const valorLiquido = roundMoney(opportunity.items.reduce((sum, item) => sum + Number(item.netTotal || 0), 0));
  const qtdPedido = roundMoney(opportunity.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0));

  const payload: UltraFv3OrderPayload = {
    PEDIDO_ID: null,
    PARCEIRO: numericClientErpCode,
    NUM_PEDIDO: String(numPedido),
    DATA_PEDIDO: formatDateDot(now),
    DATA_PREV_ENTREGA: formatDateDot(expectedDeliveryDate),
    VENDEDOR: numericSellerErpCode,
    OPERADOR: numericOperatorCode,
    CODOPER: toUltraNumber(params.operationCode),
    CODFILIAL: toUltraNumber(params.branchCode),
    TABELA_PRECO: toUltraNumber(params.priceTableCode),
    CODCONDREC: toUltraNumber(params.receivingConditionCode),
    FORMA: toUltraNumber(params.paymentMethodCode),
    VALOR_BRUTO: valorBruto,
    VALOR_ACRESCIMO: 0,
    VALOR_DESCONTO: valorDesconto,
    VALOR_LIQUIDO: valorLiquido,
    QTD_PEDIDO: qtdPedido,
    PRIORIDADE: 9,
    TIPO_MOVIMENTO: "PEDIDO",
    PEDIDO_ID_IMPORTACAO: pedidoIdImportacao,
    DATA_CANCELAMENTO: "",
    OBS_PEDIDO: params.erpOrderObservation,
    OBSERVACAO_INTERNA: null,
    ITENS: itens.map(({ DESCRICAO_CLASSIFICACAO, ...item }) => item),
  };

  const payloadValidationErrors = validateUltraFv3OrderPayload(payload);
  if (payloadValidationErrors.length) {
    throw Object.assign(new Error("Payload UltraFV3 /orders inválido; envio bloqueado antes de chamar o ERP."), {
      status: 422,
      errors: payloadValidationErrors,
      endpoint: "/orders",
      payload: sanitizeErpOrderPayload(payload),
      parameterDiagnostics,
    });
  }

  logApiEvent("INFO", "[erp order] final validated UltraFV3 /orders payload", {
    ...operationContext,
    correlationId: pedidoIdImportacao,
    payloadValidado: true,
    endpoint: "/orders",
    payload: buildFinalValidatedOrderPayloadLog(payload),
  });

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
      classificationDiagnostics,
    };
  }

  const sync = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ERP_ORDER_ADVISORY_LOCK_NAMESPACE}::integer, hashtext(${opportunity.id})::integer)`;

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

    const uncertainSync = await tx.erpOrderSync.findFirst({
      where: {
        opportunityId: opportunity.id,
        status: { in: [ErpOrderSyncStatus.pending, ErpOrderSyncStatus.error] },
      },
      orderBy: [{ createdAt: "desc" }],
    });

    if (uncertainSync && isUncertainErpOrderFailure(uncertainSync)) {
      throw Object.assign(
        new Error(
          "Há uma tentativa de pedido ERP com resultado desconhecido/timeout. Reenvio bloqueado para evitar duplicidade; confira o UltraFV3 antes de nova tentativa.",
        ),
        {
          status: 409,
          existingErpOrderSyncId: uncertainSync.id,
          pedidoIdImportacao: uncertainSync.pedidoIdImportacao,
          numPedido: uncertainSync.numPedido,
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

  logApiEvent("INFO", "[ultrafv3/order] order-pending-persisted", {
    ...operationContext,
    pedidoIdImportacao,
    numPedido,
    erpOrderSyncId: sync.id,
  });

  logApiEvent("INFO", "[ultrafv3/order] orders-request-start", {
    endpoint: "/orders",
    correlationId: pedidoIdImportacao,
    NUM_PEDIDO: payload.NUM_PEDIDO,
    PEDIDO_ID_IMPORTACAO: payload.PEDIDO_ID_IMPORTACAO,
    CODVENDEDOR: payload.VENDEDOR,
    OPERADOR: payload.OPERADOR,
    payload: sanitizeUltraValue({ ...payload, PARCEIRO: maskDocument(payload.PARCEIRO) }),
  });

  try {
    logErpOrderRouteStage("[ERP ORDER BEFORE ULTRAFV3 ORDERS]", {
      correlationId,
      opportunityId: opportunity.id,
      userId: opportunity.ownerSeller.id,
      routeStage: "before-ultrafv3-orders",
      startedAt: routeStageStartedAt,
      pedidoIdImportacao,
      erpOrderSyncId: sync.id,
      endpoint: "/orders",
    }, { timeoutMs: ULTRAFV3_ORDER_REQUEST_TIMEOUT_MS });
    logApiEvent("INFO", "[ultrafv3/order] orders-request-start", {
      ...operationContext,
      correlationId: pedidoIdImportacao,
      routeCorrelationId: correlationId,
      erpOrderSyncId: sync.id,
      timeoutMs: ULTRAFV3_ORDER_REQUEST_TIMEOUT_MS,
    });
    const erpResponse = await ultraFv3Client.requestWithCredentials<unknown>("/orders", sellerCredentials, {
      method: "POST",
      body: payload,
      correlationId: pedidoIdImportacao,
      timeoutMs: ULTRAFV3_ORDER_REQUEST_TIMEOUT_MS,
    });
    logApiEvent("INFO", "[ultrafv3/order] orders-response", {
      ...operationContext,
      pedidoIdImportacao,
      numPedido,
      erpOrderSyncId: sync.id,
      result: "received",
    });
    const functionalErrorMessage = getFunctionalOrderErrorMessage(erpResponse);
    if (functionalErrorMessage) {
      throw Object.assign(new Error(`UltraFV3 retornou erro funcional no POST /orders: ${functionalErrorMessage}`), {
        status: 502,
        endpoint: "/orders",
        diagnostics: {
          status: 200,
          endpoint: "/orders",
          method: "POST",
          message: functionalErrorMessage,
          ultraResponse: erpResponse,
          correlationId: pedidoIdImportacao,
          timeoutMs: ULTRAFV3_ORDER_REQUEST_TIMEOUT_MS,
        },
      });
    }
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
    logApiEvent("INFO", "[ultrafv3/order] order-sent", {
      ...operationContext,
      pedidoIdImportacao,
      numPedido,
      erpOrderNumber,
      erpOrderSyncId: sync.id,
    });
    logErpOrderRouteStage("[ERP ORDER AFTER ULTRAFV3 ORDERS]", {
      correlationId,
      opportunityId: opportunity.id,
      userId: opportunity.ownerSeller.id,
      routeStage: "after-ultrafv3-orders",
      startedAt: routeStageStartedAt,
      pedidoIdImportacao,
      erpOrderSyncId: sync.id,
      endpoint: "/orders",
    }, { erpOrderNumber });
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
      status: error instanceof UltraFv3IntegrationError ? error.status ?? (error.code === "timeout" ? 504 : 502) : 502,
      ultraFv3Failure: failure,
      endpoint: failure.endpoint,
      diagnostics: error instanceof UltraFv3IntegrationError ? error.diagnostics : undefined,
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
  if (!simulateOnly) assertErpRuntimeConfigForOrderSubmission();
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
      ? error.status ?? (error.code === "timeout" ? 504 : error.code === "unavailable" || error.code === "missing_credentials" ? 503 : 502)
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
      order.erpOrderNumber || order.pedidoIdImportacao;
    const correlationId = randomUUID();
    try {
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
            { message, at: new Date().toISOString(), operation: "orderStatus", correlationId, nonCritical: true },
          ]),
          statusSyncedAt: new Date(),
        },
      });
      logApiEvent(
        "WARN",
        "[erp order status] UltraFV3 order status sync failed (non-critical)",
        {
          erpOrderSyncId: order.id,
          opportunityId: order.opportunityId,
          pedidoIdImportacao: order.pedidoIdImportacao,
          query,
          correlationId,
          error: message,
          nonCritical: true,
        },
      );
      await sleep(250);
    }
  }

  return { syncedCount, errorCount, diagnostics: { nonCriticalOrderStatusErrors: errorCount } };
}


export async function getZeroNumPedidoDryRunReport() {
  const rows = await prisma.erpOrderSync.findMany({
    where: { OR: [{ numPedido: "0" }, { erpOrderNumber: "0" }] },
    orderBy: [{ createdAt: "desc" }],
    take: 100,
    select: {
      opportunityId: true,
      pedidoIdImportacao: true,
      status: true,
      createdAt: true,
      numPedido: true,
      erpOrderNumber: true,
      opportunity: { select: { clientId: true } },
    },
  });
  return {
    count: rows.length,
    requiresManualUltraFv3Review: rows.length > 0,
    records: rows.map((row) => ({
      opportunityId: row.opportunityId,
      clientId: row.opportunity.clientId,
      data: row.createdAt.toISOString(),
      pedidoIdImportacao: row.pedidoIdImportacao,
      status: row.status,
      numPedido: row.numPedido,
      erpOrderNumber: row.erpOrderNumber,
      action: "necessita conferência manual no UltraFV3",
    })),
  };
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
