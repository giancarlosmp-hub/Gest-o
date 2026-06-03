import { Router } from "express";
import { ultraFv3Client } from "../services/ultraFv3Client.js";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { authMiddleware } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";

const router = Router();

const erpAccess = [authMiddleware, authorize("diretor", "gerente")];
const erpReferenceAccess = [authMiddleware, authorize("diretor", "gerente", "vendedor")];

type ErpReferenceScope = "paymentMethods" | "receivingConditions" | "priceTables" | "branches" | "operations";

type ErpReferenceOption = {
  id: string;
  code: string;
  name: string;
  label: string;
  value: string;
};

const referenceOptionKeys: Record<ErpReferenceScope, { code: string[]; name: string[] }> = {
  paymentMethods: {
    code: ["code", "codigo", "CODIGO", "id", "ID", "value", "COD", "cod", "FORMA", "CODFORMAPAGAMENTO", "CODFORMA"],
    name: ["name", "nome", "NOME", "description", "descricao", "DESCRICAO", "label", "LABEL", "FORMA_PAGAMENTO", "DESCFORMAPAGAMENTO"],
  },
  receivingConditions: {
    code: ["code", "codigo", "CODIGO", "id", "ID", "value", "COD", "cod", "CODCONDREC", "CONDICAO", "CODCONDICAO"],
    name: ["name", "nome", "NOME", "description", "descricao", "DESCRICAO", "label", "LABEL", "CONDICAO_RECEBIMENTO", "DESCCONDREC"],
  },
  priceTables: {
    code: ["code", "codigo", "CODIGO", "id", "ID", "value", "COD", "cod", "TABELA_PRECO", "CODTABELA", "CODTABPRECO"],
    name: ["name", "nome", "NOME", "description", "descricao", "DESCRICAO", "label", "LABEL", "TABELA", "DESCTABELA"],
  },
  branches: {
    code: ["code", "codigo", "CODIGO", "id", "ID", "value", "COD", "cod", "CODFILIAL", "FILIAL"],
    name: ["name", "nome", "NOME", "description", "descricao", "DESCRICAO", "label", "LABEL", "fantasyName", "razaoSocial", "NOMEFILIAL"],
  },
  operations: {
    code: ["code", "codigo", "CODIGO", "id", "ID", "value", "COD", "cod", "CODOPER", "OPERACAO", "CODOPE"],
    name: ["name", "nome", "NOME", "description", "descricao", "DESCRICAO", "label", "LABEL", "DESCOPER", "DESCRICAOOPERACAO"],
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

const toReferenceOptions = (scope: ErpReferenceScope, payload: unknown): ErpReferenceOption[] => {
  const keys = referenceOptionKeys[scope];
  return toArray(payload)
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const record = row as Record<string, unknown>;
      const code = readFirstText(record, keys.code);
      if (!code) return null;
      const name = readFirstText(record, keys.name) || code;
      return {
        id: readFirstText(record, ["id", "ID", "uuid", "UUID"]) || code,
        code,
        name,
        label: name && name !== code ? `${code} · ${name}` : code,
        value: code,
      };
    })
    .filter((option): option is ErpReferenceOption => Boolean(option));
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
    const data = await ultraFv3Client.request(path);
    return res.status(200).json(data);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[ultrafv3 proxy] request failed", {
      path,
      error: details,
    });
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
router.get("/erp/ultrafv3/branches", ...erpReferenceAccess, wrapReference("branches"));
router.get("/erp/ultrafv3/operations", ...erpReferenceAccess, wrapReference("operations"));
router.get("/erp/ultrafv3/salesmen", ...erpAccess, wrap("/salesmen"));
router.get("/erp/ultrafv3/order-status", ...erpAccess, wrap("/orderStatus"));

export default router;
