import { Router } from "express";
import { buildUltraFv3TimeoutPayload, isUltraFv3TimeoutError, ULTRAFV3_REQUEST_TIMEOUT_MS, ultraFv3Client } from "../services/ultraFv3Client.js";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { authMiddleware } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { normalizeErpParameterCode } from "@salesforce-pro/shared";

const router = Router();

const erpAccess = [authMiddleware, authorize("diretor", "gerente")];
const erpReferenceAccess = [authMiddleware, authorize("diretor", "gerente", "vendedor")];

type ErpReferenceScope = "paymentMethods" | "receivingConditions" | "priceTables" | "branches" | "operations";

type ErpReferenceOption = {
  id: string;
  code: string;
  name: string;
  description: string;
  label: string;
  value: string;
  raw: Record<string, unknown>;
};

type ReferenceOptionKeyMap = {
  code: string[];
  name: string[];
  fallbackDescriptions?: Record<string, string>;
};

const referenceOptionKeys: Record<ErpReferenceScope, ReferenceOptionKeyMap> = {
  paymentMethods: {
    code: ["FORMA", "CODFORMA", "COD_FORMA", "CODIGO", "code", "codigo", "id", "ID", "value"],
    name: ["DESCRICAO", "DSCFORMA", "DSC_FORMA", "NOME", "name", "description", "descricao", "label", "LABEL"],
  },
  receivingConditions: {
    code: ["CODCONDREC", "CONDICAO", "COD_CONDICAO", "CODIGO", "code", "codigo", "id", "ID", "value"],
    name: ["DESCRICAO", "DSCCONDREC", "DSC_CONDICAO", "NOME", "name", "description", "descricao", "label", "LABEL"],
  },
  priceTables: {
    code: ["TABELA", "CODTABELA", "COD_TABELA", "ID_TABELA", "priceTable", "code", "codigo", "CODIGO", "id", "ID", "value"],
    name: ["DESCRICAO", "DESCRICAO_TABELA", "DSC_TABELA", "NOME", "NOME_TABELA", "TABELA_DESCRICAO", "name", "description", "descricao", "label", "LABEL"],
    fallbackDescriptions: {
      "1": "REVENDA / COOPERATIVA",
      "2": "CONSUMIDOR FINAL",
    },
  },
  branches: {
    code: ["CODFILIAL", "FILIAL", "COD_FILIAL", "CODIGO", "code", "codigo", "id", "ID", "value"],
    name: ["DESCRICAO", "DSCFILIAL", "NOME", "RAZAO_SOCIAL", "FANTASIA", "name", "description", "descricao", "label", "LABEL", "fantasyName", "razaoSocial"],
  },
  operations: {
    code: ["CODOPER", "OPERACAO", "COD_OPERACAO", "CODIGO", "code", "codigo", "id", "ID", "value"],
    name: ["DESCRICAO", "DSCOPER", "DSC_OPERACAO", "NOME", "OPERACAO_DESCRICAO", "name", "description", "descricao", "label", "LABEL"],
    fallbackDescriptions: {
      "100": "VENDA",
    },
  },
};

const getTextValue = (value: unknown) => (value == null ? "" : String(value).trim());

const readFirstText = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = getTextValue(source[key]);
    if (value) return value;
  }
  return "";
};

const toArray = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["items", "data", "rows", "results", "content"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
};

const normalizeCodeKey = (value: string) => value.trim().replace(/^0+(?=\d)/, "") || value.trim();

const getFallbackDescription = (scope: ErpReferenceScope, code: string) => {
  const normalizedCode = normalizeCodeKey(code);
  return referenceOptionKeys[scope].fallbackDescriptions?.[normalizedCode] || "";
};

const toReferenceOptions = (scope: ErpReferenceScope, payload: unknown): ErpReferenceOption[] => {
  const keys = referenceOptionKeys[scope];
  const rows = toArray(payload);
  const items = rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const record = row as Record<string, unknown>;
      const rawCode = readFirstText(record, keys.code);
      const code = normalizeErpParameterCode(rawCode);
      if (!code) return null;
      const rawDescription = readFirstText(record, keys.name);
      const mappedDescription = rawDescription.startsWith(`${code} ·`)
        ? rawDescription.slice(rawDescription.indexOf("·") + 1).trim()
        : rawDescription;
      const fallbackDescription = mappedDescription ? "" : getFallbackDescription(scope, code);
      const description = mappedDescription || fallbackDescription;
      const name = description || code;
      const label = `${code} · ${description || name}`;
      return {
        id: readFirstText(record, ["id", "ID", "uuid", "UUID"]) || code,
        code,
        name,
        description,
        label,
        value: code,
        raw: record,
      };
    })
    .filter((option): option is ErpReferenceOption => Boolean(option));

  if (scope === "priceTables" || scope === "operations") {
    const firstRecord = rows.find((row) => row && typeof row === "object") as Record<string, unknown> | undefined;
    logApiEvent("INFO", "[ultrafv3 references] normalized local sync cache", {
      scope,
      cacheCount: rows.length,
      sampleKeys: firstRecord ? Object.keys(firstRecord).slice(0, 20) : [],
      normalizedCount: items.length,
      sampleLabels: items.slice(0, 3).map((item) => item.label),
    });
  }

  return items;
};

const wrapReference = (scope: ErpReferenceScope) => async (_req: any, res: any) => {
  try {
    const stored = await prisma.appConfig.findUnique({
      where: { key: `erp.ultrafv3.${scope}` },
      select: { value: true, updatedAt: true },
    });
    const rawRows = stored?.value ? JSON.parse(stored.value) : [];
    const items = toReferenceOptions(scope, rawRows);
    return res.status(200).json({
      items,
      data: items,
      count: items.length,
      source: "local-sync",
      syncedAt: stored?.updatedAt?.toISOString() ?? null,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[ultrafv3 references] failed to load local sync data", {
      scope,
      error: details,
    });
    return res.status(500).json({
      message: "Falha ao carregar dados sincronizados do UltraFV3.",
      details,
    });
  }
};

const wrap = (path: string) => async (_req: any, res: any) => {
  try {
    const data = await ultraFv3Client.request(path, { timeoutMs: ULTRAFV3_REQUEST_TIMEOUT_MS });
    return res.status(200).json(data);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[ultrafv3 proxy] request failed", {
      path,
      error: details,
    });
    const diagnostics = error && typeof error === "object" ? (error as { diagnostics?: { correlationId?: string; endpoint?: string; method?: string; timeoutMs?: number }; status?: number }) : {};
    if (isUltraFv3TimeoutError(error) || diagnostics.status === 504) {
      return res.status(504).json(buildUltraFv3TimeoutPayload({
        correlationId: diagnostics.diagnostics?.correlationId,
        endpoint: diagnostics.diagnostics?.endpoint || path,
        method: diagnostics.diagnostics?.method || "GET",
        timeoutMs: diagnostics.diagnostics?.timeoutMs || ULTRAFV3_REQUEST_TIMEOUT_MS,
      }));
    }
    return res.status(502).json({
      message: "Falha de integração UltraFV3.",
      details,
    });
  }
};

router.get("/erp/ultrafv3/health", ...erpAccess, wrap("/health"));
router.get("/erp/ultrafv3/products", ...erpAccess, wrap("/products"));
router.get("/erp/ultrafv3/partners", ...erpAccess, wrap("/partners"));
router.get(
  "/erp/ultrafv3/payment-methods",
  ...erpReferenceAccess,
  wrapReference("paymentMethods"),
);
router.get(
  "/erp/ultrafv3/receiving-conditions",
  ...erpReferenceAccess,
  wrapReference("receivingConditions"),
);
router.get("/erp/ultrafv3/price-tables", ...erpReferenceAccess, wrapReference("priceTables"));
router.get("/erp/ultrafv3/price-variations", ...erpAccess, wrap("/priceVariations"));
router.get("/erp/ultrafv3/prices", ...erpAccess, wrap("/prices"));
router.get("/erp/ultrafv3/branches", ...erpReferenceAccess, wrapReference("branches"));
router.get("/erp/ultrafv3/operations", ...erpReferenceAccess, wrapReference("operations"));
router.get("/erp/ultrafv3/salesmen", ...erpAccess, wrap("/salesmen"));
router.get("/erp/ultrafv3/order-status", ...erpAccess, wrap("/orderStatus"));

export default router;
