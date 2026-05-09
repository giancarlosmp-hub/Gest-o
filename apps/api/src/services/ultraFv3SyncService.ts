import { Prisma, ErpSyncRunStatus, ErpSyncTrigger } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { ultraFv3Client } from "./ultraFv3Client.js";
import { logApiEvent } from "../utils/logger.js";
import { normalizeCnpj, normalizeState } from "../utils/normalize.js";

const ERP_SYNC_STATUS_KEY = "erp.ultrafv3.sync.status";
const ERP_SYNC_LOCK_TTL_MS = 30 * 60 * 1000;
const ERP_SYNC_READ_RETRY_ATTEMPTS = 3;
const ERP_SYNC_READ_RETRY_BASE_DELAY_MS = 750;

export type UltraFv3SyncScope =
  | "connection"
  | "products"
  | "partners"
  | "salesmen"
  | "paymentMethods"
  | "receivingConditions"
  | "priceTables"
  | "branches"
  | "operations"
  | "orderStatus";

type SyncStatusPayload = {
  scope: UltraFv3SyncScope;
  status: "idle" | "running" | "success" | "error" | "skipped";
  lastSyncAt?: string;
  syncedCount?: number;
  errors?: string[];
  correlationId?: string;
  durationMs?: number;
  diagnostics?: Record<string, number>;
  trigger?: ErpSyncTrigger;
  runId?: string;
};

export type SyncResult = { syncedCount: number; diagnostics?: Record<string, number> };
export type RunSyncOptions = { trigger?: ErpSyncTrigger; failIfLocked?: boolean };
type LockAcquireResult = { acquired: true; runId: string } | { acquired: false; runId: string; lockedUntil: Date | null };

type UltraFv3IntegrationDiagnostics = {
  baseUrl: string | null;
  isConfigured: boolean;
  missingConfig: string[];
  authenticationStatus: "missing_config" | "authenticated" | "not_authenticated" | "auth_failed";
  lastError: string | null;
  lastLoginAt?: string | null;
  tokenExpiresAt?: string | null;
  tokenExpired?: boolean;
  guidance: string;
};

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function requestUltraFv3ReadOnlyWithRetry<T>(endpoint: string, correlationId: string, attempts = ERP_SYNC_READ_RETRY_ATTEMPTS) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await ultraFv3Client.request<T>(endpoint, { correlationId });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const delayMs = ERP_SYNC_READ_RETRY_BASE_DELAY_MS * attempt;
      logApiEvent("WARN", "[ultrafv3 sync] retrying read-only ERP request", { endpoint, correlationId, attempt, attempts, delayMs, error: formatError(error) });
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(formatError(lastError));
}

async function fetchUltraFv3Rows(endpoint: string, scope: UltraFv3SyncScope, correlationId: string) {
  const response = await requestUltraFv3ReadOnlyWithRetry<unknown>(endpoint, correlationId);
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

async function acquireSyncLock(scope: UltraFv3SyncScope, runId: string): Promise<LockAcquireResult> {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ERP_SYNC_LOCK_TTL_MS);
  try {
    await prisma.erpSyncLock.create({ data: { scope, runId, lockedUntil } });
    return { acquired: true, runId };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
  }

  const updated = await prisma.erpSyncLock.updateMany({
    where: {
      scope,
      OR: [{ lockedUntil: { lt: now } }, { runId }],
    },
    data: { runId, lockedUntil, updatedAt: now },
  });
  if (updated.count > 0) return { acquired: true, runId };

  const current = await prisma.erpSyncLock.findUnique({ where: { scope }, select: { runId: true, lockedUntil: true } });
  return { acquired: false, runId: current?.runId ?? runId, lockedUntil: current?.lockedUntil ?? null };
}

async function releaseSyncLock(scope: UltraFv3SyncScope, runId: string) {
  await prisma.erpSyncLock.deleteMany({ where: { scope, runId } });
}

async function runSync(scope: UltraFv3SyncScope, runner: (correlationId: string) => Promise<SyncResult>, options: RunSyncOptions = {}) {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const startedAtDate = new Date();
  const trigger = options.trigger ?? ErpSyncTrigger.manual;
  const lock = await acquireSyncLock(scope, correlationId);

  if (!lock.acquired) {
    const message = `Sincronização ${scope} já está em execução até ${lock.lockedUntil?.toISOString() ?? "instante desconhecido"}.`;
    await prisma.erpSyncRun.create({
      data: {
        scope,
        trigger,
        status: ErpSyncRunStatus.skipped,
        correlationId,
        startedAt: startedAtDate,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        syncedCount: 0,
        metrics: { skippedByLock: 1, lockedRunId: lock.runId } as Prisma.InputJsonValue,
        errorMessage: message,
      },
    });
    await writeSyncStatus({ scope, status: "running", lastSyncAt: startedAtDate.toISOString(), syncedCount: 0, correlationId: lock.runId, trigger });
    logApiEvent("WARN", `[ultrafv3 sync] ${scope} skipped because lock is active`, { scope, correlationId, lockedRunId: lock.runId, lockedUntil: lock.lockedUntil?.toISOString() });
    if (options.failIfLocked ?? true) throw Object.assign(new Error(message), { status: 409 });
    return { syncedCount: 0, diagnostics: { skippedByLock: 1 } };
  }

  const run = await prisma.erpSyncRun.create({ data: { scope, trigger, status: ErpSyncRunStatus.running, correlationId, startedAt: startedAtDate } });
  await writeSyncStatus({ scope, status: "running", lastSyncAt: startedAtDate.toISOString(), syncedCount: 0, correlationId, trigger, runId: run.id });
  logApiEvent("INFO", `[ultrafv3 sync] ${scope} started`, { scope, correlationId, trigger, runId: run.id });

  try {
    const result = await runner(correlationId);
    const durationMs = Date.now() - startedAt;
    const finishedAt = new Date();
    await prisma.erpSyncRun.update({
      where: { id: run.id },
      data: { status: ErpSyncRunStatus.success, finishedAt, durationMs, syncedCount: result.syncedCount, metrics: (result.diagnostics ?? {}) as Prisma.InputJsonValue },
    });
    await writeSyncStatus({ scope, status: "success", lastSyncAt: finishedAt.toISOString(), correlationId, durationMs, trigger, runId: run.id, ...result });
    logApiEvent("INFO", `[ultrafv3 sync] ${scope} finished`, { scope, correlationId, durationMs, trigger, runId: run.id, ...result });
    return result;
  } catch (error) {
    const message = formatError(error);
    const durationMs = Date.now() - startedAt;
    const finishedAt = new Date();
    await prisma.erpSyncRun.update({
      where: { id: run.id },
      data: { status: ErpSyncRunStatus.error, finishedAt, durationMs, syncedCount: 0, errorMessage: message, errors: [{ message, at: finishedAt.toISOString(), correlationId }] as Prisma.InputJsonValue },
    });
    await writeSyncStatus({ scope, status: "error", lastSyncAt: finishedAt.toISOString(), syncedCount: 0, errors: [message], correlationId, durationMs, trigger, runId: run.id });
    logApiEvent("ERROR", `[ultrafv3 sync] ${scope} failed`, { scope, correlationId, durationMs, trigger, runId: run.id, error: message, operationalAlert: true });
    throw error;
  } finally {
    await releaseSyncLock(scope, correlationId).catch((error) => logApiEvent("ERROR", "[ultrafv3 sync] failed to release lock", { scope, correlationId, error: formatError(error) }));
  }
}

export async function syncConnection(options?: RunSyncOptions) {
  return runSync("connection", async (correlationId) => {
    await requestUltraFv3ReadOnlyWithRetry<unknown>("/health", correlationId);
    return { syncedCount: 1 };
  }, options);
}

export async function syncProducts(options?: RunSyncOptions) {
  return runSync("products", async (correlationId) => {
    const rows = await fetchUltraFv3Rows("/products", "products", correlationId);
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

      const product = await prisma.product.upsert({
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
      const priceTableCode = pickFirstString(payload, ["priceTable", "priceTableCode", "tabelaPreco", "TABELA_PRECO"]);
      const branchCode = pickFirstString(payload, ["branchCode", "filial", "CODFILIAL"]);
      const existingPrice = await prisma.productPrice.findFirst({
        where: { productId: product.id, erpPriceId: priceTableCode || null, branchCode: branchCode || null }
      });
      if (existingPrice) {
        await prisma.productPrice.update({ where: { id: existingPrice.id }, data: { price } });
      } else {
        await prisma.productPrice.create({ data: { productId: product.id, erpPriceId: priceTableCode || null, branchCode: branchCode || null, price } });
      }
      syncedCount += 1;
    }

    logApiEvent("INFO", "[ultrafv3 sync products] processed products payload", { correlationId, syncedCount, diagnostics });
    return { syncedCount, diagnostics };
  }, options);
}

export async function syncPartners(options?: RunSyncOptions) {
  return runSync("partners", async (correlationId) => {
    const rows = await fetchUltraFv3Rows("/partners", "partners", correlationId);
    const fallbackSeller = await prisma.user.findFirst({ where: { role: "vendedor", isActive: true }, select: { id: true } });
    if (!fallbackSeller) throw new Error("Nenhum vendedor ativo encontrado para vincular clientes sincronizados.");

    const sellersByErpCode = new Map(
      (await prisma.user.findMany({ where: { erpCode: { not: null }, isActive: true }, select: { id: true, erpCode: true } }))
        .map((seller) => [seller.erpCode?.trim(), seller.id] as const)
        .filter(([code]) => Boolean(code))
    );

    let syncedCount = 0;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const payload = row as Record<string, unknown>;
      const code = pickFirstString(payload, ["code", "erpCode", "codigo", "CODIGO", "partnerCode"]);
      if (!code) continue;
      const sellerCode = pickFirstString(payload, ["sellerCode", "salesmanCode", "codVendedor", "CODVENDEDOR", "vendedorCodigo", "VENDEDOR"]);
      const ownerSellerId = sellersByErpCode.get(sellerCode) || fallbackSeller.id;
      const cnpj = pickFirstString(payload, ["cpfCnpj", "cnpj", "cpf", "document", "documentNumber", "CNPJCPF"]);
      const state = pickFirstString(payload, ["state", "uf", "UF", "estado"]);
      const existing = await prisma.client.findFirst({ where: { code } });
      const data = {
        code,
        name: pickFirstString(payload, ["corporateName", "name", "razaoSocial", "nome", "NOME"]) || "Cliente sem nome",
        fantasyName: pickFirstString(payload, ["fantasyName", "nomeFantasia", "apelido"]) || null,
        cnpj: cnpj || null,
        cnpjNormalized: cnpj ? normalizeCnpj(cnpj) : null,
        city: pickFirstString(payload, ["city", "cidade", "CIDADE"]) || "Não informado",
        state: normalizeState(state || "NI"),
        region: pickFirstString(payload, ["region", "regiao"]) || "Não informado",
        ownerSellerId,
        erpUpdatedAt: new Date()
      };
      if (existing) await prisma.client.update({ where: { id: existing.id }, data });
      else await prisma.client.create({ data });
      syncedCount += 1;
    }
    const diagnostics = { received: rows.length, withoutCode: rows.length - syncedCount };
    logApiEvent("INFO", "[ultrafv3 sync partners] processed partners payload", { correlationId, syncedCount, diagnostics });
    return { syncedCount, diagnostics };
  }, options);
}
async function syncReferenceData(scope: Exclude<UltraFv3SyncScope, "connection" | "products" | "partners" | "orderStatus">, endpoint: string, options?: RunSyncOptions) {
  return runSync(scope, async (correlationId) => {
    const rows = await fetchUltraFv3Rows(endpoint, scope, correlationId);
    await prisma.appConfig.upsert({
      where: { key: `erp.ultrafv3.${scope}` },
      update: { value: JSON.stringify(rows) },
      create: { key: `erp.ultrafv3.${scope}`, value: JSON.stringify(rows) }
    });
    return { syncedCount: rows.length };
  }, options);
}

export const syncPriceTables = (options?: RunSyncOptions) => syncReferenceData("priceTables", "/price-tables", options);
export const syncPaymentMethods = (options?: RunSyncOptions) => syncReferenceData("paymentMethods", "/payment-methods", options);
export const syncReceivingConditions = (options?: RunSyncOptions) => syncReferenceData("receivingConditions", "/receiving-conditions", options);
export const syncBranches = (options?: RunSyncOptions) => syncReferenceData("branches", "/branches", options);
export const syncOperations = (options?: RunSyncOptions) => syncReferenceData("operations", "/operations", options);
export const syncSalesmen = (options?: RunSyncOptions) => syncReferenceData("salesmen", "/salesmen", options);

const getLatestSyncError = (statuses: Record<UltraFv3SyncScope, SyncStatusPayload>) => {
  return Object.values(statuses)
    .filter((status) => status.errors?.[0])
    .sort((a, b) => new Date(b.lastSyncAt || 0).getTime() - new Date(a.lastSyncAt || 0).getTime())[0]?.errors?.[0] ?? null;
};

export function getUltraFv3IntegrationDiagnostics(statuses: Record<UltraFv3SyncScope, SyncStatusPayload>): UltraFv3IntegrationDiagnostics {
  const clientDiagnostics = ultraFv3Client.getDiagnostics();
  const lastError = clientDiagnostics.lastError || getLatestSyncError(statuses);
  const hasAuthError = lastError ? /autentica|usuário|usuario|senha|401|403/i.test(lastError) : false;
  const authenticationStatus = clientDiagnostics.authenticationStatus === "missing_config"
    ? "missing_config"
    : hasAuthError
      ? "auth_failed"
      : clientDiagnostics.authenticationStatus;

  let guidance = "Configuração mínima presente. Use o card Conexão UltraFV3 para validar autenticação e disponibilidade antes das sincronizações.";
  if (clientDiagnostics.missingConfig.length > 0) {
    guidance = `Configure ${clientDiagnostics.missingConfig.join(", ")} no .env do backend/API e reinicie o serviço antes de sincronizar.`;
  } else if (authenticationStatus === "auth_failed") {
    guidance = "Revise ULTRAFV3_USERNAME e ULTRAFV3_PASSWORD no backend/API e valide se o usuário tem permissão na API UltraFV3.";
  } else if (lastError) {
    guidance = "Corrija o último erro informado e execute novamente o card Conexão UltraFV3.";
  } else if (authenticationStatus === "authenticated") {
    guidance = "Autenticação UltraFV3 ativa em memória. As sincronizações podem ser executadas conforme necessário.";
  }

  return {
    ...clientDiagnostics,
    authenticationStatus,
    lastError,
    guidance,
  };
}

export async function getUltraFv3SyncStatus() {
  const config = await prisma.appConfig.findUnique({ where: { key: ERP_SYNC_STATUS_KEY }, select: { value: true } });
  const parsed = config?.value ? JSON.parse(config.value) : {};
  const scopes: UltraFv3SyncScope[] = ["connection", "products", "partners", "orderStatus", "salesmen", "paymentMethods", "receivingConditions", "priceTables", "branches", "operations"];
  return scopes.reduce<Record<UltraFv3SyncScope, SyncStatusPayload>>((acc, scope) => {
    acc[scope] = parsed[scope] ?? { scope, status: "idle", syncedCount: 0 };
    return acc;
  }, {} as Record<UltraFv3SyncScope, SyncStatusPayload>);
}


export async function syncOrderStatus(runner: () => Promise<SyncResult>, options?: RunSyncOptions) {
  return runSync("orderStatus", async () => runner(), options);
}

export async function getUltraFv3SyncHistory(limit = 20) {
  return prisma.erpSyncRun.findMany({
    orderBy: [{ startedAt: "desc" }],
    take: Math.min(Math.max(limit, 1), 100),
  });
}
