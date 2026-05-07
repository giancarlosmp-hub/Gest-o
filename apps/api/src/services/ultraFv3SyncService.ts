import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { ultraFv3Client } from "./ultraFv3Client.js";
import { logApiEvent } from "../utils/logger.js";

const ERP_SYNC_STATUS_KEY = "erp.ultrafv3.sync.status";

export type UltraFv3SyncScope =
  | "connection"
  | "products"
  | "partners"
  | "salesmen"
  | "paymentMethods"
  | "receivingConditions"
  | "priceTables"
  | "branches"
  | "operations";

type SyncStatusPayload = {
  scope: UltraFv3SyncScope;
  status: "idle" | "running" | "success" | "error";
  lastSyncAt?: string;
  syncedCount?: number;
  errors?: string[];
  diagnostics?: Record<string, number>;
};

type SyncResult = { syncedCount: number; diagnostics?: Record<string, number> };

const pickFirstValue = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
};

const pickFirstString = (payload: Record<string, unknown>, keys: string[]) => {
  const value = pickFirstValue(payload, keys);
  return value === null ? "" : String(value).trim();
};

const pickFirstNumber = (payload: Record<string, unknown>, keys: string[]) => {
  const value = pickFirstValue(payload, keys);
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toArray = (payload: unknown) => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["data", "items", "rows", "result", "results", "content"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
};

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function fetchUltraFv3Rows(endpoint: string, scope: UltraFv3SyncScope) {
  const response = await ultraFv3Client.request<unknown>(endpoint);
  const rows = toArray(response);
  if (!rows.length) {
    throw new Error(`Retorno vazio do UltraFV3 para ${scope} (${endpoint}).`);
  }
  return rows;
}

async function writeSyncStatus(payload: SyncStatusPayload) {
  const current = await prisma.appConfig.findUnique({ where: { key: ERP_SYNC_STATUS_KEY }, select: { value: true } });
  const parsed = current?.value ? JSON.parse(current.value) : {};
  parsed[payload.scope] = payload;
  await prisma.appConfig.upsert({
    where: { key: ERP_SYNC_STATUS_KEY },
    update: { value: JSON.stringify(parsed) },
    create: { key: ERP_SYNC_STATUS_KEY, value: JSON.stringify(parsed) }
  });
}

async function runSync(scope: UltraFv3SyncScope, runner: () => Promise<SyncResult>) {
  await writeSyncStatus({ scope, status: "running", lastSyncAt: new Date().toISOString(), syncedCount: 0 });
  logApiEvent("INFO", `[ultrafv3 sync] ${scope} started`, { scope });

  try {
    const result = await runner();
    await writeSyncStatus({ scope, status: "success", lastSyncAt: new Date().toISOString(), ...result });
    logApiEvent("INFO", `[ultrafv3 sync] ${scope} finished`, { scope, ...result });
    return result;
  } catch (error) {
    const message = formatError(error);
    await writeSyncStatus({ scope, status: "error", lastSyncAt: new Date().toISOString(), syncedCount: 0, errors: [message] });
    logApiEvent("ERROR", `[ultrafv3 sync] ${scope} failed`, { scope, error: message });
    throw error;
  }
}

export async function syncConnection() {
  return runSync("connection", async () => {
    await ultraFv3Client.request<unknown>("/health");
    return { syncedCount: 1 };
  });
}

export async function syncProducts() {
  return runSync("products", async () => {
    const rows = await fetchUltraFv3Rows("/products", "products");
    const diagnostics = {
      received: rows.length,
      invalidInactive: 0,
      invalidSuspended: 0,
      invalidMissingCode: 0,
      invalidMissingUnit: 0,
      invalidWithoutPrice: 0,
      withoutStock: 0
    };
    let syncedCount = 0;

    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const payload = row as Record<string, unknown>;
      const code = pickFirstString(payload, ["code", "erpProductCode", "codigo", "CODIGO", "produtoCodigo"]);
      const classCode = pickFirstString(payload, ["classification", "erpProductClassCode", "classCode", "classe", "CLASSIFICACAO"]) || "default";
      const unit = pickFirstString(payload, ["unit", "unidade", "UNIDADE", "unitCode", "un"]);
      const price = pickFirstNumber(payload, ["price", "defaultPrice", "minPrice", "preco", "PRECO", "salePrice", "valor"]);
      const stockQuantity = pickFirstValue(payload, ["stockQuantity", "stock", "estoque", "ESTOQUE", "availableStock"]);
      const status = pickFirstString(payload, ["status", "situacao", "SITUACAO"]).toLowerCase();
      const activeFlag = pickFirstValue(payload, ["isActive", "active", "ativo", "ATIVO"]);
      const suspendedFlag = pickFirstValue(payload, ["isSuspended", "suspended", "suspenso", "SUSPENSO"]);
      const activeFlagNormalized = String(activeFlag).trim().toLowerCase();
      const suspendedFlagNormalized = String(suspendedFlag).trim().toLowerCase();
      const isActive = activeFlag === null
        ? !["inactive", "inativo", "suspended", "suspenso"].includes(status)
        : activeFlag !== false && !["false", "0", "n", "nao", "não", "inativo"].includes(activeFlagNormalized);
      const isSuspended = suspendedFlag === true || ["true", "1", "s", "sim", "suspenso"].includes(suspendedFlagNormalized) || ["suspended", "suspenso"].includes(status);

      if (!isActive) {
        diagnostics.invalidInactive += 1;
        continue;
      }
      if (isSuspended) {
        diagnostics.invalidSuspended += 1;
        continue;
      }
      if (!code) {
        diagnostics.invalidMissingCode += 1;
        continue;
      }
      if (!unit) {
        diagnostics.invalidMissingUnit += 1;
        continue;
      }
      if (!Number.isFinite(price) || price <= 0) {
        diagnostics.invalidWithoutPrice += 1;
        continue;
      }

      const stockNumber = stockQuantity === null ? null : Number(stockQuantity);
      if (stockNumber !== null && Number.isFinite(stockNumber) && stockNumber <= 0) diagnostics.withoutStock += 1;

      await prisma.product.upsert({
        where: { erpProductCode_erpProductClassCode: { erpProductCode: code, erpProductClassCode: classCode } },
        update: {
          name: pickFirstString(payload, ["description", "name", "descricao", "NOME"]) || "Produto sem descrição",
          className: pickFirstString(payload, ["classificationName", "className", "nomeClassificacao"]) || null,
          groupName: pickFirstString(payload, ["group", "groupName", "grupo"]) || null,
          unit,
          brand: pickFirstString(payload, ["brand", "marca"]) || null,
          stockQuantity: stockNumber !== null && Number.isFinite(stockNumber) ? stockNumber : null,
          defaultPrice: price,
          minPrice: pickFirstNumber(payload, ["minPrice", "precoMinimo"]) || price,
          isActive: true,
          isSuspended: false,
          rawErpPayload: payload as Prisma.InputJsonValue
        },
        create: {
          erpProductCode: code,
          erpProductClassCode: classCode,
          name: pickFirstString(payload, ["description", "name", "descricao", "NOME"]) || "Produto sem descrição",
          className: pickFirstString(payload, ["classificationName", "className", "nomeClassificacao"]) || null,
          groupName: pickFirstString(payload, ["group", "groupName", "grupo"]) || null,
          unit,
          brand: pickFirstString(payload, ["brand", "marca"]) || null,
          stockQuantity: stockNumber !== null && Number.isFinite(stockNumber) ? stockNumber : null,
          defaultPrice: price,
          minPrice: pickFirstNumber(payload, ["minPrice", "precoMinimo"]) || price,
          isActive: true,
          isSuspended: false,
          rawErpPayload: payload as Prisma.InputJsonValue
        }
      });
      syncedCount += 1;
    }

    return { syncedCount, diagnostics };
  });
}

export async function syncPartners() {
  return runSync("partners", async () => {
    const rows = await fetchUltraFv3Rows("/partners", "partners");
    const fallbackSeller = await prisma.user.findFirst({ where: { role: "vendedor", isActive: true }, select: { id: true } });
    if (!fallbackSeller) throw new Error("Nenhum vendedor ativo encontrado para vincular clientes sincronizados.");

    let syncedCount = 0;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const payload = row as Record<string, unknown>;
      const code = pickFirstString(payload, ["code", "erpCode", "codigo", "CODIGO", "partnerCode"]);
      if (!code) continue;
      const existing = await prisma.client.findFirst({ where: { code } });
      const data = {
        code,
        name: pickFirstString(payload, ["corporateName", "name", "razaoSocial", "nome", "NOME"]) || "Cliente sem nome",
        fantasyName: pickFirstString(payload, ["fantasyName", "nomeFantasia", "apelido"]) || null,
        cnpj: pickFirstString(payload, ["cpfCnpj", "cnpj", "cpf", "document", "documentNumber", "CNPJCPF"]) || null,
        city: pickFirstString(payload, ["city", "cidade", "CIDADE"]) || "Não informado",
        state: pickFirstString(payload, ["state", "uf", "UF", "estado"]) || "NI",
        region: pickFirstString(payload, ["region", "regiao"]) || "Não informado",
        ownerSellerId: fallbackSeller.id,
        erpUpdatedAt: new Date()
      };
      if (existing) await prisma.client.update({ where: { id: existing.id }, data });
      else await prisma.client.create({ data });
      syncedCount += 1;
    }
    return { syncedCount, diagnostics: { received: rows.length, withoutCode: rows.length - syncedCount } };
  });
}

async function syncReferenceData(scope: Exclude<UltraFv3SyncScope, "connection" | "products" | "partners">, endpoint: string) {
  return runSync(scope, async () => {
    const rows = await fetchUltraFv3Rows(endpoint, scope);
    await prisma.appConfig.upsert({
      where: { key: `erp.ultrafv3.${scope}` },
      update: { value: JSON.stringify(rows) },
      create: { key: `erp.ultrafv3.${scope}`, value: JSON.stringify(rows) }
    });
    return { syncedCount: rows.length };
  });
}

export const syncPriceTables = () => syncReferenceData("priceTables", "/price-tables");
export const syncPaymentMethods = () => syncReferenceData("paymentMethods", "/payment-methods");
export const syncReceivingConditions = () => syncReferenceData("receivingConditions", "/receiving-conditions");
export const syncBranches = () => syncReferenceData("branches", "/branches");
export const syncOperations = () => syncReferenceData("operations", "/operations");
export const syncSalesmen = () => syncReferenceData("salesmen", "/salesmen");

export async function getUltraFv3SyncStatus() {
  const config = await prisma.appConfig.findUnique({ where: { key: ERP_SYNC_STATUS_KEY }, select: { value: true } });
  const parsed = config?.value ? JSON.parse(config.value) : {};
  const scopes: UltraFv3SyncScope[] = ["connection", "products", "partners", "salesmen", "paymentMethods", "receivingConditions", "priceTables", "branches", "operations"];
  return scopes.reduce<Record<UltraFv3SyncScope, SyncStatusPayload>>((acc, scope) => {
    acc[scope] = parsed[scope] ?? { scope, status: "idle", syncedCount: 0 };
    return acc;
  }, {} as Record<UltraFv3SyncScope, SyncStatusPayload>);
}
