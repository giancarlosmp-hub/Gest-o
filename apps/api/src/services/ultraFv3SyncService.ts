import { Prisma, ErpSyncRunStatus, ErpSyncTrigger } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../config/prisma.js";
import {
  isUltraFv3TimeoutError,
  ULTRAFV3_REQUEST_TIMEOUT_MS,
  ultraFv3Client,
  type UltraFv3Credentials,
} from "./ultraFv3Client.js";
import { decryptErpCredential } from "./erpCredentialCrypto.js";
import { logApiEvent } from "../utils/logger.js";
import { getErpRuntimeEnvironmentDiagnostics, getMissingErpRuntimeConfig, type ErpRuntimeEnvironmentDiagnostics } from "./erpRuntimeConfig.js";
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
  | "priceVariations"
  | "prices"
  | "branches"
  | "operations"
  | "orderStatus";

type SyncStatusPayload = {
  scope: UltraFv3SyncScope;
  status: "idle" | "running" | "success" | "error" | "skipped";
  sellerId?: string | null;
  sellerName?: string | null;
  authMode?: "global" | "seller" | "seller_reference";
  lastSyncAt?: string;
  syncedCount?: number;
  errors?: string[];
  correlationId?: string;
  durationMs?: number;
  diagnostics?: Record<string, number>;
  trigger?: ErpSyncTrigger;
  runId?: string;
};

export type SyncResult = {
  syncedCount: number;
  diagnostics?: Record<string, number>;
};
export type RunSyncOptions = {
  trigger?: ErpSyncTrigger;
  failIfLocked?: boolean;
  lockScope?: string;
  sellerId?: string;
  sellerName?: string;
  authMode?: "global" | "seller" | "seller_reference";
  writeStatus?: boolean;
  correlationId?: string;
};
type LockAcquireResult =
  | { acquired: true; runId: string }
  | { acquired: false; runId: string; lockedUntil: Date | null };

type UltraFv3IntegrationDiagnostics = {
  baseUrl: string | null;
  isConfigured: boolean;
  missingConfig: string[];
  authenticationStatus:
    | "missing_config"
    | "authenticated"
    | "not_authenticated"
    | "auth_failed";
  lastError: string | null;
  lastLoginAt?: string | null;
  tokenExpiresAt?: string | null;
  tokenExpired?: boolean;
  environment: ErpRuntimeEnvironmentDiagnostics;
  guidance: string;
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

const pickFirstNumber = (payload: Record<string, unknown>, keys: string[]) => {
  const value = pickFirstValue(payload, keys);
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parsePositivePrice = (value: unknown) => {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

type ExtractedProductPrice = {
  priceTableCode: string | null;
  branchCode: string | null;
  price: number;
};

const extractProductPrices = (
  payload: Record<string, unknown>,
  defaultPrice: number,
  defaultTableCode: string,
  branchCode: string,
): ExtractedProductPrice[] => {
  const prices = new Map<string, ExtractedProductPrice>();
  const addPrice = (
    priceTableCode: unknown,
    priceValue: unknown,
    priceBranchCode: unknown = branchCode,
  ) => {
    const price = parsePositivePrice(priceValue);
    if (!price) return;
    const tableCode =
      pickFirstValue({ value: priceTableCode }, ["value"]) === null
        ? null
        : String(priceTableCode).trim() || null;
    const resolvedBranchCode =
      pickFirstValue({ value: priceBranchCode }, ["value"]) === null
        ? null
        : String(priceBranchCode).trim() || null;
    prices.set(`${tableCode || "default"}:${resolvedBranchCode || "default"}`, {
      priceTableCode: tableCode,
      branchCode: resolvedBranchCode,
      price,
    });
  };

  addPrice(defaultTableCode || "1", defaultPrice, branchCode);

  const directTableFields: Array<[string, string[]]> = [
    [
      "1",
      [
        "PRECO_TABELA_1",
        "PRECO_TABELA1",
        "PRECO_TAB_1",
        "PRECO_TAB1",
        "TABELA_1_PRECO",
        "TABELA1_PRECO",
        "PRECO_REVENDA",
        "PRECO_COOPERATIVA",
      ],
    ],
    [
      "2",
      [
        "PRECO_TABELA_2",
        "PRECO_TABELA2",
        "PRECO_TAB_2",
        "PRECO_TAB2",
        "TABELA_2_PRECO",
        "TABELA2_PRECO",
        "PRECO_CONSUMIDOR_FINAL",
        "PRECO_CONSUMIDOR",
        "PRECO2",
      ],
    ],
  ];
  for (const [tableCode, keys] of directTableFields) {
    for (const key of keys) addPrice(tableCode, payload[key], branchCode);
  }

  for (const value of Object.values(payload)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const tableCode = pickFirstString(record, [
        "TABELA_PRECO",
        "CODTABELA",
        "COD_TABELA",
        "ID_TABELA",
        "priceTableCode",
        "tabelaPreco",
        "tabela",
        "code",
      ]);
      const nestedBranchCode = pickFirstString(record, [
        "branchCode",
        "filial",
        "CODFILIAL",
      ]);
      addPrice(
        tableCode || defaultTableCode || "1",
        pickFirstValue(record, [
          "PRECO",
          "PRECO_LISTA",
          "price",
          "preco",
          "valor",
        ]),
        nestedBranchCode || branchCode,
      );
    }
  }

  const table2Variation = parsePositivePrice(
    pickFirstValue(payload, [
      "PERC_ACRESCIMO_TABELA_2",
      "PERCENTUAL_TABELA_2",
      "VARIACAO_TABELA_2",
      "VARIACAO_PRECO_TABELA_2",
      "ACRESCIMO_TABELA_2",
    ]),
  );
  if (
    table2Variation &&
    defaultPrice > 0 &&
    !prices.has(`2:${branchCode || "default"}`)
  ) {
    const multiplier =
      table2Variation > 1 ? 1 + table2Variation / 100 : table2Variation;
    addPrice("2", Number((defaultPrice * multiplier).toFixed(2)), branchCode);
  }

  return [...prices.values()];
};

const pickPartnerCode = (payload: Record<string, unknown>) =>
  pickFirstString(payload, [
    "PARCEIRO",
    "CODPARCEIRO",
    "CODCLIENTE",
    "code",
    "erpCode",
    "codigo",
    "CODIGO",
    "partnerCode",
  ]);

const PARTNERS_CONFIG_KEY = "erp.ultrafv3.partners";

const normalizePartnerCacheCode = (value: string) =>
  value.trim().replace(/^0+(?=\d)/, "") || value.trim();

const getPartnerCacheKey = (row: unknown) =>
  row && typeof row === "object"
    ? normalizePartnerCacheCode(pickPartnerCode(row as Record<string, unknown>))
    : "";

const parseCachedRows = (value?: string | null) => {
  if (!value) return [];
  try {
    return toArray(JSON.parse(value));
  } catch {
    return [];
  }
};

const cachePartnerRows = async (rows: unknown[]) => {
  const stored = await prisma.appConfig.findUnique({
    where: { key: PARTNERS_CONFIG_KEY },
    select: { value: true },
  });
  const merged = new Map<string, unknown>();
  for (const row of parseCachedRows(stored?.value)) {
    const key = getPartnerCacheKey(row);
    if (key) merged.set(key, row);
  }
  for (const row of rows) {
    const key = getPartnerCacheKey(row);
    if (key) merged.set(key, row);
  }
  await prisma.appConfig.upsert({
    where: { key: PARTNERS_CONFIG_KEY },
    update: { value: JSON.stringify([...merged.values()]) },
    create: {
      key: PARTNERS_CONFIG_KEY,
      value: JSON.stringify([...merged.values()]),
    },
  });
};

const pickPartnerDocument = (payload: Record<string, unknown>) =>
  pickFirstString(payload, [
    "CNPJ",
    "CPF",
    "CGC",
    "DOCUMENTO",
    "CPFCNPJ",
    "CPF_CNPJ",
    "CNPJ_CPF",
    "NR_CNPJ_CPF",
    "cpfCnpj",
    "cnpj",
    "cpf",
    "document",
    "documentNumber",
    "CNPJCPF",
  ]);

const partnerCityKeys = [
  "CIDADE",
  "DSC_CIDADE",
  "NOME_CIDADE",
  "MUNICIPIO",
  "CIDADE_PARCEIRO",
  "CID_CIDADE",
  "cidade",
  "city",
  "municipio",
];
const partnerStateKeys = [
  "UF",
  "ESTADO",
  "SIGLA_UF",
  "UF_PARCEIRO",
  "estado",
  "state",
  "uf",
];

const pickPartnerCity = (payload: Record<string, unknown>) =>
  pickFirstString(payload, partnerCityKeys);
const pickPartnerState = (payload: Record<string, unknown>) =>
  pickFirstString(payload, partnerStateKeys);

const pickPartnerAddress = (payload: Record<string, unknown>) => {
  const street = pickFirstString(payload, [
    "ENDERECO",
    "LOGRADOURO",
    "RUA",
    "ADDRESS",
    "address",
    "logradouro",
  ]);
  const number = pickFirstString(payload, [
    "NUMERO",
    "NRO",
    "NUMBER",
    "addressNumber",
    "numero",
  ]);
  const district = pickFirstString(payload, ["BAIRRO", "DISTRICT", "bairro"]);
  const complement = pickFirstString(payload, [
    "COMPLEMENTO",
    "COMPLEMENT",
    "complemento",
  ]);
  return [street, number, district, complement].filter(Boolean).join(", ");
};

const nonEmptyOrUndefined = (value: string) =>
  value.trim() ? value.trim() : undefined;

const normalizeDocument = (value?: string | null) => normalizeCnpj(value);
const resolveClientTypeFromDocument = (normalizedDocument?: string | null) => {
  if (!normalizedDocument) return undefined;
  if (normalizedDocument.length === 11) return "PF" as const;
  if (normalizedDocument.length === 14) return "PJ" as const;
  return undefined;
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

const sanitizePayloadForLog = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) return value;
  if (depth > 3) return "[max-depth]";
  if (Array.isArray(value))
    return value
      .slice(0, 3)
      .map((item) => sanitizePayloadForLog(item, depth + 1));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record)
      .slice(0, 15)
      .map(([key, raw]) => {
        const lower = key.toLowerCase();
        if (/(token|password|authorization|senha)/i.test(lower))
          return [key, "***"] as const;
        if (/(cnpj|cpf|cgc)/i.test(lower) && typeof raw === "string") {
          const digits = raw.replace(/\D/g, "");
          const masked =
            digits.length > 4
              ? `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`
              : "***";
          return [key, masked] as const;
        }
        return [key, sanitizePayloadForLog(raw, depth + 1)] as const;
      });
    return Object.fromEntries(entries);
  }
  if (typeof value === "string")
    return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  return value;
};

const getCandidateCounts = (body: unknown) => {
  if (!body || typeof body !== "object")
    return { data: 0, items: 0, partners: 0, result: 0, records: 0 };
  const record = body as Record<string, unknown>;
  const count = (key: string) =>
    Array.isArray(record[key]) ? (record[key] as unknown[]).length : 0;
  return {
    data: count("data"),
    items: count("items"),
    partners: count("partners"),
    result: count("result"),
    records: count("records"),
  };
};

const describeBodyType = (payload: unknown) => {
  if (Array.isArray(payload)) return "array";
  if (payload === null) return "null";
  return typeof payload;
};

const extractSampleFields = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return [] as string[];
  const keys = Object.keys(payload as Record<string, unknown>).slice(0, 3);
  return keys.map(
    (key) => `${key}:${typeof (payload as Record<string, unknown>)[key]}`,
  );
};
const formatError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestReadOnlyWithRetry<T>(
  endpoint: string,
  correlationId: string,
  requester: () => Promise<T>,
  attempts = ERP_SYNC_READ_RETRY_ATTEMPTS,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requester();
    } catch (error) {
      lastError = error;
      if (isUltraFv3TimeoutError(error) || attempt >= attempts) break;
      const delayMs = ERP_SYNC_READ_RETRY_BASE_DELAY_MS * attempt;
      logApiEvent("WARN", "[ultrafv3 sync] retrying read-only ERP request", {
        endpoint,
        correlationId,
        attempt,
        attempts,
        delayMs,
        error: formatError(error),
      });
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(formatError(lastError));
}

export async function requestUltraFv3ReadOnlyWithRetry<T>(
  endpoint: string,
  correlationId: string,
  attempts = ERP_SYNC_READ_RETRY_ATTEMPTS,
  timeoutMs = ULTRAFV3_REQUEST_TIMEOUT_MS,
) {
  return requestReadOnlyWithRetry<T>(
    endpoint,
    correlationId,
    () => ultraFv3Client.request<T>(endpoint, { correlationId, timeoutMs }),
    attempts,
  );
}

export async function requestUltraFv3ReadOnlyWithCredentialsRetry<T>(
  endpoint: string,
  credentials: UltraFv3Credentials,
  correlationId: string,
  attempts = ERP_SYNC_READ_RETRY_ATTEMPTS,
  timeoutMs = ULTRAFV3_REQUEST_TIMEOUT_MS,
) {
  return requestReadOnlyWithRetry<T>(
    endpoint,
    correlationId,
    () =>
      ultraFv3Client.requestWithCredentials<T>(endpoint, credentials, {
        correlationId,
        timeoutMs,
      }),
    attempts,
  );
}

async function fetchUltraFv3Rows(
  endpoint: string,
  scope: UltraFv3SyncScope,
  correlationId: string,
  credentials?: UltraFv3Credentials,
) {
  const response = credentials
    ? await requestUltraFv3ReadOnlyWithCredentialsRetry<unknown>(
        endpoint,
        credentials,
        correlationId,
      )
    : await requestUltraFv3ReadOnlyWithRetry<unknown>(endpoint, correlationId);
  const rows = toArray(response);
  if (!rows.length) {
    throw new Error(`Retorno vazio do UltraFV3 para ${scope} (${endpoint}).`);
  }
  return rows;
}

async function fetchUltraFv3RowsWithAlias(
  endpoint: string,
  scope: Exclude<
    UltraFv3SyncScope,
    "connection" | "products" | "partners" | "orderStatus"
  >,
  correlationId: string,
  credentials: UltraFv3Credentials | undefined,
  aliases: string[] = [],
) {
  const candidates = [
    endpoint,
    ...aliases.filter((item) => item && item !== endpoint),
  ];
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const rows = await fetchUltraFv3Rows(
        candidate,
        scope,
        correlationId,
        credentials,
      );
      return {
        rows,
        endpointUsed: candidate,
        aliasFallbackUsed: index > 0 ? 1 : 0,
      };
    } catch (error) {
      lastError = error;
      const message = formatError(error);
      const canTryAlias =
        index < candidates.length - 1 &&
        /404|inexistente|not found/i.test(message);
      if (!canTryAlias) throw error;
      logApiEvent(
        "WARN",
        "[ultrafv3 sync] endpoint unavailable; trying alias",
        {
          scope,
          correlationId,
          endpoint: candidate,
          nextEndpoint: candidates[index + 1],
          error: message,
        },
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(formatError(lastError));
}

async function resolveReferenceCredentials() {
  if (ultraFv3Client.hasGlobalCredentials())
    return {
      credentials: undefined,
      authMode: "global" as const,
      sellerId: null,
      sellerName: null,
    };
  const seller = await prisma.user.findFirst({
    where: {
      role: "vendedor",
      isActive: true,
      erpLoginUsername: { not: null },
      erpLoginPasswordEncrypted: { not: null },
    },
    select: {
      id: true,
      name: true,
      erpCode: true,
      erpLoginUsername: true,
      erpLoginPasswordEncrypted: true,
    },
    orderBy: [{ name: "asc" }],
  });
  if (!seller)
    throw new Error(
      "Credencial global ausente e nenhum vendedor ativo com Login FV3/Senha FV3 configurados.",
    );
  return {
    credentials: getConfiguredSellerCredentials(seller),
    authMode: "seller_reference" as const,
    sellerId: seller.id,
    sellerName: seller.name,
  };
}

async function writeSyncStatus(payload: SyncStatusPayload) {
  const current = await prisma.appConfig.findUnique({
    where: { key: ERP_SYNC_STATUS_KEY },
    select: { value: true },
  });
  const parsed = current?.value ? JSON.parse(current.value) : {};
  parsed[payload.scope] = payload;
  await prisma.appConfig.upsert({
    where: { key: ERP_SYNC_STATUS_KEY },
    update: { value: JSON.stringify(parsed) },
    create: { key: ERP_SYNC_STATUS_KEY, value: JSON.stringify(parsed) },
  });
}

async function acquireSyncLock(
  scope: string,
  runId: string,
): Promise<LockAcquireResult> {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ERP_SYNC_LOCK_TTL_MS);
  try {
    await prisma.erpSyncLock.create({ data: { scope, runId, lockedUntil } });
    return { acquired: true, runId };
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    )
      throw error;
  }

  const updated = await prisma.erpSyncLock.updateMany({
    where: {
      scope,
      OR: [{ lockedUntil: { lt: now } }, { runId }],
    },
    data: { runId, lockedUntil, updatedAt: now },
  });
  if (updated.count > 0) return { acquired: true, runId };

  const current = await prisma.erpSyncLock.findUnique({
    where: { scope },
    select: { runId: true, lockedUntil: true },
  });
  return {
    acquired: false,
    runId: current?.runId ?? runId,
    lockedUntil: current?.lockedUntil ?? null,
  };
}

async function releaseSyncLock(scope: string, runId: string) {
  await prisma.erpSyncLock.deleteMany({ where: { scope, runId } });
}

async function runSync(
  scope: UltraFv3SyncScope,
  runner: (correlationId: string) => Promise<SyncResult>,
  options: RunSyncOptions = {},
) {
  const correlationId = options.correlationId ?? randomUUID();
  const startedAt = Date.now();
  const startedAtDate = new Date();
  const trigger = options.trigger ?? ErpSyncTrigger.manual;
  const lockScope = options.lockScope ?? scope;
  const authMode = options.authMode ?? "global";
  const syncContext = {
    sellerId: options.sellerId ?? null,
    sellerName: options.sellerName ?? null,
    authMode,
  };
  const shouldWriteStatus = options.writeStatus ?? !options.sellerId;
  const lock = await acquireSyncLock(lockScope, correlationId);

  if (!lock.acquired) {
    const message = `Sincronização ${scope} já está em execução até ${lock.lockedUntil?.toISOString() ?? "instante desconhecido"}.`;
    await prisma.erpSyncRun.create({
      data: {
        scope,
        trigger,
        status: ErpSyncRunStatus.skipped,
        ...syncContext,
        correlationId,
        startedAt: startedAtDate,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        syncedCount: 0,
        metrics: {
          skippedByLock: 1,
          lockedRunId: lock.runId,
        } as Prisma.InputJsonValue,
        errorMessage: message,
      },
    });
    if (shouldWriteStatus)
      await writeSyncStatus({
        scope,
        status: "running",
        lastSyncAt: startedAtDate.toISOString(),
        syncedCount: 0,
        correlationId: lock.runId,
        trigger,
        ...syncContext,
      });
    logApiEvent(
      "WARN",
      `[ultrafv3 sync] ${scope} skipped because lock is active`,
      {
        scope,
        correlationId,
        lockedRunId: lock.runId,
        lockedUntil: lock.lockedUntil?.toISOString(),
      },
    );
    if (options.failIfLocked ?? true)
      throw Object.assign(new Error(message), { status: 409 });
    return { syncedCount: 0, diagnostics: { skippedByLock: 1 } };
  }

  const run = await prisma.erpSyncRun.create({
    data: {
      scope,
      trigger,
      status: ErpSyncRunStatus.running,
      correlationId,
      startedAt: startedAtDate,
      ...syncContext,
    },
  });
  if (shouldWriteStatus)
    await writeSyncStatus({
      scope,
      status: "running",
      lastSyncAt: startedAtDate.toISOString(),
      syncedCount: 0,
      correlationId,
      trigger,
      runId: run.id,
      ...syncContext,
    });
  logApiEvent("INFO", `[ultrafv3 sync] ${scope} started`, {
    scope,
    correlationId,
    trigger,
    runId: run.id,
  });

  try {
    const result = await runner(correlationId);
    const durationMs = Date.now() - startedAt;
    const finishedAt = new Date();
    await prisma.erpSyncRun.update({
      where: { id: run.id },
      data: {
        status: ErpSyncRunStatus.success,
        finishedAt,
        durationMs,
        syncedCount: result.syncedCount,
        metrics: (result.diagnostics ?? {}) as Prisma.InputJsonValue,
      },
    });
    if (shouldWriteStatus)
      await writeSyncStatus({
        scope,
        status: "success",
        lastSyncAt: finishedAt.toISOString(),
        correlationId,
        durationMs,
        trigger,
        runId: run.id,
        ...result,
        ...syncContext,
      });
    logApiEvent("INFO", `[ultrafv3 sync] ${scope} finished`, {
      scope,
      correlationId,
      durationMs,
      trigger,
      runId: run.id,
      ...result,
    });
    return result;
  } catch (error) {
    const message = formatError(error);
    const durationMs = Date.now() - startedAt;
    const finishedAt = new Date();
    await prisma.erpSyncRun.update({
      where: { id: run.id },
      data: {
        status: ErpSyncRunStatus.error,
        finishedAt,
        durationMs,
        syncedCount: 0,
        errorMessage: message,
        errors: [
          { message, at: finishedAt.toISOString(), correlationId },
        ] as Prisma.InputJsonValue,
      },
    });
    if (shouldWriteStatus)
      await writeSyncStatus({
        scope,
        status: "error",
        lastSyncAt: finishedAt.toISOString(),
        syncedCount: 0,
        errors: [message],
        correlationId,
        durationMs,
        trigger,
        runId: run.id,
        ...syncContext,
      });
    logApiEvent("ERROR", `[ultrafv3 sync] ${scope} failed`, {
      scope,
      correlationId,
      durationMs,
      trigger,
      runId: run.id,
      error: message,
      operationalAlert: true,
    });
    throw error;
  } finally {
    await releaseSyncLock(lockScope, correlationId).catch((error) =>
      logApiEvent("ERROR", "[ultrafv3 sync] failed to release lock", {
        scope,
        lockScope,
        correlationId,
        error: formatError(error),
      }),
    );
  }
}

export async function syncConnection(options?: RunSyncOptions) {
  const resolved = await resolveReferenceCredentials();
  return runSync(
    "connection",
    async (correlationId) => {
      const probeEndpoint = "/operations";
      if (resolved.credentials)
        await requestUltraFv3ReadOnlyWithCredentialsRetry<unknown>(
          probeEndpoint,
          resolved.credentials,
          correlationId,
        );
      else
        await requestUltraFv3ReadOnlyWithRetry<unknown>(
          probeEndpoint,
          correlationId,
        );
      return { syncedCount: 1 };
    },
    {
      ...options,
      authMode: resolved.authMode,
      sellerId: resolved.sellerId ?? undefined,
      sellerName: resolved.sellerName ?? undefined,
    },
  );
}

export async function syncProducts(options?: RunSyncOptions) {
  const resolved = await resolveReferenceCredentials();
  return runSync(
    "products",
    async (correlationId) => {
      const rows = await fetchUltraFv3Rows(
        "/products",
        "products",
        correlationId,
        resolved.credentials,
      );
      const diagnostics = {
        received: rows.length,
        validAfterNormalization: 0,
        discardedAfterNormalization: 0,
        invalidInactive: 0,
        invalidSuspended: 0,
        invalidMissingCode: 0,
        invalidMissingUnit: 0,
        invalidWithoutPrice: 0,
        withoutStock: 0,
      };
      let syncedCount = 0;

      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const payload = row as Record<string, unknown>;
        const code = pickFirstString(payload, [
          "CODPRODUTO",
          "code",
          "erpProductCode",
          "codigo",
          "CODIGO",
          "produtoCodigo",
        ]);
        const classCode = pickFirstString(payload, [
          "CODPRODUTO_CLAS",
          "classification",
          "erpProductClassCode",
          "classCode",
          "classe",
          "CLASSIFICACAO",
        ]);
        const unit = pickFirstString(payload, [
          "UND_MEDIDA",
          "unit",
          "unidade",
          "UNIDADE",
          "unitCode",
          "un",
        ]);
        const price = pickFirstNumber(payload, [
          "PRECO",
          "price",
          "defaultPrice",
          "minPrice",
          "preco",
          "salePrice",
          "valor",
        ]);
        const stockQuantity = pickFirstValue(payload, [
          "QTD_ESTOQUE",
          "stockQuantity",
          "stock",
          "estoque",
          "ESTOQUE",
          "availableStock",
        ]);
        const status = pickFirstString(payload, [
          "status",
          "situacao",
          "SITUACAO",
        ]).toLowerCase();
        const activeFlag = pickFirstValue(payload, [
          "isActive",
          "active",
          "ativo",
          "ATIVO",
        ]);
        const suspendedFlag = pickFirstValue(payload, [
          "isSuspended",
          "suspended",
          "suspenso",
          "SUSPENSO",
        ]);
        const activeFlagNormalized = String(activeFlag).trim().toLowerCase();
        const suspendedFlagNormalized = String(suspendedFlag)
          .trim()
          .toLowerCase();
        const isActive =
          activeFlag === null
            ? !["inactive", "inativo", "suspended", "suspenso"].includes(status)
            : activeFlag !== false &&
              !["false", "0", "n", "nao", "não", "inativo"].includes(
                activeFlagNormalized,
              );
        const suspendedByUltra =
          String(pickFirstValue(payload, ["SUSPENDER_PEDIDOS"]) ?? "")
            .trim()
            .toUpperCase() === "S";
        const outOfLineByUltra =
          String(pickFirstValue(payload, ["IDN_FORA_LINHA"]) ?? "")
            .trim()
            .toUpperCase() === "S";
        const isSuspended =
          suspendedFlag === true ||
          ["true", "1", "s", "sim", "suspenso"].includes(
            suspendedFlagNormalized,
          ) ||
          ["suspended", "suspenso"].includes(status) ||
          suspendedByUltra ||
          outOfLineByUltra;

        if (!code) {
          diagnostics.invalidMissingCode += 1;
          continue;
        }
        if (!unit) {
          diagnostics.invalidMissingUnit += 1;
          continue;
        }
        if (!isActive) diagnostics.invalidInactive += 1;
        if (isSuspended) diagnostics.invalidSuspended += 1;
        if (!Number.isFinite(price) || price <= 0)
          diagnostics.invalidWithoutPrice += 1;

        diagnostics.validAfterNormalization += 1;
        const stockNumber =
          stockQuantity === null ? null : Number(stockQuantity);
        const normalizedPrice = Number.isFinite(price) && price > 0 ? price : 0;
        if (
          stockNumber !== null &&
          Number.isFinite(stockNumber) &&
          stockNumber <= 0
        )
          diagnostics.withoutStock += 1;

        const product = await prisma.product.upsert({
          where: {
            erpProductCode_erpProductClassCode: {
              erpProductCode: code,
              erpProductClassCode: classCode || "default",
            },
          },
          update: {
            name:
              pickFirstString(payload, [
                "DSCPRODUTO",
                "description",
                "name",
                "descricao",
                "NOME",
              ]) || "Produto sem descrição",
            className:
              pickFirstString(payload, [
                "DSCPRODUTO_CLAS",
                "DESCRICAO_CLASSE",
                "DSC_CLASSIFICACAO",
                "classificationName",
                "className",
                "nomeClassificacao",
              ]) || null,
            groupName:
              pickFirstString(payload, [
                "DSCGRUPO",
                "group",
                "groupName",
                "grupo",
              ]) || null,
            unit,
            brand:
              pickFirstString(payload, ["MARCA", "brand", "marca"]) || null,
            stockQuantity:
              stockNumber !== null && Number.isFinite(stockNumber)
                ? stockNumber
                : null,
            defaultPrice: normalizedPrice,
            minPrice:
              pickFirstNumber(payload, [
                "PRECO_MINIMO",
                "minPrice",
                "precoMinimo",
              ]) || normalizedPrice,
            isActive,
            isSuspended,
            rawErpPayload: payload as Prisma.InputJsonValue,
          },
          create: {
            erpProductCode: code,
            erpProductClassCode: classCode || "default",
            name:
              pickFirstString(payload, [
                "DSCPRODUTO",
                "description",
                "name",
                "descricao",
                "NOME",
              ]) || "Produto sem descrição",
            className:
              pickFirstString(payload, [
                "DSCPRODUTO_CLAS",
                "DESCRICAO_CLASSE",
                "DSC_CLASSIFICACAO",
                "classificationName",
                "className",
                "nomeClassificacao",
              ]) || null,
            groupName:
              pickFirstString(payload, [
                "DSCGRUPO",
                "group",
                "groupName",
                "grupo",
              ]) || null,
            unit,
            brand:
              pickFirstString(payload, ["MARCA", "brand", "marca"]) || null,
            stockQuantity:
              stockNumber !== null && Number.isFinite(stockNumber)
                ? stockNumber
                : null,
            defaultPrice: normalizedPrice,
            minPrice:
              pickFirstNumber(payload, [
                "PRECO_MINIMO",
                "minPrice",
                "precoMinimo",
              ]) || normalizedPrice,
            isActive,
            isSuspended,
            rawErpPayload: payload as Prisma.InputJsonValue,
          },
        });
        const priceTableCode = pickFirstString(payload, [
          "priceTable",
          "priceTableCode",
          "tabelaPreco",
          "TABELA_PRECO",
        ]);
        const branchCode = pickFirstString(payload, [
          "branchCode",
          "filial",
          "CODFILIAL",
        ]);
        for (const productPrice of extractProductPrices(
          payload,
          normalizedPrice,
          priceTableCode || "1",
          branchCode,
        )) {
          const existingPrice = await prisma.productPrice.findFirst({
            where: {
              productId: product.id,
              erpPriceId: productPrice.priceTableCode,
              branchCode: productPrice.branchCode,
            },
          });
          if (existingPrice) {
            await prisma.productPrice.update({
              where: { id: existingPrice.id },
              data: { price: productPrice.price },
            });
          } else {
            await prisma.productPrice.create({
              data: {
                productId: product.id,
                erpPriceId: productPrice.priceTableCode,
                branchCode: productPrice.branchCode,
                price: productPrice.price,
              },
            });
          }
        }
        syncedCount += 1;
      }

      diagnostics.discardedAfterNormalization = Math.max(
        diagnostics.received - diagnostics.validAfterNormalization,
        0,
      );
      logApiEvent(
        "INFO",
        "[ultrafv3 sync products] processed products payload",
        { correlationId, syncedCount, diagnostics },
      );
      logApiEvent(
        "INFO",
        "[ultrafv3 sync products] normalization diagnostics",
        {
          correlationId,
          received: diagnostics.received,
          validAfterNormalization: diagnostics.validAfterNormalization,
          discardedAfterNormalization: diagnostics.discardedAfterNormalization,
          sampleKeys:
            rows[0] && typeof rows[0] === "object"
              ? Object.keys(rows[0] as Record<string, unknown>).slice(0, 15)
              : [],
          sample: sanitizePayloadForLog(rows[0] ?? null),
        },
      );
      return { syncedCount, diagnostics };
    },
    {
      ...options,
      authMode: resolved.authMode,
      sellerId: resolved.sellerId ?? undefined,
      sellerName: resolved.sellerName ?? undefined,
    },
  );
}

type SellerSyncUser = {
  id: string;
  name: string;
  erpCode: string | null;
  erpLoginUsername: string | null;
  erpLoginPasswordEncrypted: string | null;
};

const getConfiguredSellerCredentials = (
  seller: SellerSyncUser,
): UltraFv3Credentials => {
  if (!seller.erpLoginUsername?.trim() || !seller.erpLoginPasswordEncrypted) {
    throw Object.assign(
      new Error("Vendedor sem Login FV3/Senha FV3 configurados."),
      { status: 400 },
    );
  }
  return {
    username: seller.erpLoginUsername.trim(),
    password: decryptErpCredential(seller.erpLoginPasswordEncrypted),
  };
};

async function persistPartnerRowsForSeller(
  rows: unknown[],
  seller: SellerSyncUser,
  correlationId: string,
) {
  const diagnostics = {
    received: rows.length,
    withoutCode: 0,
    discardedNonObject: 0,
    created: 0,
    updated: 0,
    preservedCommercialLinkWarnings: 0,
    receivedWithDocument: 0,
    receivedWithoutDocument: 0,
    updatedDocumentCount: 0,
  };
  const warnings: string[] = [];
  let syncedCount = 0;

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      diagnostics.discardedNonObject += 1;
      continue;
    }
    const payload = row as Record<string, unknown>;
    const code = pickPartnerCode(payload);
    if (!code) {
      diagnostics.withoutCode += 1;
      continue;
    }

    const cnpj = pickPartnerDocument(payload);
    const normalizedDocument = normalizeDocument(cnpj);
    if (cnpj) diagnostics.receivedWithDocument += 1;
    else diagnostics.receivedWithoutDocument += 1;
    const state = pickPartnerState(payload);
    const existing = await prisma.client.findFirst({
      where: {
        OR: [
          { code },
          ...(normalizedDocument
            ? [{ cnpjNormalized: normalizedDocument }]
            : []),
          ...(normalizedDocument && code
            ? [{ AND: [{ code }, { cnpjNormalized: normalizedDocument }] }]
            : []),
        ],
      },
      orderBy: [{ erpUpdatedAt: "desc" }, { createdAt: "asc" }],
      select: { id: true, ownerSellerId: true, city: true, state: true },
    });
    const mappedCity = pickPartnerCity(payload);
    const derivedClientType = resolveClientTypeFromDocument(normalizedDocument);
    const data = {
      code,
      name:
        pickFirstString(payload, [
          "RAZAO_SOCIAL",
          "NOME",
          "name",
          "corporateName",
          "razaoSocial",
          "nome",
        ]) || "Cliente sem nome",
      fantasyName:
        pickFirstString(payload, [
          "FANTASIA",
          "fantasyName",
          "nomeFantasia",
          "apelido",
        ]) || null,
      cnpj: cnpj || undefined,
      cnpjNormalized: normalizedDocument || undefined,
      city: mappedCity || "Não informado",
      state: normalizeState(state || "NI"),
      region: pickFirstString(payload, ["region", "regiao"]) || "Não informado",
      clientType: derivedClientType,
      erpUpdatedAt: new Date(),
    };

    if (existing) {
      const shouldPreserveCommercialLink = existing.ownerSellerId !== seller.id;
      if (normalizedDocument) diagnostics.updatedDocumentCount += 1;
      await prisma.client.update({
        where: { id: existing.id },
        data: shouldPreserveCommercialLink
          ? {
              ...data,
              cnpj: cnpj ? cnpj : undefined,
              cnpjNormalized: normalizedDocument
                ? normalizedDocument
                : undefined,
              city: mappedCity ? data.city : existing.city || data.city,
              state: state ? data.state : existing.state || data.state,
            }
          : {
              ...data,
              ownerSellerId: seller.id,
              cnpj: cnpj ? cnpj : undefined,
              cnpjNormalized: normalizedDocument
                ? normalizedDocument
                : undefined,
              city: mappedCity ? data.city : existing.city || data.city,
              state: state ? data.state : existing.state || data.state,
            },
      });
      diagnostics.updated += 1;
      if (shouldPreserveCommercialLink) {
        diagnostics.preservedCommercialLinkWarnings += 1;
        warnings.push(
          `Cliente ERP ${code} já possui vínculo comercial com outro vendedor CRM; vínculo preservado por limitação de vendedor único por cliente.`,
        );
      }
    } else {
      await prisma.client.create({
        data: {
          ...data,
          cnpj: cnpj || null,
          cnpjNormalized: normalizedDocument || null,
          ownerSellerId: seller.id,
        },
      });
      diagnostics.created += 1;
    }
    syncedCount += 1;
  }

  if (warnings.length) {
    logApiEvent(
      "WARN",
      "[ultrafv3 sync partners] preserved existing commercial links",
      {
        correlationId,
        sellerId: seller.id,
        sellerName: seller.name,
        warningCount: warnings.length,
        limitation:
          "Client.ownerSellerId suporta apenas um vendedor; vínculos existentes não são sobrescritos em sync por vendedor.",
      },
    );
  }

  return { syncedCount, diagnostics, warnings };
}

export async function syncPartners(options?: RunSyncOptions) {
  const resolved = await resolveReferenceCredentials();
  return runSync(
    "partners",
    async (correlationId) => {
      const rows = await fetchUltraFv3Rows(
        "/partners",
        "partners",
        correlationId,
        resolved.credentials,
      );
      await cachePartnerRows(rows);
      const fallbackSeller = await prisma.user.findFirst({
        where: { role: "vendedor", isActive: true },
        select: { id: true },
      });
      if (!fallbackSeller)
        throw new Error(
          "Nenhum vendedor ativo encontrado para vincular clientes sincronizados.",
        );

      const sellersByErpCode = new Map(
        (
          await prisma.user.findMany({
            where: { erpCode: { not: null }, isActive: true },
            select: { id: true, erpCode: true },
          })
        )
          .map((seller) => [seller.erpCode?.trim(), seller.id] as const)
          .filter(([code]) => Boolean(code)),
      );

      const diagnostics = {
        received: rows.length,
        withoutCode: 0,
        fallbackSellerLinks: 0,
        updated: 0,
        created: 0,
        validAfterNormalization: 0,
        discardedAfterNormalization: 0,
        receivedWithDocument: 0,
        receivedWithoutDocument: 0,
        updatedDocumentCount: 0,
      };
      let syncedCount = 0;
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const payload = row as Record<string, unknown>;
        const code = pickPartnerCode(payload);
        if (!code) {
          diagnostics.withoutCode += 1;
          continue;
        }
        const sellerCode = pickFirstString(payload, [
          "VENDEDOR_DO_PARCEIRO",
          "CODVENDEDOR",
          "sellerCode",
          "salesmanCode",
          "codVendedor",
          "vendedorCodigo",
          "VENDEDOR",
        ]);
        const ownerSellerId =
          sellersByErpCode.get(sellerCode) || fallbackSeller.id;
        if (!sellersByErpCode.has(sellerCode))
          diagnostics.fallbackSellerLinks += 1;
        const cnpj = pickPartnerDocument(payload);
        const normalizedDocument = normalizeDocument(cnpj);
        const derivedClientType =
          resolveClientTypeFromDocument(normalizedDocument);
        const existing = await prisma.client.findFirst({
          where: {
            OR: [
              { code },
              ...(normalizedDocument
                ? [{ cnpjNormalized: normalizedDocument }]
                : []),
              ...(normalizedDocument && code
                ? [{ AND: [{ code }, { cnpjNormalized: normalizedDocument }] }]
                : []),
            ],
          },
          orderBy: [{ erpUpdatedAt: "desc" }, { createdAt: "asc" }],
          select: { id: true },
        });
        const mappedCity = pickPartnerCity(payload);
        const mappedState = pickPartnerState(payload);
        const mappedRegion = pickFirstString(payload, [
          "region",
          "regiao",
          "REGIAO",
          "região",
          "REGIÃO",
          "cidadeAtuacao",
          "CIDADE_ATUACAO",
        ]);
        const mappedAddress = pickPartnerAddress(payload);
        const mappedName = pickFirstString(payload, [
          "RAZAO_SOCIAL",
          "NOME",
          "corporateName",
          "name",
          "razaoSocial",
          "nome",
        ]);
        const mappedFantasyName = pickFirstString(payload, [
          "FANTASIA",
          "fantasyName",
          "nomeFantasia",
          "apelido",
        ]);
        const data = {
          code,
          name: mappedName || "Cliente sem nome",
          fantasyName: mappedFantasyName || null,
          cnpj: cnpj || undefined,
          cnpjNormalized: normalizedDocument || undefined,
          city: mappedCity || "Não informado",
          state: normalizeState(mappedState || "NI"),
          region: mappedRegion || "Não informado",
          clientType: derivedClientType,
          ownerSellerId,
          segment: nonEmptyOrUndefined(mappedAddress),
          erpUpdatedAt: new Date(),
        };
        if (existing) {
          const current = await prisma.client.findUnique({
            where: { id: existing.id },
            select: {
              cnpj: true,
              cnpjNormalized: true,
              city: true,
              state: true,
              region: true,
              segment: true,
              ownerSellerId: true,
            },
          });
          const safeData = {
            ...data,
            cnpj: cnpj ? cnpj : undefined,
            cnpjNormalized: normalizedDocument ? normalizedDocument : undefined,
            city: mappedCity ? data.city : current?.city || data.city,
            state: mappedState ? data.state : current?.state || data.state,
            region: mappedRegion ? data.region : current?.region || data.region,
            segment: mappedAddress
              ? mappedAddress
              : current?.segment || undefined,
          };
          await prisma.client.update({
            where: { id: existing.id },
            data: safeData,
          });
          diagnostics.updated += 1;
          if (normalizedDocument)
            diagnostics.updatedDocumentCount =
              (diagnostics.updatedDocumentCount || 0) + 1;
        } else {
          await prisma.client.create({
            data: {
              ...data,
              cnpj: cnpj || null,
              cnpjNormalized: normalizedDocument || null,
            },
          });
          diagnostics.created += 1;
        }
        if (normalizedDocument)
          diagnostics.receivedWithDocument =
            (diagnostics.receivedWithDocument || 0) + 1;
        else
          diagnostics.receivedWithoutDocument =
            (diagnostics.receivedWithoutDocument || 0) + 1;
        syncedCount += 1;
        diagnostics.validAfterNormalization += 1;
      }
      diagnostics.discardedAfterNormalization = Math.max(
        diagnostics.received - diagnostics.validAfterNormalization,
        0,
      );
      logApiEvent(
        "INFO",
        "[ultrafv3 sync partners] processed partners payload",
        {
          correlationId,
          syncedCount,
          diagnostics,
          authMode: resolved.authMode,
          sellerId: resolved.sellerId,
          sellerName: resolved.sellerName,
        },
      );
      logApiEvent(
        "INFO",
        "[ultrafv3 sync partners] normalization diagnostics",
        {
          correlationId,
          received: diagnostics.received,
          validAfterNormalization: diagnostics.validAfterNormalization,
          discardedAfterNormalization: diagnostics.discardedAfterNormalization,
          sampleKeys:
            rows[0] && typeof rows[0] === "object"
              ? Object.keys(rows[0] as Record<string, unknown>).slice(0, 15)
              : [],
          sample: sanitizePayloadForLog(rows[0] ?? null),
        },
      );
      const firstPayload = rows.find(
        (row) => row && typeof row === "object",
      ) as Record<string, unknown> | undefined;
      if (firstPayload) {
        const maskedDoc = (pickPartnerDocument(firstPayload) || "")
          .replace(/\D/g, "")
          .replace(/^(\d{0,3})\d+(\d{2})$/, "$1***$2");
        logApiEvent(
          "INFO",
          "[ultrafv3 sync partners] mapping diagnostics sample",
          {
            correlationId,
            rawKeys: Object.keys(firstPayload),
            mapped: sanitizePayloadForLog({
              code: pickPartnerCode(firstPayload),
              name: pickFirstString(firstPayload, [
                "RAZAO_SOCIAL",
                "NOME",
                "corporateName",
                "name",
                "razaoSocial",
                "nome",
              ]),
              fantasyName: pickFirstString(firstPayload, [
                "FANTASIA",
                "fantasyName",
                "nomeFantasia",
                "apelido",
              ]),
              cpfCnpjMasked: maskedDoc || null,
              city: pickPartnerCity(firstPayload),
              state: pickPartnerState(firstPayload),
              address: pickPartnerAddress(firstPayload),
              sellerCode: pickFirstString(firstPayload, [
                "VENDEDOR_DO_PARCEIRO",
                "CODVENDEDOR",
                "sellerCode",
                "salesmanCode",
                "codVendedor",
                "vendedorCodigo",
                "VENDEDOR",
              ]),
            }),
          },
        );
      }
      return { syncedCount, diagnostics };
    },
    {
      ...options,
      authMode: resolved.authMode,
      sellerId: resolved.sellerId ?? undefined,
      sellerName: resolved.sellerName ?? undefined,
    },
  );
}

export async function syncPartnersByUser(
  userId: string,
  options?: RunSyncOptions,
) {
  const seller = await prisma.user.findFirst({
    where: { id: userId, role: "vendedor", isActive: true },
    select: {
      id: true,
      name: true,
      erpCode: true,
      erpLoginUsername: true,
      erpLoginPasswordEncrypted: true,
    },
  });
  if (!seller)
    throw Object.assign(new Error("Vendedor ativo não encontrado."), {
      status: 404,
    });
  const credentials = getConfiguredSellerCredentials(seller);

  return runSync(
    "partners",
    async (correlationId) => {
      const response =
        await requestUltraFv3ReadOnlyWithCredentialsRetry<unknown>(
          "/partners",
          credentials,
          correlationId,
        );
      const rows = toArray(response);
      await cachePartnerRows(rows);
      const candidateCounts = getCandidateCounts(response);
      const rootKeys =
        response && typeof response === "object" && !Array.isArray(response)
          ? Object.keys(response as Record<string, unknown>).slice(0, 20)
          : [];
      const firstRowSamples = rows
        .slice(0, 3)
        .flatMap((item) => extractSampleFields(item))
        .slice(0, 9);
      const diagnosticsBase = {
        httpStatus: 200,
        responseBodyType: describeBodyType(response) === "object" ? 1 : 0,
        receivedRaw: rows.length,
        sampleFieldCount: firstRowSamples.length,
        normalizedCount: rows.length,
        discardedAfterNormalization: 0,
      };
      logApiEvent(
        "INFO",
        "[ultrafv3 sync partners] seller payload diagnostics",
        {
          correlationId,
          endpoint: "/partners",
          httpStatus: 200,
          bodyType: typeof response,
          isArrayBody: Array.isArray(response),
          rootKeys,
          foundCount: rows.length,
          candidatePaths: candidateCounts,
          sampleFirstItem: sanitizePayloadForLog(rows[0] ?? null),
          sellerId: seller.id,
          sellerName: seller.name,
          authMode: "seller",
          receivedRaw: rows.length,
          normalizedCount: rows.length,
          discardedAfterNormalization: 0,
        },
      );
      if (!rows.length) {
        logApiEvent("INFO", "UltraFV3 retornou payload vazio para /partners", {
          correlationId,
          sellerId: seller.id,
          sellerName: seller.name,
          authMode: "seller",
          bodyType: describeBodyType(response),
          sampleFields: firstRowSamples,
          ...diagnosticsBase,
        });
        return {
          syncedCount: 0,
          diagnostics: {
            ...diagnosticsBase,
            validAfterNormalization: 0,
            discardedAfterNormalization: 0,
          },
        };
      }
      const result = await persistPartnerRowsForSeller(
        rows,
        seller,
        correlationId,
      );
      const discardedAfterNormalization = Math.max(
        rows.length - result.syncedCount,
        0,
      );
      logApiEvent(
        "INFO",
        "[ultrafv3 sync partners] processed seller partners payload",
        {
          correlationId,
          sellerId: seller.id,
          sellerName: seller.name,
          syncedCount: result.syncedCount,
          bodyType: describeBodyType(response),
          sampleFields: firstRowSamples,
          diagnostics: {
            ...diagnosticsBase,
            ...result.diagnostics,
            validAfterNormalization: result.syncedCount,
            discardedAfterNormalization,
          },
          authMode: "seller",
        },
      );
      return {
        syncedCount: result.syncedCount,
        diagnostics: {
          ...diagnosticsBase,
          ...result.diagnostics,
          validAfterNormalization: result.syncedCount,
          discardedAfterNormalization,
          warnings: result.warnings.length,
        },
      };
    },
    {
      ...options,
      lockScope: `partners:user:${seller.id}`,
      sellerId: seller.id,
      sellerName: seller.name,
      authMode: "seller",
      writeStatus: false,
    },
  );
}

export async function syncPartnersForAllConfiguredSellers(
  options?: RunSyncOptions,
) {
  const sellers = await prisma.user.findMany({
    where: {
      role: "vendedor",
      isActive: true,
      erpLoginUsername: { not: null },
      erpLoginPasswordEncrypted: { not: null },
    },
    select: {
      id: true,
      name: true,
      erpCode: true,
      erpLoginUsername: true,
      erpLoginPasswordEncrypted: true,
    },
    orderBy: [{ name: "asc" }],
  });
  const summary = {
    totalUsers: sellers.length,
    successCount: 0,
    errorCount: 0,
    skippedCount: 0,
  };
  const results: Array<{
    userId: string;
    sellerName: string;
    status: "success" | "error" | "skipped";
    syncedCount?: number;
    error?: string;
  }> = [];

  for (const seller of sellers) {
    try {
      const result = await syncPartnersByUser(seller.id, {
        ...options,
        failIfLocked: false,
      });
      const skipped = Boolean(result.diagnostics?.skippedByLock);
      if (skipped) summary.skippedCount += 1;
      else summary.successCount += 1;
      results.push({
        userId: seller.id,
        sellerName: seller.name,
        status: skipped ? "skipped" : "success",
        syncedCount: result.syncedCount,
      });
    } catch (error) {
      summary.errorCount += 1;
      const message = formatError(error);
      results.push({
        userId: seller.id,
        sellerName: seller.name,
        status: "error",
        error: message,
      });
      logApiEvent(
        "ERROR",
        "[ultrafv3 sync partners] seller sync failed during all-sellers run",
        { sellerId: seller.id, sellerName: seller.name, error: message },
      );
    }
  }

  return { ...summary, results };
}
async function syncReferenceData(
  scope: Exclude<
    UltraFv3SyncScope,
    "connection" | "products" | "partners" | "orderStatus"
  >,
  endpoint: string,
  options?: RunSyncOptions,
  aliases: string[] = [],
) {
  const resolved = await resolveReferenceCredentials();
  return runSync(
    scope,
    async (correlationId) => {
      let tokenPayload: {
        isSupervisor: number;
        salesman: number;
        operator: number;
      } | null = null;
      if (scope === "salesmen" && resolved.credentials) {
        const auth = await ultraFv3Client.authenticateWithCredentials(
          resolved.credentials,
        );
        tokenPayload = {
          isSupervisor: auth.tokenPayload.salesman ? 0 : 1,
          salesman: auth.tokenPayload.salesman ? 1 : 0,
          operator: auth.tokenPayload.operator ? 1 : 0,
        };
      }
      let result;
      if (scope === "salesmen") {
        const candidates = [
          endpoint,
          ...aliases.filter((item) => item && item !== endpoint),
        ];
        let lastError: unknown;
        let rawBody: unknown = null;
        let endpointUsed = endpoint;
        let rows: unknown[] = [];
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          try {
            rawBody = resolved.credentials
              ? await requestUltraFv3ReadOnlyWithCredentialsRetry<unknown>(
                  candidate,
                  resolved.credentials,
                  correlationId,
                )
              : await requestUltraFv3ReadOnlyWithRetry<unknown>(
                  candidate,
                  correlationId,
                );
            rows = toArray(rawBody);
            endpointUsed = candidate;
            break;
          } catch (error) {
            lastError = error;
            const message = formatError(error);
            const canTryAlias =
              index < candidates.length - 1 &&
              /404|inexistente|not found/i.test(message);
            if (!canTryAlias) throw error;
            logApiEvent(
              "WARN",
              "[ultrafv3 sync] endpoint unavailable; trying alias",
              {
                scope,
                correlationId,
                endpoint: candidate,
                nextEndpoint: candidates[index + 1],
                error: message,
              },
            );
          }
        }
        if (lastError && !rows.length && rawBody === null)
          throw lastError instanceof Error
            ? lastError
            : new Error(formatError(lastError));
        const rootKeys =
          rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
            ? Object.keys(rawBody as Record<string, unknown>).slice(0, 20)
            : [];
        logApiEvent("INFO", "[ultrafv3 sync salesmen] payload diagnostics", {
          correlationId,
          endpointUsed,
          httpStatus: 200,
          rawBody: sanitizePayloadForLog(rawBody),
          keys: rootKeys,
          foundCount: rows.length,
          tokenPayloadIsSupervisor: tokenPayload?.isSupervisor ?? null,
          tokenPayloadSalesman: tokenPayload?.salesman ?? null,
          tokenPayloadOperator: tokenPayload?.operator ?? null,
        });
        if (!rows.length) {
          logApiEvent(
            "INFO",
            "UltraFV3 retornou vazio para /salesmen usando vendedor comum",
            {
              correlationId,
              endpointUsed,
              tokenPayloadIsSupervisor: tokenPayload?.isSupervisor ?? null,
              tokenPayloadSalesman: tokenPayload?.salesman ?? null,
              tokenPayloadOperator: tokenPayload?.operator ?? null,
            },
          );
        }
        result = {
          rows,
          endpointUsed,
          aliasFallbackUsed: endpointUsed !== endpoint ? 1 : 0,
        };
      } else {
        result = await fetchUltraFv3RowsWithAlias(
          endpoint,
          scope,
          correlationId,
          resolved.credentials,
          aliases,
        );
      }
      await prisma.appConfig.upsert({
        where: { key: `erp.ultrafv3.${scope}` },
        update: { value: JSON.stringify(result.rows) },
        create: {
          key: `erp.ultrafv3.${scope}`,
          value: JSON.stringify(result.rows),
        },
      });
      return {
        syncedCount: result.rows.length,
        diagnostics: {
          endpointUsed: 1,
          aliasFallbackUsed: result.aliasFallbackUsed,
        },
      };
    },
    {
      ...options,
      authMode: resolved.authMode,
      sellerId: resolved.sellerId ?? undefined,
      sellerName: resolved.sellerName ?? undefined,
    },
  );
}

export const syncPriceTables = (options?: RunSyncOptions) =>
  syncReferenceData("priceTables", "/price-tables", options, ["/priceTables"]);
export const syncPriceVariations = (options?: RunSyncOptions) =>
  syncReferenceData("priceVariations", "/priceVariations", options);
export const syncPrices = (options?: RunSyncOptions) =>
  syncReferenceData("prices", "/prices", options);
export const syncPaymentMethods = (options?: RunSyncOptions) =>
  syncReferenceData("paymentMethods", "/payment-methods", options, [
    "/paymentMethods",
  ]);
export const syncReceivingConditions = (options?: RunSyncOptions) =>
  syncReferenceData("receivingConditions", "/receiving-conditions", options, [
    "/receivingConditions",
  ]);
export const syncBranches = (options?: RunSyncOptions) =>
  syncReferenceData("branches", "/branches", options);
export const syncOperations = (options?: RunSyncOptions) =>
  syncReferenceData("operations", "/operations", options);
export const syncSalesmen = (options?: RunSyncOptions) =>
  syncReferenceData("salesmen", "/salesmen", options, [
    "/seller",
    "/vendors",
    "/vendedores",
  ]);


export type UltraFv3FullSyncStep = {
  scope: Exclude<UltraFv3SyncScope, "orderStatus">;
  label: string;
  result: SyncResult;
};

export type UltraFv3FullSyncResult = {
  success: true;
  durationMs: number;
  correlationId: string;
  stats: {
    clients: number;
    products: number;
    priceTables: number;
    prices: number;
    operations: number;
    branches: number;
  };
  steps: UltraFv3FullSyncStep[];
};

const FULL_SYNC_STEPS: Array<{
  scope: Exclude<UltraFv3SyncScope, "orderStatus">;
  label: string;
  run: (options?: RunSyncOptions) => Promise<SyncResult>;
}> = [
  { scope: "connection", label: "Conexão", run: syncConnection },
  { scope: "salesmen", label: "Vendedores", run: syncSalesmen },
  { scope: "partners", label: "Clientes", run: syncPartners },
  { scope: "products", label: "Produtos", run: syncProducts },
  { scope: "priceTables", label: "Tabelas de preço", run: syncPriceTables },
  { scope: "prices", label: "Preços calculados", run: syncPrices },
  { scope: "priceVariations", label: "Variações por tabela", run: syncPriceVariations },
  { scope: "receivingConditions", label: "Condições de pagamento", run: syncReceivingConditions },
  { scope: "paymentMethods", label: "Formas de pagamento", run: syncPaymentMethods },
  { scope: "branches", label: "Filiais", run: syncBranches },
  { scope: "operations", label: "Operações", run: syncOperations },
];

export async function syncAllUltraFv3Catalogs(): Promise<UltraFv3FullSyncResult> {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const steps: UltraFv3FullSyncStep[] = [];

  logApiEvent("INFO", "[ultrafv3 sync-all] full ERP sync started", {
    correlationId,
    totalSteps: FULL_SYNC_STEPS.length,
    steps: FULL_SYNC_STEPS.map((step) => step.scope),
  });

  try {
    for (const [index, step] of FULL_SYNC_STEPS.entries()) {
      logApiEvent("INFO", "[ultrafv3 sync-all] step started", {
        correlationId,
        scope: step.scope,
        label: step.label,
        step: index + 1,
        totalSteps: FULL_SYNC_STEPS.length,
      });
      const result = await step.run({ correlationId, failIfLocked: true });
      steps.push({ scope: step.scope, label: step.label, result });
      logApiEvent("INFO", "[ultrafv3 sync-all] step finished", {
        correlationId,
        scope: step.scope,
        label: step.label,
        step: index + 1,
        totalSteps: FULL_SYNC_STEPS.length,
        syncedCount: result.syncedCount,
      });
    }

    const durationMs = Date.now() - startedAt;
    const countByScope = new Map(steps.map((step) => [step.scope, step.result.syncedCount]));
    const response: UltraFv3FullSyncResult = {
      success: true,
      durationMs,
      correlationId,
      stats: {
        clients: countByScope.get("partners") ?? 0,
        products: countByScope.get("products") ?? 0,
        priceTables: countByScope.get("priceTables") ?? 0,
        prices: countByScope.get("prices") ?? 0,
        operations: countByScope.get("operations") ?? 0,
        branches: countByScope.get("branches") ?? 0,
      },
      steps,
    };

    logApiEvent("INFO", "[ultrafv3 sync-all] full ERP sync finished", response);
    return response;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logApiEvent("ERROR", "[ultrafv3 sync-all] full ERP sync failed", {
      correlationId,
      durationMs,
      completedSteps: steps.map((step) => step.scope),
      error: formatError(error),
    });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      correlationId,
      durationMs,
      completedSteps: steps.map((step) => step.scope),
    });
  }
}

const getLatestSyncError = (
  statuses: Record<UltraFv3SyncScope, SyncStatusPayload>,
) => {
  return (
    Object.values(statuses)
      .filter((status) => status.errors?.[0])
      .sort(
        (a, b) =>
          new Date(b.lastSyncAt || 0).getTime() -
          new Date(a.lastSyncAt || 0).getTime(),
      )[0]?.errors?.[0] ?? null
  );
};

export function getUltraFv3IntegrationDiagnostics(
  statuses: Record<UltraFv3SyncScope, SyncStatusPayload>,
): UltraFv3IntegrationDiagnostics {
  const clientDiagnostics = ultraFv3Client.getDiagnostics();
  const preventiveMissingConfig = getMissingErpRuntimeConfig();
  const environment = getErpRuntimeEnvironmentDiagnostics();
  const mergedMissingConfig = Array.from(new Set([...clientDiagnostics.missingConfig, ...preventiveMissingConfig]));
  const lastError = clientDiagnostics.lastError || getLatestSyncError(statuses);
  const hasAuthError = lastError
    ? /autentica|usuário|usuario|senha|401|403/i.test(lastError)
    : false;
  const authenticationStatus =
    clientDiagnostics.authenticationStatus === "missing_config"
      ? "missing_config"
      : hasAuthError
        ? "auth_failed"
        : clientDiagnostics.authenticationStatus;

  let guidance =
    "Configuração mínima presente. Use o card Conexão UltraFV3 para validar autenticação e disponibilidade antes das sincronizações.";
  if (mergedMissingConfig.length > 0) {
    guidance = `Configure ${mergedMissingConfig.join(", ")} em /root/demetra-env/.env (produção) ou no .env local da API e reinicie o serviço antes de sincronizar/enviar pedidos.`;
  } else if (authenticationStatus === "auth_failed") {
    guidance =
      "Revise ULTRAFV3_USERNAME e ULTRAFV3_PASSWORD no backend/API e valide se o usuário tem permissão na API UltraFV3.";
  } else if (lastError) {
    guidance =
      "Corrija o último erro informado e execute novamente o card Conexão UltraFV3.";
  } else if (authenticationStatus === "authenticated") {
    guidance =
      "Autenticação UltraFV3 ativa em memória. As sincronizações podem ser executadas conforme necessário.";
  }

  return {
    ...clientDiagnostics,
    missingConfig: mergedMissingConfig,
    isConfigured: mergedMissingConfig.length === 0,
    authenticationStatus: mergedMissingConfig.length > 0 ? "missing_config" : authenticationStatus,
    lastError,
    environment,
    guidance,
  };
}

export async function getUltraFv3SyncStatus() {
  const scopes: UltraFv3SyncScope[] = [
    "connection",
    "products",
    "partners",
    "orderStatus",
    "salesmen",
    "paymentMethods",
    "receivingConditions",
    "priceTables",
    "priceVariations",
    "prices",
    "branches",
    "operations",
  ];
  const latestRuns = await prisma.erpSyncRun.findMany({
    where: { scope: { in: scopes }, status: { not: ErpSyncRunStatus.running } },
    orderBy: [{ startedAt: "desc" }],
    distinct: ["scope"],
  });
  const byScope = new Map(
    latestRuns.map((run) => [run.scope as UltraFv3SyncScope, run]),
  );

  return scopes.reduce<Record<UltraFv3SyncScope, SyncStatusPayload>>(
    (acc, scope) => {
      const run = byScope.get(scope);
      if (!run) {
        acc[scope] = { scope, status: "idle", syncedCount: 0 };
        return acc;
      }
      const errors = run.errorMessage ? [run.errorMessage] : undefined;
      acc[scope] = {
        scope,
        status:
          run.status === ErpSyncRunStatus.success
            ? "success"
            : run.status === ErpSyncRunStatus.error
              ? "error"
              : run.status === ErpSyncRunStatus.skipped
                ? "skipped"
                : "running",
        lastSyncAt: (run.finishedAt ?? run.startedAt).toISOString(),
        syncedCount: run.syncedCount ?? 0,
        errors,
        correlationId: run.correlationId ?? undefined,
        durationMs: run.durationMs ?? undefined,
        trigger: run.trigger,
        runId: run.id,
        sellerId: run.sellerId,
        sellerName: run.sellerName,
        authMode: run.authMode as
          | "global"
          | "seller"
          | "seller_reference"
          | undefined,
      };
      return acc;
    },
    {} as Record<UltraFv3SyncScope, SyncStatusPayload>,
  );
}

export async function syncOrderStatus(
  runner: () => Promise<SyncResult>,
  options?: RunSyncOptions,
) {
  return runSync("orderStatus", async () => runner(), options);
}

export async function getUltraFv3SyncHistory(limit = 20) {
  return prisma.erpSyncRun.findMany({
    orderBy: [{ startedAt: "desc" }],
    take: Math.min(Math.max(limit, 1), 100),
  });
}
