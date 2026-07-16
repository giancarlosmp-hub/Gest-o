import express, { Router, type Request } from "express";
import { inflateRawSync } from "node:zlib";
import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { authMiddleware } from "../middlewares/auth.js";
import { appUsageRateLimit } from "../middlewares/rateLimit.js";
import { validateBody } from "../middlewares/validate.js";
import {
  activityKpiUpsertSchema,
  activitySchema,
  clientContactSchema,
  clientSchema,
  companySchema,
  contactSchema,
  cultureCatalogSchema,
  eventSchema,
  goalSchema,
  objectiveUpsertSchema,
  opportunitySchema,
  userActivationSchema,
  userCreateSchema,
  userResetPasswordSchema,
  userRoleUpdateSchema,
  userUpdateSchema,
  weeklyVisitMinimumSchema,
  commercialAutomationsConfigSchema,
  erpOrderGenerationSchema,
  knowledgeDocumentCreateSchema,
  knowledgeDocumentUpdateSchema
} from "@salesforce-pro/shared";
import { authorize } from "../middlewares/authorize.js";
import { resolveOwnerId, sellerWhere } from "../utils/access.js";
import { normalizeCnpj, normalizeState, normalizeText } from "../utils/normalize.js";
import { calculatePipelineMetrics, getWeightedValue, isOpportunityOverdue } from "../utils/pipelineMetrics.js";
import { randomBytes, randomUUID } from "node:crypto";
import { buildTimelineEventWhere } from "./timelineEventWhere.js";
import { ActivityType, ClientType, ErpOrderSyncStatus, ErpSyncTrigger, OpportunityStage, Prisma, Role, type User } from "@prisma/client";
import { z } from "zod";
import { hashPassword } from "../utils/password.js";
import { calculateOpportunityRisk } from "../services/opportunityInsight.js";
import { generateSalesMessage } from "../services/opportunitySalesMessage.js";
import { buildClientAiContext } from "../services/clientAiContext.js";
import { generateClientSuggestion } from "../services/clientSuggestion.js";
import { buildAssistantWhatsappContext, generateAssistantWhatsappMessage } from "../services/assistantWhatsapp.js";
import { aiService } from "../services/ai/aiService.js";
import {
  calculateTodayPriorities,
  generateClientSummary,
  generateOpportunityInsight,
  parseActivityObservation
} from "../services/ai/index.js";
import {
  getUltraFv3IntegrationDiagnostics,
  getUltraFv3SyncHistory,
  getUltraFv3SyncStatus,
  syncBranches,
  syncConnection,
  syncFinancialProfiles,
  syncOperations,
  syncPartnerTitles,
  syncPartners,
  syncPartnersByUser,
  syncPartnersForAllConfiguredSellers,
  syncPaymentMethods,
  syncPriceTables,
  syncPriceVariations,
  syncPrices,
  syncProducts,
  syncReceivingConditions,
  syncSalesmen,
  syncOrderStatus,
  startUltraFv3FullSyncJob
} from "../services/ultraFv3SyncService.js";
import { buildUltraFv3TimeoutPayload, ULTRAFV3_REQUEST_TIMEOUT_MS, ultraFv3Client } from "../services/ultraFv3Client.js";
import { buildSalesmenDiagnostic, createErpOrderFromOpportunity, getErpOrderOperationalSummary, getErpOrderParameterDiagnostics, getZeroNumPedidoDryRunReport, normalizeErpOrderParameterCodes, runUltraFv3OrderProtocolTest, sanitizeErpOrderErrorMessage, sanitizeErpOrderPayload, syncErpOrderStatuses, type UltraFv3OrderPayload } from "../services/erpOrderService.js";
import { logApiEvent, sanitizePayload } from "../utils/logger.js";
import { buildControlledErpOrderFailurePayload, safeJsonStringify } from "../utils/erpOrderFailureResponse.js";
import { decryptErpCredential, encryptErpCredential, isErpCredentialEncryptionConfigured } from "../services/erpCredentialCrypto.js";
import { buildErpOrderPdf, getErpOrderPdfCompany, getErpOrderPdfFilename, getErpOrderPdfMetadata, type ErpOrderPdfRecord } from "../services/erpOrderPdfService.js";
import { calculateOpportunityPriceForTable, normalizeOpportunityPriceTableCode } from "../services/opportunityPriceService.js";
import { getCommercialInsights, invalidateCommercialInsightsCache } from "../services/commercialInsightsService.js";
import { refreshErpAutomaticSyncConfig, runAutomaticErpSyncNow, setErpAutomaticSyncEnabled } from "../jobs/erpSyncScheduler.js";
import { COMMERCIAL_AUTOMATIONS_CONFIG_KEY, DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG, getCommercialAutomationsStatus, parseCommercialAutomationsConfig, runCommercialAutomations } from "../services/commercialAutomationsService.js";
import { ensureInitialKnowledgeDocuments, getKnowledgeContextForAi, searchKnowledgeDocuments } from "../services/knowledgeBaseService.js";

const router = Router();
const ERP_ORDER_ROUTE_TIMEOUT_MS = env.erpOrderRequestTimeoutMs;
router.use(authMiddleware);
router.use(appUsageRateLimit);


type CultureGoalRange = { min: number; max: number };

type CultureGoals = Record<string, CultureGoalRange>;

const GOAL_KEY_NORMALIZER = /[^a-z0-9_\-]/g;

const normalizeGoalKey = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(GOAL_KEY_NORMALIZER, "");


type ErpSalesmanOption = {
  code: string;
  name: string;
  cpf: string | null;
  email: string | null;
  erpOperatorCode: string | null;
  raw: unknown;
};

type ErpSalesmenOptionsMode = "global_available" | "global_unavailable";
type ErpSalesmenOptionsResponse = {
  items: ErpSalesmanOption[];
  mode: ErpSalesmenOptionsMode;
  warning: string | null;
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const pickFirstString = (row: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = normalizeOptionalString(row[key]);
    if (value) return value;
  }
  return null;
};

const normalizeErpSalesmanOption = (row: unknown): ErpSalesmanOption | null => {
  if (!row || typeof row !== "object") return null;
  const payload = row as Record<string, unknown>;
  const code = pickFirstString(payload, ["code", "erpCode", "sellerCode", "salesmanCode", "vendedorCodigo", "codigo", "CODIGO", "CODVENDEDOR", "codVendedor"]);
  const name = pickFirstString(payload, ["name", "description", "fullName", "sellerName", "salesmanName", "nome", "NOME", "razaoSocial"]);
  if (!code || !name) return null;

  return {
    code,
    name,
    cpf: pickFirstString(payload, ["cpf", "CPF", "document", "documentNumber", "cnpjCpf"]),
    email: pickFirstString(payload, ["email", "EMAIL", "mail", "eMail"]),
    erpOperatorCode: pickFirstString(payload, ["operatorCode", "erpOperatorCode", "operadorCodigo", "codigoOperador", "operator", "operador", "OPERADOR"]),
    raw: row
  };
};

const loadErpSalesmenOptions = async (): Promise<ErpSalesmenOptionsResponse> => {
  const stored = await prisma.appConfig.findUnique({ where: { key: "erp.ultrafv3.salesmen" }, select: { value: true } });
  let rows: unknown[] = [];

  if (stored?.value) {
    try {
      const parsed = JSON.parse(stored.value);
      if (Array.isArray(parsed)) rows = parsed;
    } catch {
      rows = [];
    }
  }

  if (!rows.length) {
    try {
      const consulted = await ultraFv3Client.request("/salesmen", { timeoutMs: ULTRAFV3_REQUEST_TIMEOUT_MS });
      rows = Array.isArray(consulted) ? consulted : [];
      await prisma.appConfig.upsert({
        where: { key: "erp.ultrafv3.salesmen" },
        update: { value: JSON.stringify(rows) },
        create: { key: "erp.ultrafv3.salesmen", value: JSON.stringify(rows) }
      });
    } catch (error) {
      if (!ultraFv3Client.hasGlobalCredentials()) {
        logApiEvent("INFO", "[erp salesmen options] global credentials unavailable; returning empty options", {
          missingConfig: ultraFv3Client.getDiagnostics().missingConfig
        });
        return {
          items: [],
          mode: "global_unavailable",
          warning: "Credenciais globais do UltraFV3 não configuradas. Preencha o vínculo ERP/Login FV3 manualmente para este vendedor."
        };
      }
      throw error;
    }
  }

  const byCode = new Map<string, ErpSalesmanOption>();
  for (const row of rows) {
    const option = normalizeErpSalesmanOption(row);
    if (option && !byCode.has(option.code)) byCode.set(option.code, option);
  }

  return {
    items: Array.from(byCode.values()).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    mode: ultraFv3Client.hasGlobalCredentials() ? "global_available" : "global_unavailable",
    warning: ultraFv3Client.hasGlobalCredentials() ? null : "Credenciais globais do UltraFV3 não configuradas."
  };
};


const maskDocumentForLog = (value: unknown): string | null => {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (!digits) return null;
  if (digits.length <= 4) return "****";
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
};


const sanitizeErpRawPayload = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeErpRawPayload(item));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (/(cpf|cnpj|document|documento)/i.test(key)) {
        output[key] = maskDocumentForLog(nestedValue);
      } else {
        output[key] = sanitizeErpRawPayload(nestedValue);
      }
    }
    return sanitizePayload(output);
  }

  return value;
};

const resolveErpSalesmanOption = async (submittedErpCode: unknown): Promise<ErpSalesmanOption | null> => {
  const normalized = normalizeOptionalString(submittedErpCode);
  if (!normalized) return null;

  const options = await loadErpSalesmenOptions();
  const optionItems = options.items;
  const normalizedLower = normalized.toLowerCase();
  return optionItems.find((option) =>
    option.code === normalized ||
    option.name.toLowerCase() === normalizedLower ||
    `${option.name} · ${option.code}`.toLowerCase() === normalizedLower ||
    `${option.name} - ${option.code}`.toLowerCase() === normalizedLower
  ) ?? null;
};

const buildUserUpdateLogMeta = (params: {
  targetUserId: string;
  actorUserId?: string;
  actorRole?: string;
  role?: string;
  erpCode?: unknown;
  erpOperatorCode?: unknown;
  erpLoginUsername?: unknown;
  hasCrmPasswordChange: boolean;
  hasErpPasswordChange: boolean;
}) => ({
  targetUserId: params.targetUserId,
  actorUserId: params.actorUserId,
  actorRole: params.actorRole,
  role: params.role,
  erpCode: normalizeOptionalString(params.erpCode),
  erpOperatorCode: normalizeOptionalString(params.erpOperatorCode),
  erpLoginUsernameMasked: maskDocumentForLog(params.erpLoginUsername),
  hasCrmPasswordChange: params.hasCrmPasswordChange,
  hasErpPasswordChange: params.hasErpPasswordChange
});


const SALESMAN_DIAG_CODE_KEYS = ["CODVENDEDOR", "VENDEDOR", "code", "erpCode", "sellerCode", "salesmanCode", "vendedorCodigo", "codigo", "CODIGO", "codVendedor", "COD_VENDEDOR", "CODVEN"];
const SALESMAN_DIAG_OPERATOR_KEYS = ["OPERADOR", "CODOPERADOR", "COD_OPERADOR", "CODIGO_OPERADOR", "operator", "operador", "operatorCode", "erpOperatorCode", "operadorCodigo", "codigoOperador"];
const SALESMAN_DIAG_NUM_PEDIDO_KEYS = ["NUM_PEDIDO", "NUMERO_PEDIDO", "numPedido", "numeroPedido"];
const SALESMAN_DIAG_LOGIN_KEYS = ["LOGIN", "login", "USUARIO", "usuario", "USERNAME", "username", "email", "EMAIL", "CPF", "CNPJ", "cpf", "cnpj", "document", "documentNumber", "cnpjCpf"];

const normalizeErpDiagCode = (value: unknown) => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (digitsOnly && /^[0-9\s._/-]+$/.test(trimmed)) return digitsOnly.replace(/^0+/, "") || "0";
  return trimmed.toLowerCase();
};

const pickDiagText = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
};

const toDiagArray = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["SALESMAN", "items", "data", "rows", "results", "content"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
};

const parseSalesmenCacheRows = (value?: string | null): unknown[] => {
  if (!value?.trim()) return [];
  try {
    return toDiagArray(JSON.parse(value));
  } catch {
    return [];
  }
};

const getMaskedLoginType = (value: unknown) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11) return "cpf";
  if (digits.length === 14) return "cnpj";
  return String(value ?? "").trim() ? "usuario" : "ausente";
};

const normalizeCulturePayload = (payload: z.infer<typeof cultureCatalogSchema>) => {
  const goals = Object.entries(payload.goalsJson || {}).reduce<CultureGoals>((acc, [goal, range]) => {
    const key = normalizeGoalKey(goal);
    if (!key) return acc;
    const min = Number(range.min);
    const max = Number(range.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
      throw Object.assign(new Error(`Faixa inválida para o objetivo '${goal}'.`), { status: 400 });
    }
    acc[key] = { min, max };
    return acc;
  }, {});

  const tags = (payload.tags || [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);

  if (payload.defaultKgHaMin != null && payload.defaultKgHaMax != null && payload.defaultKgHaMax < payload.defaultKgHaMin) {
    throw Object.assign(new Error("Faixa padrão de kg/ha inválida."), { status: 400 });
  }

  return {
    slug: payload.slug.trim().toLowerCase(),
    label: payload.label.trim(),
    category: payload.category.trim(),
    isActive: payload.isActive ?? true,
    defaultKgHaMin: payload.defaultKgHaMin ?? null,
    defaultKgHaMax: payload.defaultKgHaMax ?? null,
    goalsJson: goals,
    notes: payload.notes?.trim() || null,
    pmsDefault: payload.pmsDefault ?? null,
    germinationDefault: payload.germinationDefault ?? null,
    purityDefault: payload.purityDefault ?? null,
    populationTargetDefault: payload.populationTargetDefault ?? null,
    rowSpacingCmDefault: payload.rowSpacingCmDefault ?? null,
    tags,
  };
};

const cultureQuerySchema = z.object({
  active: z.enum(["true", "false"]).optional(),
  search: z.string().optional(),
  tags: z.string().optional(),
  category: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});


const normalizeTerritoryCityKey = (city?: string | null) =>
  normalizeText(city)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const parseTerritoryMonth = (monthParam: unknown) => {
  const rawMonth = typeof monthParam === "string" && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : new Date().toISOString().slice(0, 7);
  const [year, month] = rawMonth.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { rawMonth, start, end };
};

const formatDateDot = (date: Date) => {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}.${month}.${year}`;
};

const resolveSellerErpCode = (ownerSeller: Pick<User, "erpCode">): string | null => ownerSeller.erpCode?.trim() || null;

type TechnicalCultureCatalogItem = {
  id: string;
  name: string;
  category: string;
  kgHaMin: number | null;
  kgHaMax: number | null;
  pmsDefault: number | null;
  populationDefaultHa: number | null;
  spacingDefaultCm: number | null;
  germinationDefault: number | null;
  purityDefault: number | null;
  notes?: string;
};

const TECHNICAL_CULTURES_STATIC_SEED: TechnicalCultureCatalogItem[] = [
  {
    id: "sorgo",
    name: "Sorgo",
    category: "Grãos",
    kgHaMin: 8,
    kgHaMax: 18,
    pmsDefault: 28,
    populationDefaultHa: 180000,
    spacingDefaultCm: 45,
    germinationDefault: 85,
    purityDefault: 98,
    notes: "Catálogo técnico seed padrão.",
  },
  {
    id: "milho",
    name: "Milho",
    category: "Grãos",
    kgHaMin: 14,
    kgHaMax: 24,
    pmsDefault: 32,
    populationDefaultHa: 65000,
    spacingDefaultCm: 50,
    germinationDefault: 90,
    purityDefault: 98,
    notes: "Catálogo técnico seed padrão.",
  },
  {
    id: "milheto",
    name: "Milheto",
    category: "Cobertura",
    kgHaMin: 10,
    kgHaMax: 20,
    pmsDefault: 8,
    populationDefaultHa: 250000,
    spacingDefaultCm: 34,
    germinationDefault: 80,
    purityDefault: 95,
    notes: "Catálogo técnico seed padrão.",
  },
];

const serializeTechnicalCultureCatalogItem = (
  item: {
    slug: string;
    label: string;
    category: string;
    defaultKgHaMin: number | null;
    defaultKgHaMax: number | null;
    pmsDefault: number | null;
    populationTargetDefault: number | null;
    rowSpacingCmDefault: number | null;
    germinationDefault: number | null;
    purityDefault: number | null;
    notes: string | null;
  }
): TechnicalCultureCatalogItem => ({
  id: item.slug,
  name: item.label,
  category: item.category,
  kgHaMin: item.defaultKgHaMin,
  kgHaMax: item.defaultKgHaMax,
  pmsDefault: item.pmsDefault,
  populationDefaultHa: item.populationTargetDefault,
  spacingDefaultCm: item.rowSpacingCmDefault,
  germinationDefault: item.germinationDefault,
  purityDefault: item.purityDefault,
  ...(item.notes ? { notes: item.notes } : {}),
});


const CLOSED_STAGE_VALUES = ["ganho", "perdido"] as const;
const CLOSED_STAGES = new Set<string>(CLOSED_STAGE_VALUES);
const STAGE_ALIASES: Record<string, "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido"> = {
  WON: "ganho",
  won: "ganho",
  LOST: "perdido",
  lost: "perdido",
  prospeccao: "prospeccao",
  negociacao: "negociacao",
  proposta: "proposta",
  ganho: "ganho",
  perdido: "perdido"
};
const STAGE_LABELS: Record<"prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido", string> = {
  prospeccao: "Prospecção",
  negociacao: "Negociação",
  proposta: "Proposta",
  ganho: "Ganho",
  perdido: "Perdido"
};

const normalizeDateToUtc = (value: string, endOfDay = false) => {
  const plainDateMatch = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (plainDateMatch) {
    const [year, month, day] = value.split("-").map(Number);
    const utcHour = endOfDay ? 26 : 3;
    const utcMinute = endOfDay ? 59 : 0;
    const utcSecond = endOfDay ? 59 : 0;
    const utcMs = endOfDay ? 999 : 0;
    return endOfDay
      ? new Date(Date.UTC(year, month - 1, day, utcHour, utcMinute, utcSecond, utcMs))
      : new Date(Date.UTC(year, month - 1, day, utcHour, utcMinute, utcSecond, utcMs));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const getUtcTodayStart = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
};

const getLastBusinessDaysWindow = (businessDays: number, referenceDate = new Date()) => {
  const end = new Date(referenceDate);
  end.setHours(23, 59, 59, 999);

  const start = new Date(end);
  let counted = 0;

  while (counted < businessDays) {
    const weekDay = start.getDay();
    if (weekDay >= 1 && weekDay <= 5) {
      counted += 1;
      if (counted === businessDays) break;
    }
    start.setDate(start.getDate() - 1);
  }

  start.setHours(0, 0, 0, 0);
  return { start, end };
};

const getWeekRangeFromStart = (weekStart: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null;

  const start = normalizeDateToUtc(weekStart);
  if (!start) return null;

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  const previousStart = new Date(start);
  previousStart.setUTCDate(start.getUTCDate() - 7);

  const previousEnd = new Date(start);
  previousEnd.setUTCDate(start.getUTCDate() - 1);
  previousEnd.setUTCHours(23, 59, 59, 999);

  return { start, end, previousStart, previousEnd };
};

const normalizeStageInput = (stage?: string) => {
  if (!stage) return undefined;
  const normalized = stage.trim();
  return STAGE_ALIASES[normalized] || STAGE_ALIASES[normalized.toLowerCase()];
};

const getStageFilter = (stage?: string) => normalizeStageInput(stage);
const closedOpportunityEditSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  value: z.coerce.number().finite().nonnegative().optional(),
  crop: z.string().trim().max(100).nullable().optional(),
  season: z.string().trim().max(100).nullable().optional(),
  stage: z.enum(CLOSED_STAGE_VALUES).optional()
}).refine((payload) => Object.keys(payload).length > 0, { message: "Nenhum campo para atualização foi informado." });

type OpportunityStatusFilter = "open" | "closed" | "all";
const getOpportunityStatusFilter = (status?: string): OpportunityStatusFilter | undefined => {
  if (!status) return "open";

  const normalized = status.toLowerCase();
  if (normalized === "abertas") return "open";
  if (normalized === "encerradas") return "closed";
  if (normalized === "todas") return "all";

  if (normalized === "open" || normalized === "closed" || normalized === "all") return normalized;
  return undefined;
};
type OpportunityFilterParams = {
  stage?: OpportunityStage;
  status: OpportunityStatusFilter;
  ownerSellerId?: string;
  clientId?: string;
  search?: string;
  crop?: string;
  season?: string;
  dateRangeWhere?: { gte?: Date; lte?: Date };
  overdueOnly: boolean;
};

const parseOpportunityFilterParams = (req: Request) => {
  const stageQuery = (req.query.stage as string | undefined) || (req.query.etapa as string | undefined);
  const stage = getStageFilter(stageQuery);
  if (stageQuery && !stage) return { error: "stage inválido" } as const;

  const status = getOpportunityStatusFilter(req.query.status as string | undefined);
  if (req.query.status && !status) return { error: "status inválido" } as const;
  const resolvedStatus: OpportunityStatusFilter = status ?? "open";

  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;

  const dateRangeWhere: OpportunityFilterParams["dateRangeWhere"] = {};
  if (dateFrom) {
    const parsed = normalizeDateToUtc(dateFrom, false);
    if (!parsed) return { error: "dateFrom inválido" } as const;
    dateRangeWhere.gte = parsed;
  }
  if (dateTo) {
    const parsed = normalizeDateToUtc(dateTo, true);
    if (!parsed) return { error: "dateTo inválido" } as const;
    dateRangeWhere.lte = parsed;
  }

  return {
    params: {
      stage,
      status: resolvedStatus,
      ownerSellerId: (req.query.ownerId as string | undefined) || (req.query.ownerSellerId as string | undefined),
      clientId: req.query.clientId as string | undefined,
      search: req.query.search as string | undefined,
      crop: req.query.crop as string | undefined,
      season: req.query.season as string | undefined,
      dateRangeWhere: Object.keys(dateRangeWhere).length ? dateRangeWhere : undefined,
      overdueOnly: req.query.overdue === "true" || req.query.overdueOnly === "true" || req.query.somenteAtrasadas === "true"
    } satisfies OpportunityFilterParams
  } as const;
};

const buildOpportunityWhere = (req: Request, params: OpportunityFilterParams, todayStart: Date) => {
  const whereFilters: Prisma.OpportunityWhereInput[] = [sellerWhere(req)];

  if (params.status === "open") whereFilters.push({ stage: { notIn: [...CLOSED_STAGE_VALUES] } });
  if (params.status === "closed") whereFilters.push({ stage: { in: [...CLOSED_STAGE_VALUES] } });
  if (params.stage) whereFilters.push({ stage: params.stage });
  if (params.ownerSellerId) whereFilters.push({ ownerSellerId: params.ownerSellerId });
  if (params.clientId) whereFilters.push({ clientId: params.clientId });
  if (params.crop) whereFilters.push({ crop: params.crop });
  if (params.season) whereFilters.push({ season: params.season });
  if (params.dateRangeWhere) {
    if (params.status === "closed") {
      whereFilters.push({
        OR: [
          { closedAt: params.dateRangeWhere },
          { closedAt: null, expectedCloseDate: params.dateRangeWhere }
        ]
      });
    } else {
      whereFilters.push({ proposalDate: params.dateRangeWhere });
    }
  }
  if (params.overdueOnly) {
    whereFilters.push({
      followUpDate: { lt: todayStart },
      stage: { notIn: [...CLOSED_STAGE_VALUES] }
    });
  }
  if (params.search) {
    whereFilters.push({
      OR: [{ title: { contains: params.search, mode: "insensitive" } }, { client: { name: { contains: params.search, mode: "insensitive" } } }]
    });
  }

  return { AND: whereFilters } satisfies Prisma.OpportunityWhereInput;
};

const getDaysOverdue = (expectedCloseDate: Date, stage: string, todayStart: Date) => {
  if (CLOSED_STAGES.has(stage)) return null;
  if (expectedCloseDate >= todayStart) return null;
  return Math.floor((todayStart.getTime() - expectedCloseDate.getTime()) / 86400000);
};

const toIsoStringOrNull = (value: unknown) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const serializeOpportunity = (opportunity: any, todayStart: Date) => ({
  ...opportunity,
  proposalDate: toIsoStringOrNull(opportunity.proposalDate),
  followUpDate: toIsoStringOrNull(opportunity.followUpDate),
  expectedCloseDate: toIsoStringOrNull(opportunity.expectedCloseDate),
  closedAt: toIsoStringOrNull(opportunity.closedAt),
  lastContactAt: toIsoStringOrNull(opportunity.lastContactAt),
  plantingForecastDate: toIsoStringOrNull(opportunity.plantingForecastDate),
  createdAt: toIsoStringOrNull(opportunity.createdAt),
  client: opportunity.client?.name,
  clientData: opportunity.client
    ? {
        id: opportunity.client.id,
        code: opportunity.client.code ?? null,
        name: opportunity.client.name ?? null,
        fantasyName: opportunity.client.fantasyName ?? null,
        cnpj: opportunity.client.cnpj ?? null,
        city: opportunity.client.city ?? null,
        state: opportunity.client.state ?? null,
      }
    : null,
  clientCity: opportunity.client?.city || null,
  clientState: opportunity.client?.state || null,
  owner: opportunity.ownerSeller?.name,
  ownerSeller: opportunity.ownerSeller
    ? {
        id: opportunity.ownerSeller.id,
        name: opportunity.ownerSeller.name,
        erpCode: opportunity.ownerSeller.erpCode ?? null,
        erpOperatorCode: opportunity.ownerSeller.erpOperatorCode ?? null,
        erpLoginUsername: opportunity.ownerSeller.erpLoginUsername ?? null,
        erpLoginPasswordConfigured: Boolean(opportunity.ownerSeller.erpLoginPasswordEncrypted)
      }
    : null,
  daysOverdue: opportunity.expectedCloseDate ? getDaysOverdue(opportunity.expectedCloseDate, opportunity.stage, todayStart) : null,
  weightedValue: getWeightedValue(opportunity.value, opportunity.probability),
  risk: calculateOpportunityRisk(opportunity)
});

const parseObjectivePeriod = (monthQuery?: string, yearQuery?: string) => {
  const now = new Date();
  const month = Number(monthQuery ?? now.getMonth() + 1);
  const year = Number(yearQuery ?? now.getFullYear());

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return null;
  }

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  return {
    month,
    year,
    monthKey
  };
};

const getMonthKey = (date: Date) => date.toISOString().slice(0, 7);

const BRAZIL_TIMEZONE = "America/Sao_Paulo";

const getBrazilNow = () => {
  const now = new Date();
  const formatted = now.toLocaleString("sv-SE", { timeZone: BRAZIL_TIMEZONE });
  return new Date(`${formatted}Z`);
};

const getMonthRangeFromKey = (monthKey: string) => {
  const [year, month] = monthKey.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999))
  };
};

const buildWonOpportunityDateRangeFilter = (start: Date, end: Date): Prisma.OpportunityWhereInput => ({
  OR: [
    { closedAt: { gte: start, lte: end } },
    { closedAt: null, expectedCloseDate: { gte: start, lte: end } }
  ]
});

const getWeekRangeFromMonday = (weekStartRaw: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartRaw)) return null;
  const start = normalizeDateToUtc(weekStartRaw);
  if (!start) return null;

  const day = start.getUTCDay();
  if (day !== 1) return null;

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(26, 59, 59, 999);

  return { start, end };
};

const getCurrentWeekRangeFromBrazilNow = () => {
  const now = getBrazilNow();
  const start = new Date(now);
  const day = start.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  start.setUTCDate(start.getUTCDate() - diffToMonday);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  return { start, end };
};

const DEFAULT_WEEKLY_VISIT_GOAL = 25;
const WEEKLY_VISIT_GOAL_KEY = "weeklyVisitGoal";
const APP_CONFIG_CACHE_TTL_MS = 60_000;
const weeklyVisitGoalCache: {
  value: number;
  expiresAt: number;
  pending: Promise<number> | null;
} = {
  value: DEFAULT_WEEKLY_VISIT_GOAL,
  expiresAt: 0,
  pending: null
};

const parseWeeklyVisitGoal = (value: string | null | undefined) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEEKLY_VISIT_GOAL;
};

const getWeeklyVisitGoal = async () => {
  const now = Date.now();
  if (weeklyVisitGoalCache.expiresAt > now) {
    return weeklyVisitGoalCache.value;
  }

  if (weeklyVisitGoalCache.pending) {
    return weeklyVisitGoalCache.pending;
  }

  weeklyVisitGoalCache.pending = (async () => {
    try {
      const config = await prisma.appConfig.upsert({
        where: { key: WEEKLY_VISIT_GOAL_KEY },
        update: {},
        create: { key: WEEKLY_VISIT_GOAL_KEY, value: String(DEFAULT_WEEKLY_VISIT_GOAL) },
        select: { value: true }
      });

      const parsedValue = parseWeeklyVisitGoal(config.value);
      weeklyVisitGoalCache.value = parsedValue;
      weeklyVisitGoalCache.expiresAt = Date.now() + APP_CONFIG_CACHE_TTL_MS;
      return parsedValue;
    } catch (error) {
      console.error("[appConfig] Falha ao obter weeklyVisitGoal. Usando fallback padrão.", error);
      weeklyVisitGoalCache.value = DEFAULT_WEEKLY_VISIT_GOAL;
      weeklyVisitGoalCache.expiresAt = Date.now() + APP_CONFIG_CACHE_TTL_MS;
      return DEFAULT_WEEKLY_VISIT_GOAL;
    } finally {
      weeklyVisitGoalCache.pending = null;
    }
  })();

  return weeklyVisitGoalCache.pending;
};

const getWeeklyVisitMedal = (visitsDone: number) => {
  if (visitsDone >= 25) return "gold" as const;
  if (visitsDone >= 18) return "silver" as const;
  if (visitsDone >= 12) return "bronze" as const;
  return "none" as const;
};

const ACTIVITY_TYPE_ALIASES: Record<string, ActivityType> = {
  follow_up: "followup",
  envio_proposta: "proposta_enviada"
};

const normalizeActivityType = (type: string): ActivityType => {
  const normalized = ACTIVITY_TYPE_ALIASES[type] ?? type;
  return normalized as ActivityType;
};

const resolveActivityTypeFilters = (...types: string[]) => {
  const normalized = Array.from(new Set(types.map(normalizeActivityType)));
  return normalized.length === 1 ? { type: normalized[0] } : { type: { in: normalized } };
};

const VISIT_TYPES = ["visita", "visita_tecnica"] as const;

const ACTIVITY_EXECUTED_LABEL: Partial<Record<ActivityType, string>> = {
  ligacao: "Ligação realizada",
  visita: "Visita realizada",
  reuniao: "Reunião realizada",
  proposta_enviada: "Envio de proposta realizado",
  followup: "Follow-up realizado",
  follow_up: "Follow-up realizado",
};

const buildActivityExecutedDescription = (activity: {
  type: ActivityType;
  date?: Date | null;
  result?: string | null;
  description?: string | null;
  opportunityId?: string | null;
  opportunityTitle?: string | null;
}) => {
  const baseLabel = ACTIVITY_EXECUTED_LABEL[normalizeActivityType(activity.type)] || "Atividade executada";
  const executedAt = (activity.date || new Date()).toLocaleString("pt-BR", { timeZone: "UTC" });
  const details = [`Executada em ${executedAt} (UTC)`];

  if (activity.result?.trim()) {
    details.push(`Resultado: ${activity.result.trim()}`);
  }

  if (activity.description?.trim()) {
    details.push(`Observações: ${activity.description.trim()}`);
  }

  if (activity.opportunityId) {
    details.push(activity.opportunityTitle ? `Oportunidade vinculada: ${activity.opportunityTitle}` : "Oportunidade vinculada");
  }

  return `${baseLabel}. ${details.join(" | ")}`;
};

const EXECUTION_ACTIVITY_TYPES: ActivityType[] = ["visita", "visita_tecnica", "reuniao", "followup", "follow_up"];

const resolveExecutionActivityDateFilter = (from: Date, to: Date): Prisma.ActivityWhereInput => ({
  date: { gte: from, lte: to }
});

const getActivityCountByTypeInMonth = async (ownerSellerId: string, type: ActivityType, monthKey: string) => {
  const { start, end } = getMonthRangeFromKey(monthKey);
  return prisma.activity.count({
    where: {
      ownerSellerId,
      done: true,
      ...resolveActivityTypeFilters(type),
      ...resolveExecutionActivityDateFilter(start, end)
    }
  });
};

const getLastNMonthKeys = (count: number, referenceDate = new Date()) => {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() - index, 1));
    return date.toISOString().slice(0, 7);
  }).reverse();
};

const calculateMean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

const calculateStandardDeviation = (values: number[]) => {
  if (values.length === 0) return 0;
  const mean = calculateMean(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const assertProbability = (probability: number | null | undefined) => {
  if (probability === null || probability === undefined) return true;
  return probability >= 0 && probability <= 100;
};

const normalizeOpportunityDates = (payload: Record<string, unknown>) => {
  const { proposalEntryDate: _proposalEntryDate, expectedReturnDate: _expectedReturnDate, ...cleanPayload } = payload;
  const proposalDate = cleanPayload.proposalDate || _proposalEntryDate;
  const expectedCloseDate = cleanPayload.expectedCloseDate || _expectedReturnDate;

  return {
    ...cleanPayload,
    ...(proposalDate ? { proposalDate: new Date(new Date(String(proposalDate)).toISOString()) } : {}),
    ...(payload.followUpDate ? { followUpDate: new Date(new Date(String(payload.followUpDate)).toISOString()) } : {}),
    ...(expectedCloseDate ? { expectedCloseDate: new Date(new Date(String(expectedCloseDate)).toISOString()) } : {}),
    ...(payload.plantingForecastDate !== undefined
      ? {
          plantingForecastDate: payload.plantingForecastDate
            ? new Date(new Date(String(payload.plantingForecastDate)).toISOString())
            : null
        }
      : {}),
    ...(payload.lastContactAt !== undefined
      ? { lastContactAt: payload.lastContactAt ? new Date(new Date(String(payload.lastContactAt)).toISOString()) : null }
      : {})
  };
};

const CLIENT_SORT_FIELDS = new Set<keyof Prisma.ClientOrderByWithRelationInput>([
  "name",
  "city",
  "state",
  "region",
  "segment",
  "clientType",
  "createdAt"
]);

const parsePositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const agendaEventTypeSchema = z.enum(["reuniao_online", "reuniao_presencial", "roteiro_visita", "followup"]);
const agendaEventStatusSchema = z.enum(["planned", "completed", "cancelled"]);

const mapAgendaStatusToDb = (status: "planned" | "completed" | "cancelled") => {
  if (status === "completed") return "realizado" as const;
  if (status === "cancelled") return "vencido" as const;
  return "agendado" as const;
};

const mapAgendaStatusFromDb = (status: string): "planned" | "completed" | "cancelled" => {
  if (status === "realizado") return "completed";
  if (status === "vencido") return "cancelled";
  return "planned";
};

const AGENDA_TIMELINE_LABEL: Record<"reuniao_online" | "reuniao_presencial" | "roteiro_visita" | "followup", string> = {
  reuniao_online: "Reunião online agendada",
  reuniao_presencial: "Reunião presencial agendada",
  roteiro_visita: "Roteiro de visita planejado",
  followup: "Follow-up agendado"
};

const buildAgendaCreatedDescription = (event: { type: "reuniao_online" | "reuniao_presencial" | "roteiro_visita" | "followup"; title: string }) => {
  const baseLabel = AGENDA_TIMELINE_LABEL[event.type] || "Compromisso agendado";
  return `${baseLabel}: ${event.title}`;
};

const buildAgendaStatusDescription = (
  status: "completed" | "cancelled",
  event: { type: "reuniao_online" | "reuniao_presencial" | "roteiro_visita" | "followup"; title: string }
) => {
  const base = status === "completed" ? "Compromisso concluído" : "Compromisso cancelado";
  return `${base}: ${event.title} (${AGENDA_TIMELINE_LABEL[event.type]})`;
};

const agendaEventCreateSchema = z.object({
  title: z.string().min(2),
  type: agendaEventTypeSchema,
  startDateTime: z.string().optional(),
  endDateTime: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  ownerId: z.string().optional(),
  ownerSellerId: z.string().optional(),
  sellerId: z.string().optional(),
  clientId: z.string().optional(),
  city: z.string().optional(),
  notes: z.string().optional(),
  opportunityId: z.string().optional(),
  stops: z
    .array(
      z.object({
        clientId: z.string().optional(),
        city: z.string().optional(),
        address: z.string().optional(),
        plannedTime: z.string().optional(),
        notes: z.string().optional()
      })
    )
    .optional()
});

const agendaEventUpdateSchema = z.object({
  title: z.string().min(2).optional(),
  startDateTime: z.string().optional(),
  endDateTime: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  notes: z.string().optional(),
  city: z.string().optional(),
  status: agendaEventStatusSchema.optional(),
  opportunityId: z.string().optional()
});

const agendaStopCreateSchema = z.object({
  clientId: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  plannedTime: z.string().optional(),
  notes: z.string().optional()
});

const agendaStopReorderSchema = z.object({
  stopIds: z.array(z.string()).min(1)
});

const agendaStopGeoSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracy: z.number().positive().optional(),
  timestamp: z.string().datetime().optional()
});

const agendaStopResultSchema = z.object({
  status: z.enum(["realizada", "nao_realizada"]),
  reason: z.enum(["cliente_ausente", "chuva", "estrada", "reagendar", "outro"]).optional(),
  summary: z.string().max(240).optional(),
  nextStep: z.enum(["criar_followup", "criar_oportunidade", "reagendar"]).optional(),
  nextStepDate: z.string().optional()
});

const parseClientSort = (sortValue?: string): Prisma.ClientOrderByWithRelationInput => {
  if (!sortValue) return { createdAt: "desc" };

  const [rawField, rawDirection] = sortValue.trim().split(/\s+/, 2);
  const field = rawField as keyof Prisma.ClientOrderByWithRelationInput;
  const direction = rawDirection?.toLowerCase() === "asc" ? "asc" : "desc";

  if (!CLIENT_SORT_FIELDS.has(field)) return { createdAt: "desc" };

  return { [field]: direction };
};

const clientExistsBulkItemSchema = z
  .object({
    cnpjDigits: z.string().trim().optional(),
    fallbackKey: z.string().trim().optional()
  })
  .refine((value) => Boolean(value.cnpjDigits || value.fallbackKey), {
    message: "Informe cnpjDigits ou fallbackKey."
  });

const clientExistsBulkRequestSchema = z.object({
  keys: z.array(clientExistsBulkItemSchema).max(5000),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(500).optional()
});

const buildFallbackKey = (name?: string | null, city?: string | null, state?: string | null) => {
  const nameNormalized = normalizeText(name);
  const cityNormalized = normalizeText(city);
  const stateNormalized = normalizeState(state);
  return `${nameNormalized}|${cityNormalized}|${stateNormalized}`;
};

const paginateArray = <T>(items: T[], page: number, pageSize: number) => {
  const total = items.length;
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return {
    data: items.slice(start, end),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
};

// ==============================
// ✅ IMPORTAÇÃO DE CLIENTES (dedup + preview + ações)
// ==============================

const DUPLICATE_CLIENT_MESSAGE = "Cliente já cadastrado no sistema.";

const isDatabaseUniqueViolation = (error: unknown) => {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
};

const isDatabaseForeignKeyViolation = (error: unknown) => {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
};

type DuplicateClientMatchType = "code" | "cnpj" | "identity";

type DuplicateClientSummary = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  cnpj: string | null;
  code?: string | null;
};

class DuplicateClientError extends Error {
  statusCode: number;
  existingClient: DuplicateClientSummary;
  matchType: DuplicateClientMatchType;

  constructor(existingClient: DuplicateClientSummary, matchType: DuplicateClientMatchType, message?: string) {
    super(message ?? (matchType === "cnpj"
      ? `Já existe um cliente com este CNPJ: ${existingClient.name}${existingClient.city && existingClient.state ? ` (${existingClient.city}/${existingClient.state})` : ""}.`
      : matchType === "code"
        ? `Já existe um cliente com este código ERP: ${existingClient.name}${existingClient.code ? ` (${existingClient.code})` : ""}.`
        : DUPLICATE_CLIENT_MESSAGE));
    this.name = "DuplicateClientError";
    this.statusCode = 409;
    this.existingClient = existingClient;
    this.matchType = matchType;
  }
}

const normalizeClientForComparison = (client: {
  name?: string | null;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
  code?: string | null;
}) => ({
  code: String(client.code ?? "").trim(),
  nameNormalized: normalizeText(client.name),
  cityNormalized: normalizeText(client.city),
  state: normalizeState(client.state),
  cnpjNormalized: normalizeCnpj(client.cnpj)
});

const findDuplicateClient = async ({
  candidate,
  scope,
  ignoreClientId
}: {
  candidate: { name?: string | null; city?: string | null; state?: string | null; cnpj?: string | null; code?: string | null };
  scope: Prisma.ClientWhereInput;
  ignoreClientId?: string;
}) => {
  const normalized = normalizeClientForComparison(candidate);

  if (normalized.code) {
    const existingByCode = await prisma.client.findFirst({
      where: { code: normalized.code, isArchived: false, ...(ignoreClientId ? { id: { not: ignoreClientId } } : {}) },
      select: { id: true, name: true, city: true, state: true, cnpj: true, code: true },
    });
    if (existingByCode) {
      return {
        matchType: "code" as const,
        existingClient: {
          id: existingByCode.id,
          name: existingByCode.name,
          city: existingByCode.city,
          state: existingByCode.state,
          cnpj: existingByCode.cnpj,
          code: existingByCode.code,
        },
      };
    }
  }

  if (normalized.cnpjNormalized) {
    const existingByCnpj = await prisma.client.findFirst({
      where: {
        OR: [{ cnpjNormalized: normalized.cnpjNormalized }, ...(candidate.cnpj ? [{ cnpj: candidate.cnpj }] : [])],
        isArchived: false,
        ...(ignoreClientId ? { id: { not: ignoreClientId } } : {}),
      },
      select: { id: true, name: true, city: true, state: true, cnpj: true, code: true },
    });
    if (existingByCnpj) {
      return {
        matchType: "cnpj" as const,
        existingClient: {
          id: existingByCnpj.id,
          name: existingByCnpj.name,
          city: existingByCnpj.city,
          state: existingByCnpj.state,
          cnpj: existingByCnpj.cnpj,
          code: existingByCnpj.code,
        },
      };
    }
  }

  const existingClients = await prisma.client.findMany({
    where: {
      ...scope,
      isArchived: false,
      ...(ignoreClientId ? { id: { not: ignoreClientId } } : {})
    },
    select: {
      id: true,
      name: true,
      city: true,
      state: true,
      cnpj: true,
      code: true,
      nameNormalized: true,
      cityNormalized: true,
      cnpjNormalized: true
    }
  });


  const existingByIdentity = existingClients.find((existing) => {
    const existingNameNormalized = existing.nameNormalized || normalizeText(existing.name);
    const existingCityNormalized = existing.cityNormalized || normalizeText(existing.city);
    const existingStateNormalized = normalizeState(existing.state);

    return (
      existingNameNormalized === normalized.nameNormalized &&
      existingCityNormalized === normalized.cityNormalized &&
      existingStateNormalized === normalized.state
    );
  });

  if (!existingByIdentity) return null;

  return {
    matchType: "identity" as const,
    existingClient: {
      id: existingByIdentity.id,
      name: existingByIdentity.name,
      city: existingByIdentity.city,
      state: existingByIdentity.state,
      cnpj: existingByIdentity.cnpj,
      code: existingByIdentity.code
    }
  };
};

const ensureClientIsNotDuplicate = async (params: {
  candidate: { name?: string | null; city?: string | null; state?: string | null; cnpj?: string | null; code?: string | null };
  scope: Prisma.ClientWhereInput;
  ignoreClientId?: string;
}) => {
  const duplicate = await findDuplicateClient(params);
  if (duplicate) throw new DuplicateClientError(duplicate.existingClient, duplicate.matchType);
};

const withClientNormalizedFields = <T extends { name?: string; city?: string; state?: string; cnpj?: string | null }>(payload: T) => {
  const normalized = normalizeClientForComparison(payload);
  return {
    ...payload,
    state: normalized.state,
    nameNormalized: normalized.nameNormalized,
    cityNormalized: normalized.cityNormalized,
    cnpjNormalized: normalized.cnpjNormalized || null
  };
};

const clientImportActionSchema = z.enum(["update", "skip", "import_anyway"]).optional();

const clientImportRowSchema = clientSchema
  .extend({
    sourceRowNumber: z.number().int().positive().optional(),
    existingClientId: z.string().optional(),
    action: clientImportActionSchema,
    code_erp: z.string().optional(),
    codigo_erp: z.string().optional(),
    nome_fantasia: z.string().optional(),
    fantasy_name: z.string().optional(),
    fantasia: z.string().optional(),
    cnpj_cpf: z.string().optional(),
    cnpjCpf: z.string().optional(),
    ownerSellerName: z.string().optional(),
    ownerSeller: z.string().optional(),
    vendedor_responsavel: z.string().optional(),
    vendedor_responsavel_id: z.string().optional(),
    lastPurchaseDate: z.string().optional(),
    last_purchase_date: z.string().optional(),
    lastPurchaseValue: z.union([z.number(), z.string()]).optional(),
    last_purchase_value: z.union([z.number(), z.string()]).optional(),
    erpUpdatedAt: z.string().optional(),
    erp_updated_at: z.string().optional()
  })
  .transform((row) => {
    const ownerFromName = typeof row.ownerSellerName === "string" ? row.ownerSellerName : undefined;
    const ownerFromAlias = typeof row.ownerSeller === "string" ? row.ownerSeller : undefined;
    const ownerFromLabel = typeof row.vendedor_responsavel === "string" ? row.vendedor_responsavel : undefined;
    const ownerFromLegacy = typeof row.vendedor_responsavel_id === "string" ? row.vendedor_responsavel_id : undefined;

    return {
      ...row,
      ownerSellerId: row.ownerSellerId ?? ownerFromName ?? ownerFromAlias ?? ownerFromLabel ?? ownerFromLegacy,
      code: row.code ?? row.code_erp ?? row.codigo_erp,
      fantasyName: row.fantasyName ?? row.nome_fantasia ?? row.fantasy_name ?? row.fantasia,
      cnpj: row.cnpj ?? row.cnpj_cpf ?? row.cnpjCpf,
      lastPurchaseDate: row.lastPurchaseDate ?? row.last_purchase_date,
      lastPurchaseValue: row.lastPurchaseValue ?? row.last_purchase_value,
      erpUpdatedAt: row.erpUpdatedAt ?? row.erp_updated_at
    };
  });

const clientImportRequestSchema = z.object({
  rows: z.array(z.unknown()).optional(),
  clients: z.array(z.unknown()).optional()
});

const resolveImportRows = (body: unknown) => {
  const parsed = clientImportRequestSchema.safeParse(body);
  if (!parsed.success) return { rows: [] as unknown[], isValid: false };
  const rows = parsed.data.rows ?? parsed.data.clients ?? [];
  return { rows, isValid: true };
};

const opportunityImportStageSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ["prospeccao", "negociacao", "proposta", "ganho", "prospecting", "negotiation", "proposal", "won"].includes(value), {
    message: "Etapa inválida para importação."
  });

const opportunityImportStatusSchema = z.enum(["open", "closed"]).optional();

const parseOpportunityImportDate = (value?: string) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) {
    const normalized = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00.000Z`;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const brMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (brMatch) {
    const normalized = `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}T00:00:00.000Z`;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

const opportunityImportRowSchema = z
  .object({
    title: z.string().min(1),
    clientNameOrId: z.string().min(1),
    value: z.number().positive(),
    stage: opportunityImportStageSchema,
    status: opportunityImportStatusSchema,
    ownerEmail: z.string().email().optional(),
    ownerSellerName: z.string().optional(),
    cnpj: z.string().optional(),
    cnpj_cliente: z.string().optional(),
    documento_cliente: z.string().optional(),
    city: z.string().optional(),
    cidade: z.string().optional(),
    cidade_cliente: z.string().optional(),
    vendedor_responsavel: z.string().optional(),
    email_responsavel: z.string().email().optional(),
    responsavelEmail: z.string().email().optional(),
    followUpDate: z.string().optional(),
    followUp: z.string().optional(),
    proposalDate: z.string().optional(),
    data_entrada: z.string().optional(),
    expectedCloseDate: z.string().optional(),
    fechamento_previsto: z.string().optional(),
    lastContactAt: z.string().optional(),
    ultimo_contato: z.string().optional(),
    probability: z.number().int().min(0).max(100),
    notes: z.string().max(2000).optional(),
    areaHa: z.number().nonnegative().optional(),
    area_ha: z.number().nonnegative().optional(),
    expectedTicketPerHa: z.number().nonnegative().optional(),
    ticket_esperado_ha: z.number().nonnegative().optional(),
    crop: z.string().optional(),
    cultura: z.string().optional(),
    season: z.string().optional(),
    safra: z.string().optional(),
    productOffered: z.string().optional(),
    produto_ofertado: z.string().optional()
  })
  .transform((row) => ({
    ...row,
    ownerEmail: row.ownerEmail ?? row.email_responsavel ?? row.responsavelEmail,
    ownerSellerName: row.ownerSellerName ?? row.vendedor_responsavel,
    cnpj: row.cnpj ?? row.cnpj_cliente ?? row.documento_cliente,
    city: row.city ?? row.cidade ?? row.cidade_cliente,
    followUpDate: row.followUpDate ?? row.followUp,
    proposalDate: row.proposalDate ?? row.data_entrada,
    expectedCloseDate: row.expectedCloseDate ?? row.fechamento_previsto,
    lastContactAt: row.lastContactAt ?? row.ultimo_contato,
    areaHa: row.areaHa ?? row.area_ha,
    expectedTicketPerHa: row.expectedTicketPerHa ?? row.ticket_esperado_ha,
    crop: row.crop ?? row.cultura,
    season: row.season ?? row.safra,
    productOffered: row.productOffered ?? row.produto_ofertado
  }));


const opportunityInsightRequestSchema = z.object({
  opportunityId: z.string().min(1)
});

const opportunityImportPayloadSchema = z.object({
  rows: z.array(z.unknown()).default([]),
  options: z
    .object({
      createClientIfMissing: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      dedupe: z
        .object({
          enabled: z.boolean(),
          windowDays: z.number().int().min(7).max(180),
          compareStatuses: z.enum(["open_only", "open_and_closed"]),
          mode: z.enum(["skip", "upsert"])
        })
        .optional()
    })
    .optional()
});

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const IMPORT_STAGE_MAP: Record<string, "prospeccao" | "negociacao" | "proposta" | "ganho"> = {
  prospeccao: "prospeccao",
  prospecting: "prospeccao",
  negociacao: "negociacao",
  negotiation: "negociacao",
  proposta: "proposta",
  proposal: "proposta",
  ganho: "ganho",
  won: "ganho"
};

const DEFAULT_OPPORTUNITY_IMPORT_DEDUPE = {
  enabled: true,
  windowDays: 30,
  compareStatuses: "open_only" as const,
  mode: "skip" as const
};

type OpportunityImportDedupeOptions = {
  enabled: boolean;
  windowDays: number;
  compareStatuses: "open_only" | "open_and_closed";
  mode: "skip" | "upsert";
};

const normalizeOpportunityTitle = (value?: string | null) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeSellerLookup = (value?: string | null) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const normalizeSellerEmail = (value?: string | null) => String(value ?? "").toLowerCase().trim();

const normalizeClientLookup = (value?: string | null) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

type ImportClientCandidate = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  cnpj: string | null;
  normalizedName: string;
  normalizedCity: string;
  normalizedState: string;
  normalizedCnpj: string;
};

const toImportClientCandidate = (client: { id: string; name: string; city?: string | null; state?: string | null; cnpj?: string | null }): ImportClientCandidate => ({
  id: client.id,
  name: client.name,
  city: client.city ?? null,
  state: client.state ?? null,
  cnpj: client.cnpj ?? null,
  normalizedName: normalizeClientLookup(client.name),
  normalizedCity: normalizeClientLookup(client.city),
  normalizedState: normalizeClientLookup(client.state),
  normalizedCnpj: normalizeCnpj(client.cnpj)
});

const resolveClientSmart = (
  input: { clientNameOrId: string; cnpj?: string; city?: string; state?: string },
  clients: ImportClientCandidate[]
) => {
  const rawLookup = input.clientNameOrId.trim();
  const normalizedLookup = normalizeClientLookup(rawLookup);
  const normalizedInputCity = normalizeClientLookup(input.city);
  const normalizedInputState = normalizeClientLookup(input.state);
  const normalizedInputCnpj = normalizeCnpj(input.cnpj);

  if (UUID_V4_REGEX.test(rawLookup)) {
    const uuidMatches = clients.filter((client) => client.id === rawLookup);
    if (uuidMatches.length === 1) return { status: "resolved" as const, client: uuidMatches[0] };
    if (uuidMatches.length > 1) return { status: "ambiguous" as const, candidates: uuidMatches };
    return { status: "not_found" as const };
  }

  if (normalizedInputCnpj) {
    const cnpjMatches = clients.filter((client) => client.normalizedCnpj && client.normalizedCnpj === normalizedInputCnpj);
    if (cnpjMatches.length === 1) return { status: "resolved" as const, client: cnpjMatches[0] };
    if (cnpjMatches.length > 1) return { status: "ambiguous" as const, candidates: cnpjMatches };
    return { status: "not_found" as const };
  }

  const nameMatches = normalizedLookup ? clients.filter((client) => client.normalizedName === normalizedLookup) : [];
  if (normalizedInputCity) {
    const nameAndCityMatches = nameMatches.filter((client) => client.normalizedCity === normalizedInputCity);
    if (nameAndCityMatches.length === 1) return { status: "resolved" as const, client: nameAndCityMatches[0] };
    if (nameAndCityMatches.length > 1) return { status: "ambiguous" as const, candidates: nameAndCityMatches };
  }

  if (normalizedInputState) {
    const nameAndStateMatches = nameMatches.filter((client) => client.normalizedState === normalizedInputState);
    if (nameAndStateMatches.length === 1) return { status: "resolved" as const, client: nameAndStateMatches[0] };
    if (nameAndStateMatches.length > 1) return { status: "ambiguous" as const, candidates: nameAndStateMatches };
  }

  if (!nameMatches.length) return { status: "not_found" as const };
  if (nameMatches.length > 1) return { status: "ambiguous" as const, candidates: nameMatches };
  return { status: "resolved" as const, client: nameMatches[0] };
};

const resolveOpportunityOwner = ({
  ownerEmail,
  ownerSellerName,
  ownersByEmail,
  ownersByName,
  fallbackOwnerId
}: {
  ownerEmail?: string;
  ownerSellerName?: string;
  ownersByEmail: Map<string, { id: string; email: string; name: string }>;
  ownersByName: Map<string, { id: string; email: string; name: string }>;
  fallbackOwnerId: string;
}) => {
  const normalizedEmail = normalizeSellerEmail(ownerEmail);
  const normalizedName = normalizeSellerLookup(ownerSellerName);

  const ownerByEmail = normalizedEmail ? ownersByEmail.get(normalizedEmail) : undefined;
  const ownerByName = normalizedName ? ownersByName.get(normalizedName) : undefined;

  if (ownerByEmail && ownerByName && ownerByEmail.id !== ownerByName.id) {
    return {
      success: false as const,
      message: "conflito entre vendedor_responsavel e email_responsavel (conflito de identificação do vendedor)"
    };
  }

  if (normalizedEmail) {
    if (ownerByEmail) return { success: true as const, ownerSellerId: ownerByEmail.id };
    if (!normalizedName) return { success: false as const, message: "vendedor não encontrado por e-mail" };
  }

  if (normalizedName) {
    if (ownerByName) return { success: true as const, ownerSellerId: ownerByName.id };
    return { success: false as const, message: "vendedor não encontrado por nome" };
  }

  return { success: true as const, ownerSellerId: fallbackOwnerId };
};

const isLikelyOpportunityTitleDuplicate = (candidate: string, existing: string) => {
  if (!candidate || !existing) return false;
  if (candidate === existing) return true;

  const longer = candidate.length >= existing.length ? candidate : existing;
  const shorter = longer === candidate ? existing : candidate;

  if (shorter.length >= 12 && longer.includes(shorter)) return true;
  return false;
};

type ImportPreviewItem =
  | {
      rowNumber: number;
      row: any;
      status: "error";
      error: string;
    }
  | {
      rowNumber: number;
      row: any;
      status: "duplicate";
      existingClientId: string;
      payload: any;
      reason: string;
    }
  | {
      rowNumber: number;
      row: any;
      status: "new";
      payload: any;
    };

const buildDuplicateFingerprint = (payload: { cnpj?: string | null; name?: string | null; city?: string | null; state?: string | null }) => {
  const doc = normalizeCnpj(payload.cnpj);
  if (doc) return `doc:${doc}`;
  const name = normalizeText(payload.name);
  const city = normalizeText(payload.city);
  const uf = normalizeState(payload.state);
  return `n:${name}|c:${city}|s:${uf}`;
};

const normalizeClientCode = (value?: string | null) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const isEmptyValue = (value?: string | null) => !value || !String(value).trim();

const isMeaningfulImportString = (value: unknown) => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed !== "-";
};

const parseImportOptionalNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseImportOptionalDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoDate) {
    const parsed = new Date(`${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const brDate = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (brDate) {
    const parsed = new Date(`${brDate[3]}-${brDate[2]}-${brDate[1]}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const resolveImportCreateData = (payload: z.infer<typeof clientImportRowSchema>, req: any) => {
  const ownerSellerId =
    req.user?.role === "vendedor"
      ? req.user.id
      : typeof payload.ownerSellerId === "string" && payload.ownerSellerId.trim()
        ? payload.ownerSellerId.trim()
        : resolveOwnerId(req);

  const fantasyName = payload.fantasyName?.trim();
  const code = payload.code?.trim();
  const lastPurchaseDate = parseImportOptionalDate(payload.lastPurchaseDate);
  const lastPurchaseValue = parseImportOptionalNumber(payload.lastPurchaseValue);
  const erpUpdatedAt = parseImportOptionalDate(payload.erpUpdatedAt);

  const data = {
    name: payload.name.trim(),
    ...(fantasyName ? { fantasyName } : {}),
    ...(code ? { code } : {}),
    city: payload.city.trim(),
    state: payload.state.trim(),
    region: payload.region.trim(),
    ownerSellerId,
    ...(typeof payload.segment === "string" && isMeaningfulImportString(payload.segment) ? { segment: payload.segment.trim() } : {}),
    ...(typeof payload.clientType === "string" && isMeaningfulImportString(payload.clientType)
      ? { clientType: payload.clientType.trim().toUpperCase() as ClientType }
      : {}),
    ...(typeof payload.cnpj === "string" && isMeaningfulImportString(payload.cnpj) ? { cnpj: payload.cnpj.trim() } : {}),
    ...(typeof payload.potentialHa === "number" && Number.isFinite(payload.potentialHa) && payload.potentialHa >= 0
      ? { potentialHa: payload.potentialHa }
      : {}),
    ...(typeof payload.farmSizeHa === "number" && Number.isFinite(payload.farmSizeHa) && payload.farmSizeHa >= 0
      ? { farmSizeHa: payload.farmSizeHa }
      : {}),
    ...(lastPurchaseDate ? { lastPurchaseDate } : {}),
    ...(typeof lastPurchaseValue === "number" ? { lastPurchaseValue } : {}),
    ...(erpUpdatedAt ? { erpUpdatedAt } : {})
  };

  return withClientNormalizedFields(data);
};

const getImportPersistenceErrorMessage = (error: unknown) => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return "Cliente duplicado.";
    if (error.code === "P2003") return "Vendedor responsável não encontrado.";
    return `Falha de banco (${error.code}).`;
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return `Dados inválidos para persistência: ${error.message.split("\n")[0] ?? "erro de validação."}`;
  }

  if (error instanceof Error && error.message.trim()) return error.message;
  return "Erro interno ao criar cliente.";
};

const resolveImportUpdateData = (payload: z.infer<typeof clientImportRowSchema>, _req: any, existingClient: any) => {
  const data: Record<string, unknown> = {};
  const fantasyName = payload.fantasyName?.trim();
  const code = payload.code?.trim();

  if (isMeaningfulImportString(payload.city) && isEmptyValue(existingClient.city)) data.city = payload.city.trim();
  if (isMeaningfulImportString(payload.state) && isEmptyValue(existingClient.state)) data.state = payload.state.trim();
  if (isMeaningfulImportString(payload.region) && isEmptyValue(existingClient.region)) data.region = payload.region.trim();
  if (fantasyName && isEmptyValue(existingClient.fantasyName)) data.fantasyName = fantasyName;
  if (code && isEmptyValue(existingClient.code)) data.code = code;
  if (!existingClient.lastPurchaseDate) {
    const parsedLastPurchaseDate = parseImportOptionalDate(payload.lastPurchaseDate);
    if (parsedLastPurchaseDate) data.lastPurchaseDate = parsedLastPurchaseDate;
  }
  if (existingClient.lastPurchaseValue === null || existingClient.lastPurchaseValue === undefined) {
    const parsedLastPurchaseValue = parseImportOptionalNumber(payload.lastPurchaseValue);
    if (typeof parsedLastPurchaseValue === "number") data.lastPurchaseValue = parsedLastPurchaseValue;
  }
  if (!existingClient.erpUpdatedAt) {
    const parsedErpUpdatedAt = parseImportOptionalDate(payload.erpUpdatedAt);
    if (parsedErpUpdatedAt) data.erpUpdatedAt = parsedErpUpdatedAt;
  }

  const mergedClientForValidation = {
    name: existingClient.name,
    city: (data.city as string | undefined) ?? existingClient.city,
    state: (data.state as string | undefined) ?? existingClient.state,
    cnpj: existingClient.cnpj
  };

  const normalized = normalizeClientForComparison(mergedClientForValidation);
  const hasMeaningfulChanges = Object.keys(data).length > 0;

  return {
    data: hasMeaningfulChanges
      ? {
          ...data,
          state: normalized.state,
          nameNormalized: normalized.nameNormalized,
          cityNormalized: normalized.cityNormalized,
          cnpjNormalized: normalized.cnpjNormalized || null
        }
      : {},
    hasMeaningfulChanges,
    mergedClientForValidation
  };
};

const findImportExistingClient = (params: {
  payload: z.infer<typeof clientImportRowSchema>;
  byCnpj: Map<string, any>;
  byCode: Map<string, any>;
}) => {
  const { payload, byCnpj, byCode } = params;
  const normalizedCnpj = normalizeCnpj(payload.cnpj);
  if (normalizedCnpj) {
    const match = byCnpj.get(normalizedCnpj);
    if (match) return { match, reason: "cnpj" as const };
  }

  const normalizedCode = normalizeClientCode(payload.code);
  if (normalizedCode) {
    const match = byCode.get(normalizedCode);
    if (match) return { match, reason: "code" as const };
  }

  return { match: null, reason: null as null };
};

const buildImportPreview = async (req: any, rows: unknown[]): Promise<ImportPreviewItem[]> => {
  const scopedWhere = sellerWhere(req);

  // Carrega o mínimo necessário para deduplicação
  const existingClients = await prisma.client.findMany({
    where: { ...scopedWhere, isArchived: false },
    select: { id: true, cnpj: true, code: true, name: true, nameNormalized: true, city: true, state: true }
  });

  // Indexa base por cnpj, código ERP e nome (fallback cuidadoso)
  const existingByDoc = new Map<string, string>();
  const existingByCode = new Map<string, string>();
  const existingByName = new Map<string, string[]>();

  existingClients.forEach((c) => {
    const doc = normalizeCnpj(c.cnpj);
    if (doc) existingByDoc.set(doc, c.id);

    const code = normalizeClientCode(c.code);
    if (code) existingByCode.set(code, c.id);

    const normalizedName = c.nameNormalized || normalizeText(c.name);
    if (!normalizedName) return;
    const bucket = existingByName.get(normalizedName) || [];
    bucket.push(c.id);
    existingByName.set(normalizedName, bucket);
  });

  // Dedup dentro do arquivo
  const fileFingerprintCount = new Map<string, number>();

  const normalizeSellerName = (value?: string | null) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  const availableSellers = await prisma.user.findMany({
    where: { role: "vendedor" },
    select: { id: true, name: true }
  });

  const sellersByName = new Map<string, { id: string; name: string }>();
  const sellersById = new Map<string, { id: string; name: string }>();
  availableSellers.forEach((seller) => {
    sellersById.set(seller.id, seller);
    const normalized = normalizeSellerName(seller.name);
    if (!normalized || sellersByName.has(normalized)) return;
    sellersByName.set(normalized, seller);
  });

  // Primeiro passo: valida e resolve ownerSellerId, e computa fingerprints do arquivo
  const prepared = rows.map((row, index) => {
    const parsedRow = clientImportRowSchema.safeParse(row);
    const rowNumber = Number((row as any).sourceRowNumber ?? index + 2);

    if (!parsedRow.success) {
      const message = parsedRow.error.issues[0]?.message ?? "Dados inválidos para importação.";
      return { kind: "error" as const, rowNumber, row, error: message };
    }

    const ownerRaw = String(parsedRow.data.ownerSellerId ?? "").trim();

    let ownerSellerId: string;
    if (req.user!.role === "vendedor") {
      ownerSellerId = req.user!.id;
    } else if (req.user!.role === "gerente" || req.user!.role === "diretor") {
      if (!ownerRaw) {
        ownerSellerId = resolveOwnerId(req);
      } else {
        const sellerByName = sellersByName.get(normalizeSellerName(ownerRaw));
        if (sellerByName) {
          ownerSellerId = resolveOwnerId(req, sellerByName.id);
        } else if (sellersById.has(ownerRaw)) {
          ownerSellerId = resolveOwnerId(req, ownerRaw);
        } else if (UUID_V4_REGEX.test(ownerRaw)) {
          return {
            kind: "error" as const,
            rowNumber,
            row,
            error: `Vendedor responsável não encontrado: ${ownerRaw}`
          };
        } else {
          return {
            kind: "error" as const,
            rowNumber,
            row,
            error: `Vendedor responsável não encontrado: ${ownerRaw}`
          };
        }
      }
    } else {
      ownerSellerId = resolveOwnerId(req);
    }

    const payload = { ...parsedRow.data, ownerSellerId };
    const fp = buildDuplicateFingerprint(payload);

    fileFingerprintCount.set(fp, (fileFingerprintCount.get(fp) || 0) + 1);

    return { kind: "ok" as const, rowNumber, row, payload, fingerprint: fp };
  });

  // Segundo passo: aplica regras de duplicidade
  const items: ImportPreviewItem[] = prepared.map((p) => {
    if (p.kind === "error") {
      return { rowNumber: p.rowNumber, row: p.row, status: "error" as const, error: p.error };
    }

    // Duplicado dentro do arquivo
    if ((fileFingerprintCount.get(p.fingerprint) || 0) > 1) {
      return {
        rowNumber: p.rowNumber,
        row: p.row,
        status: "duplicate" as const,
        existingClientId: "",
        payload: p.payload,
        reason: "Duplicado dentro do arquivo"
      };
    }

    const doc = normalizeCnpj(p.payload.cnpj);
    const code = normalizeClientCode(p.payload.code);
    const normalizedName = normalizeText(p.payload.name);

    const matchedByCnpj = doc ? existingByDoc.get(doc) : null;
    const matchedByCode = !matchedByCnpj && code ? existingByCode.get(code) : null;
    const nameCandidates = !matchedByCnpj && !matchedByCode && normalizedName ? existingByName.get(normalizedName) || [] : [];
    const matchedByName = nameCandidates.length === 1 ? nameCandidates[0] : null;

    const existingId = matchedByCnpj || matchedByCode || matchedByName;
    if (existingId) {
      const reason = matchedByCnpj
        ? "Cliente já existe (CNPJ)"
        : matchedByCode
          ? "Cliente já existe (código ERP)"
          : "Cliente já existe (nome)";

      return {
        rowNumber: p.rowNumber,
        row: p.row,
        status: "duplicate" as const,
        existingClientId: existingId,
        payload: p.payload,
        reason
      };
    }

    return { rowNumber: p.rowNumber, row: p.row, status: "new" as const, payload: p.payload };
  });

  // Para duplicado no arquivo, tentamos inferir existingClientId se também bater na base (opcional)
  // (não é obrigatório para o frontend funcionar; update exige existingClientId, então a UI deve evitar update nesses casos)
  return items;
};

// ==============================
// Timeline helper
// ==============================

const createEvent = async ({
  type = "comentario",
  description,
  opportunityId,
  clientId,
  ownerSellerId
}: {
  type?: "comentario" | "mudanca_etapa" | "status";
  description: string;
  opportunityId?: string;
  clientId?: string;
  ownerSellerId: string;
}) => {
  const normalizedDescription = description.trim();
  if (!normalizedDescription) return null;

  const relatedOpportunityId = opportunityId || undefined;
  let relatedClientId = clientId || undefined;

  if (!relatedClientId && relatedOpportunityId) {
    const opportunity = await prisma.opportunity.findUnique({
      where: { id: relatedOpportunityId },
      select: { clientId: true }
    });
    relatedClientId = opportunity?.clientId;
  }

  return prisma.timelineEvent.create({
    data: {
      type,
      description: normalizedDescription,
      opportunityId: relatedOpportunityId,
      clientId: relatedClientId,
      ownerSellerId
    }
  });
};

const validateDateOrder = (proposalDate?: string, expectedCloseDate?: string) => {
  if (!proposalDate || !expectedCloseDate) return true;
  const proposal = normalizeDateToUtc(proposalDate);
  const expected = normalizeDateToUtc(expectedCloseDate);
  if (!proposal || !expected) return true;
  return expected >= proposal;
};

type OpportunityImportSkippedReason =
  | "duplicate"
  | "duplicate_file"
  | "client_missing"
  | "client_ambiguous"
  | "owner_missing"
  | "owner_conflict"
  | "invalid_row"
  | "invalid_stage"
  | "invalid_status"
  | "invalid_date"
  | "forbidden_owner"
  | "unexpected_error";

type OpportunityImportRowResult = {
  row: number;
  status: "created" | "updated" | "ignored" | "error";
  reason?: OpportunityImportSkippedReason;
  message?: string;
  matchedId?: string;
  matchedTitle?: string;
  matchedClientName?: string;
  matchedCreatedAt?: string;
};

const OPPORTUNITY_IMPORT_BATCH_SIZE = 50;

const buildOpportunityImportReportCsv = (rowResults: OpportunityImportRowResult[]) => {
  const escapeCsv = (value: unknown) => {
    const text = String(value ?? "");
    if (!/[",\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
  };

  const lines = [
    ["row", "status", "reason", "message", "matchedId", "matchedTitle", "matchedClientName", "matchedCreatedAt"].join(",")
  ];

  for (const row of rowResults) {
    lines.push(
      [
        row.row,
        row.status,
        row.reason ?? "",
        row.message ?? "",
        row.matchedId ?? "",
        row.matchedTitle ?? "",
        row.matchedClientName ?? "",
        row.matchedCreatedAt ?? ""
      ]
        .map(escapeCsv)
        .join(",")
    );
  }

  return lines.join("\n");
};

const processOpportunityImport = async ({
  req,
  rows,
  createClientIfMissing,
  dryRun,
  dedupe
}: {
  req: any;
  rows: unknown[];
  createClientIfMissing: boolean;
  dryRun: boolean;
  dedupe: OpportunityImportDedupeOptions;
}) => {
  const errors: Array<{ row: number; message: string }> = [];
  const rowResults: OpportunityImportRowResult[] = [];
  const skippedDetails: Array<{ row: number; reason: OpportunityImportSkippedReason; matchedId?: string; matchedTitle?: string; matchedClientName?: string; matchedCreatedAt?: string }> = [];
  let created = 0;
  let updated = 0;
  let ignored = 0;
  let failed = 0;

  const parsedRows = rows.map((rawRow, index) => ({ rowNumber: index + 1, parsed: opportunityImportRowSchema.safeParse(rawRow) }));

  const ownerEmails = new Set<string>();
  const ownerNames = new Set<string>();
  const clientIds = new Set<string>();
  const clientNames = new Set<string>();
  const duplicateFileKeySeen = new Set<string>();

  for (const item of parsedRows) {
    if (!item.parsed.success) continue;
    const row = item.parsed.data;

    const email = normalizeSellerEmail(row.ownerEmail);
    const name = normalizeSellerLookup(row.ownerSellerName);
    if (email) ownerEmails.add(email);
    if (name) ownerNames.add(name);

    const clientLookup = row.clientNameOrId.trim();
    if (UUID_V4_REGEX.test(clientLookup)) clientIds.add(clientLookup);
    else clientNames.add(clientLookup);
  }

  const ownersByEmail = new Map<string, { id: string; email: string; name: string }>();
  const ownersByName = new Map<string, { id: string; email: string; name: string }>();

  if (ownerEmails.size || ownerNames.size) {
    const users = await prisma.user.findMany({
      where: { role: "vendedor" },
      select: { id: true, email: true, name: true }
    });

    for (const owner of users) {
      ownersByEmail.set(normalizeSellerEmail(owner.email), owner);
      ownersByName.set(normalizeSellerLookup(owner.name), owner);
    }
  }

  const clientsById = new Map<string, ImportClientCandidate>();
  const clientCandidates: ImportClientCandidate[] = [];
  const upsertClientCandidate = (client: { id: string; name: string; city?: string | null; state?: string | null; cnpj?: string | null }) => {
    const candidate = toImportClientCandidate(client);
    if (clientsById.has(candidate.id)) {
      clientsById.set(candidate.id, candidate);
      const existingIndex = clientCandidates.findIndex((item) => item.id === candidate.id);
      if (existingIndex >= 0) clientCandidates[existingIndex] = candidate;
      return;
    }
    clientsById.set(candidate.id, candidate);
    clientCandidates.push(candidate);
  };

  if (clientIds.size || clientNames.size) {
    const clients = await prisma.client.findMany({
      where: {
        ...sellerWhere(req),
        isArchived: false,
        ...(clientIds.size && !clientNames.size ? { id: { in: Array.from(clientIds) } } : {})
      },
      select: { id: true, name: true, city: true, state: true, cnpj: true }
    });

    for (const client of clients) {
      upsertClientCandidate(client);
    }
  }

  const dedupeCandidatesCache = new Map<string, Array<{ id: string; title: string; createdAt: Date; ownerSellerId: string; client: { name: string } }>>();
  const previewCreatedClientsCache = new Map<string, ImportClientCandidate>();
  const logClientResolution = (
    rowNumber: number,
    rowInput: { clientNameOrId: string; cnpj?: string; city?: string; state?: string },
    resolution: ReturnType<typeof resolveClientSmart>
  ) => {
    console.info("[opportunities/import][client-resolver]", {
      phase: dryRun ? "preview" : "import",
      rowNumber,
      clientNameOrId: rowInput.clientNameOrId,
      cnpj: rowInput.cnpj,
      city: rowInput.city,
      state: rowInput.state,
      matchesCount: resolution.status === "ambiguous" ? resolution.candidates.length : resolution.status === "resolved" ? 1 : 0,
      resolvedClientId: resolution.status === "resolved" ? resolution.client.id : undefined,
      resolvedClientName: resolution.status === "resolved" ? resolution.client.name : undefined
    });
  };
  const validatedRows = parsedRows.filter(
    (item): item is { rowNumber: number; parsed: { success: true; data: z.infer<typeof opportunityImportRowSchema> } } => item.parsed.success
  );

  for (const item of parsedRows) {
    if (item.parsed.success) continue;
    const message = item.parsed.error.issues[0]?.message ?? "Linha inválida para importação.";
    failed += 1;
    errors.push({ row: item.rowNumber, message });
    skippedDetails.push({ row: item.rowNumber, reason: "invalid_row" });
    rowResults.push({ row: item.rowNumber, status: "error", reason: "invalid_row", message });
  }

  for (let batchStart = 0; batchStart < validatedRows.length; batchStart += OPPORTUNITY_IMPORT_BATCH_SIZE) {
    const batch = validatedRows.slice(batchStart, batchStart + OPPORTUNITY_IMPORT_BATCH_SIZE);

    for (const item of batch) {
      const rowNumber = item.rowNumber;
      const row = item.parsed.data;

      try {
        const ownerEmail = normalizeSellerEmail(row.ownerEmail);
        const ownerSellerName = normalizeSellerLookup(row.ownerSellerName);

        if (req.user?.role === "vendedor" && ownerEmail && ownerEmail !== req.user.email.toLowerCase()) {
          const message = "Vendedor só pode importar para o próprio e-mail ou sem ownerEmail.";
          failed += 1;
          errors.push({ row: rowNumber, message });
          skippedDetails.push({ row: rowNumber, reason: "forbidden_owner" });
          rowResults.push({ row: rowNumber, status: "error", reason: "forbidden_owner", message });
          continue;
        }

        const resolvedOwner = resolveOpportunityOwner({
          ownerEmail,
          ownerSellerName,
          ownersByEmail,
          ownersByName,
          fallbackOwnerId: req.user!.id
        });

        if (!resolvedOwner.success) {
          const reason = resolvedOwner.message.includes("conflito") ? "owner_conflict" : "owner_missing";
          failed += 1;
          errors.push({ row: rowNumber, message: resolvedOwner.message });
          skippedDetails.push({ row: rowNumber, reason });
          rowResults.push({ row: rowNumber, status: "error", reason, message: resolvedOwner.message });
          continue;
        }

        const ownerSellerId = resolvedOwner.ownerSellerId;
        const clientLookup = row.clientNameOrId.trim();
        const isUuid = UUID_V4_REGEX.test(clientLookup);
        const stageValue = row.stage ?? "prospeccao";
        const stage = IMPORT_STAGE_MAP[stageValue];

        if (!stage) {
          const message = "etapa inválida";
          failed += 1;
          errors.push({ row: rowNumber, message });
          skippedDetails.push({ row: rowNumber, reason: "invalid_stage" });
          rowResults.push({ row: rowNumber, status: "error", reason: "invalid_stage", message });
          continue;
        }

        if (row.status && !["open", "closed"].includes(row.status)) {
          const message = "status inválido";
          failed += 1;
          errors.push({ row: rowNumber, message });
          skippedDetails.push({ row: rowNumber, reason: "invalid_status" });
          rowResults.push({ row: rowNumber, status: "error", reason: "invalid_status", message });
          continue;
        }

        const parsedFollowUpDate = parseOpportunityImportDate(row.followUpDate);
        const parsedProposalDate = parseOpportunityImportDate(row.proposalDate);
        const parsedExpectedCloseDate = parseOpportunityImportDate(row.expectedCloseDate);
        const parsedLastContactAt = parseOpportunityImportDate(row.lastContactAt);

        if ((row.followUpDate && !parsedFollowUpDate) || (row.proposalDate && !parsedProposalDate) || (row.expectedCloseDate && !parsedExpectedCloseDate) || (row.lastContactAt && !parsedLastContactAt)) {
          const message = "data inválida";
          failed += 1;
          errors.push({ row: rowNumber, message });
          skippedDetails.push({ row: rowNumber, reason: "invalid_date" });
          rowResults.push({ row: rowNumber, status: "error", reason: "invalid_date", message });
          continue;
        }

        const followUpDate = parsedFollowUpDate ?? new Date();
        const proposalDate = parsedProposalDate ?? followUpDate;
        const expectedCloseDate = parsedExpectedCloseDate ?? followUpDate;
        const lastContactAt = parsedLastContactAt ?? undefined;

        if (!validateDateOrder(proposalDate.toISOString(), expectedCloseDate.toISOString())) {
          const message = "data inválida";
          failed += 1;
          errors.push({ row: rowNumber, message });
          skippedDetails.push({ row: rowNumber, reason: "invalid_date" });
          rowResults.push({ row: rowNumber, status: "error", reason: "invalid_date", message });
          continue;
        }

        const shouldPersist = !dryRun;
        const rowExecutionResult = await prisma.$transaction(async (tx) => {
          const resolverInput = { clientNameOrId: clientLookup, cnpj: row.cnpj, city: row.city };
          const resolvedClient = resolveClientSmart(resolverInput, clientCandidates);
          logClientResolution(rowNumber, resolverInput, resolvedClient);

          let client = resolvedClient.status === "resolved" ? resolvedClient.client : undefined;

          if (!client && resolvedClient.status !== "ambiguous") {
            const normalizedLookup = normalizeClientLookup(clientLookup);
            const normalizedCity = normalizeClientLookup(row.city);
            const normalizedCnpj = normalizeCnpj(row.cnpj);
            const existingClient = await tx.client.findFirst({
              where: {
                ...sellerWhere(req),
                ...(isUuid
                  ? { id: clientLookup }
                  : normalizedCnpj
                    ? { cnpjNormalized: normalizedCnpj }
                    : {
                        nameNormalized: normalizedLookup,
                        ...(normalizedCity ? { cityNormalized: normalizedCity } : {})
                      })
              },
              select: { id: true, name: true, city: true, state: true, cnpj: true }
            });

            if (existingClient) {
              upsertClientCandidate(existingClient);
              client = clientsById.get(existingClient.id);
            }
          }

          if (resolvedClient.status === "ambiguous") {
            return { outcome: "error", reason: "client_ambiguous", message: "cliente ambíguo" } as const;
          }

          if (!client && createClientIfMissing) {
            if (shouldPersist) {
              const createdClient = await tx.client.create({
                data: {
                  name: clientLookup,
                  city: "N/A",
                  state: "NA",
                  region: "Importação",
                  ownerSellerId
                },
                select: { id: true, name: true, city: true, state: true, cnpj: true }
              });
              upsertClientCandidate(createdClient);
              client = clientsById.get(createdClient.id);
            } else {
              const previewClientKey = [normalizeClientLookup(clientLookup), normalizeCnpj(row.cnpj), normalizeClientLookup(row.city)].join("|");
              if (!previewCreatedClientsCache.has(previewClientKey)) {
                const previewClient = toImportClientCandidate({
                  id: `preview-client-${previewCreatedClientsCache.size + 1}`,
                  name: clientLookup,
                  city: row.city ?? "N/A",
                  cnpj: row.cnpj
                });
                previewCreatedClientsCache.set(previewClientKey, previewClient);
                upsertClientCandidate(previewClient);
              }
              client = previewCreatedClientsCache.get(previewClientKey);
            }
          }

          if (!client) {
            return { outcome: "error", reason: "client_missing", message: "cliente não encontrado" } as const;
          }

          const normalizedTitle = normalizeOpportunityTitle(row.title);
          const duplicateFileKey = [client.id, normalizedTitle, stage, ownerSellerId].join("|");
          if (duplicateFileKeySeen.has(duplicateFileKey)) {
            return { outcome: "ignored", reason: "duplicate_file", message: "linha duplicada no arquivo" } as const;
          }

          let duplicateOpportunity: {
            id: string;
            title: string;
            createdAt: Date;
            client: { name: string };
            ownerSellerId: string;
          } | null = null;

          if (dedupe.enabled) {
            const cacheKey = `${client.id}|${ownerSellerId}|${stage}`;
            if (!dedupeCandidatesCache.has(cacheKey)) {
              const createdAtStart = new Date();
              createdAtStart.setDate(createdAtStart.getDate() - dedupe.windowDays);

              const candidates = await tx.opportunity.findMany({
                where: {
                  ...sellerWhere(req),
                  clientId: client.id,
                  ownerSellerId,
                  stage,
                  createdAt: { gte: createdAtStart },
                  ...(dedupe.compareStatuses === "open_only" ? { stage: { notIn: ["ganho", "perdido"] as OpportunityStage[] } } : {})
                },
                orderBy: { createdAt: "desc" },
                select: {
                  id: true,
                  title: true,
                  createdAt: true,
                  ownerSellerId: true,
                  client: { select: { name: true } }
                }
              });
              dedupeCandidatesCache.set(cacheKey, candidates);
            }

            const duplicateCandidates = dedupeCandidatesCache.get(cacheKey) ?? [];
            duplicateOpportunity = duplicateCandidates.find((candidate) => normalizeOpportunityTitle(candidate.title) === normalizedTitle) ?? null;
          }

          if (dedupe.enabled && duplicateOpportunity && dedupe.mode === "skip") {
            return {
              outcome: "ignored",
              reason: "duplicate",
              message: "duplicada no sistema",
              matchedId: duplicateOpportunity.id,
              matchedTitle: duplicateOpportunity.title,
              matchedClientName: duplicateOpportunity.client.name,
              matchedCreatedAt: duplicateOpportunity.createdAt.toISOString()
            } as const;
          }

          if (dedupe.enabled && duplicateOpportunity && dedupe.mode === "upsert") {
            if (shouldPersist) {
              const existingOpportunity = await tx.opportunity.findFirst({
                where: {
                  id: duplicateOpportunity.id,
                  ...sellerWhere(req)
                },
                select: { id: true, notes: true, ownerSellerId: true }
              });

              if (!existingOpportunity) throw new Error("Oportunidade duplicada não encontrada para atualização.");

              const notesWithTimestamp = row.notes
                ? `${existingOpportunity.notes ? `${existingOpportunity.notes}

` : ""}[Import ${new Date().toISOString()}] ${row.notes}`
                : existingOpportunity.notes;

              await tx.opportunity.update({
                where: { id: existingOpportunity.id },
                data: {
                  ...(typeof row.value === "number" ? { value: row.value } : {}),
                  ...(stage ? { stage } : {}),
                  ...(typeof row.probability === "number" ? { probability: row.probability } : {}),
                  ...(followUpDate ? { followUpDate } : {}),
                  ...(proposalDate ? { proposalDate } : {}),
                  ...(expectedCloseDate ? { expectedCloseDate } : {}),
                  ...(lastContactAt ? { lastContactAt } : {}),
                  ...(typeof row.areaHa === "number" ? { areaHa: row.areaHa } : {}),
                  ...(typeof row.expectedTicketPerHa === "number" ? { expectedTicketPerHa: row.expectedTicketPerHa } : {}),
                  ...(row.crop ? { crop: row.crop } : {}),
                  ...(row.season ? { season: row.season } : {}),
                  ...(row.productOffered ? { productOffered: row.productOffered } : {}),
                  ...(notesWithTimestamp !== undefined ? { notes: notesWithTimestamp } : {}),
                  ...(req.user?.role !== "vendedor" || existingOpportunity.ownerSellerId === req.user.id ? { ownerSellerId } : {})
                }
              });
            }

            return { outcome: "updated" } as const;
          }

          if (shouldPersist) {
            await tx.opportunity.create({
              data: {
                title: row.title,
                value: row.value,
                stage,
                probability: row.probability,
                notes: row.notes,
                proposalDate,
                followUpDate,
                expectedCloseDate,
                ...(lastContactAt ? { lastContactAt } : {}),
                ...(typeof row.areaHa === "number" ? { areaHa: row.areaHa } : {}),
                ...(typeof row.expectedTicketPerHa === "number" ? { expectedTicketPerHa: row.expectedTicketPerHa } : {}),
                ...(row.crop ? { crop: row.crop } : {}),
                ...(row.season ? { season: row.season } : {}),
                ...(row.productOffered ? { productOffered: row.productOffered } : {}),
                clientId: client.id,
                ownerSellerId
              }
            });
          }

          return { outcome: "created" } as const;
        });

        if (rowExecutionResult.outcome === "error") {
          failed += 1;
          errors.push({ row: rowNumber, message: rowExecutionResult.message });
          skippedDetails.push({ row: rowNumber, reason: rowExecutionResult.reason });
          rowResults.push({ row: rowNumber, status: "error", reason: rowExecutionResult.reason, message: rowExecutionResult.message });
          continue;
        }

        if (rowExecutionResult.outcome === "ignored") {
          ignored += 1;
          skippedDetails.push({
            row: rowNumber,
            reason: rowExecutionResult.reason,
            matchedId: rowExecutionResult.matchedId,
            matchedTitle: rowExecutionResult.matchedTitle,
            matchedClientName: rowExecutionResult.matchedClientName,
            matchedCreatedAt: rowExecutionResult.matchedCreatedAt
          });
          rowResults.push({
            row: rowNumber,
            status: "ignored",
            reason: rowExecutionResult.reason,
            message: rowExecutionResult.message,
            matchedId: rowExecutionResult.matchedId,
            matchedTitle: rowExecutionResult.matchedTitle,
            matchedClientName: rowExecutionResult.matchedClientName,
            matchedCreatedAt: rowExecutionResult.matchedCreatedAt
          });
          continue;
        }

        if (rowExecutionResult.outcome === "updated") {
          updated += 1;
          rowResults.push({ row: rowNumber, status: "updated" });
          continue;
        }

        created += 1;
        rowResults.push({ row: rowNumber, status: "created" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro inesperado na linha";
        failed += 1;
        errors.push({ row: rowNumber, message });
        skippedDetails.push({ row: rowNumber, reason: "unexpected_error" });
        rowResults.push({ row: rowNumber, status: "error", reason: "unexpected_error", message });
        console.warn(`[opportunities/import] linha ${rowNumber}: ${message}`);
      }
    }
  }

  const summary = {
    totalRows: rows.length,
    totalProcessed: created + updated + ignored + failed,
    imported: created,
    created,
    updated,
    ignored,
    failed
  };
  const reportCsv = buildOpportunityImportReportCsv(rowResults);

  return {
    created,
    updated,
    ignored,
    skipped: ignored + failed,
    failed,
    errors,
    skippedDetails,
    rowResults,
    summary,
    report: {
      fileName: `opportunities-import-report-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
      mimeType: "text/csv",
      content: reportCsv
    }
  };
};

// ==============================
// ROUTES
// ==============================

router.get("/reports/agro-crm", async (req, res) => {
  const parsedFilters = parseOpportunityFilterParams(req);
  if ("error" in parsedFilters) return res.status(400).json({ message: parsedFilters.error });

  const todayStart = getUtcTodayStart();
  const where = buildOpportunityWhere(
    req,
    {
      ...parsedFilters.params,
      status: "open"
    },
    todayStart
  );

  const opportunities = await prisma.opportunity.findMany({
    where,
    include: {
      client: {
        select: {
          id: true,
          name: true,
          potentialHa: true,
          farmSizeHa: true
        }
      },
      ownerSeller: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });

  const byCrop: Record<string, { value: number; weighted: number; count: number }> = {};
  const bySeason: Record<string, { value: number; weighted: number; count: number }> = {};
  const overdueBySeller: Record<
    string,
    { sellerId: string; sellerName: string; overdueCount: number; overdueValue: number }
  > = {};
  const byClient: Record<
    string,
    { clientId: string; clientName: string; weightedValue: number; value: number; opportunities: number }
  > = {};
  const byStage: Record<string, number> = {};
  const plantingWindow: Record<
    string,
    { month: string; opportunities: number; weightedValue: number; pipelineValue: number }
  > = {};
  const portfolioByPotential: Record<
    string,
    { clientId: string; clientName: string; potentialHa: number; farmSizeHa: number; opportunities: number; weightedValue: number }
  > = {};

  for (const opportunity of opportunities) {
    const weightedValue = getWeightedValue(opportunity.value, opportunity.probability);
    const cropKey = opportunity.crop || "não informado";
    const seasonKey = opportunity.season || "não informado";
    const stageKey = opportunity.stage;

    if (!byCrop[cropKey]) byCrop[cropKey] = { value: 0, weighted: 0, count: 0 };
    byCrop[cropKey].value += opportunity.value;
    byCrop[cropKey].weighted += weightedValue;
    byCrop[cropKey].count += 1;

    if (!bySeason[seasonKey]) bySeason[seasonKey] = { value: 0, weighted: 0, count: 0 };
    bySeason[seasonKey].value += opportunity.value;
    bySeason[seasonKey].weighted += weightedValue;
    bySeason[seasonKey].count += 1;

    byStage[stageKey] = (byStage[stageKey] || 0) + 1;

    const clientId = opportunity.client.id;
    if (!byClient[clientId]) {
      byClient[clientId] = {
        clientId,
        clientName: opportunity.client.name,
        weightedValue: 0,
        value: 0,
        opportunities: 0
      };
    }
    byClient[clientId].weightedValue += weightedValue;
    byClient[clientId].value += opportunity.value;
    byClient[clientId].opportunities += 1;

    if (!portfolioByPotential[clientId]) {
      portfolioByPotential[clientId] = {
        clientId,
        clientName: opportunity.client.name,
        potentialHa: Number(opportunity.client.potentialHa || 0),
        farmSizeHa: Number(opportunity.client.farmSizeHa || 0),
        opportunities: 0,
        weightedValue: 0
      };
    }
    portfolioByPotential[clientId].opportunities += 1;
    portfolioByPotential[clientId].weightedValue += weightedValue;

    if (opportunity.plantingForecastDate) {
      const month = opportunity.plantingForecastDate.toISOString().slice(0, 7);
      if (!plantingWindow[month]) {
        plantingWindow[month] = { month, opportunities: 0, weightedValue: 0, pipelineValue: 0 };
      }
      plantingWindow[month].opportunities += 1;
      plantingWindow[month].weightedValue += weightedValue;
      plantingWindow[month].pipelineValue += opportunity.value;
    }

    const isOverdue = isOpportunityOverdue(opportunity, todayStart);
    if (isOverdue) {
      const sellerId = opportunity.ownerSeller.id;
      if (!overdueBySeller[sellerId]) {
        overdueBySeller[sellerId] = {
          sellerId,
          sellerName: opportunity.ownerSeller.name,
          overdueCount: 0,
          overdueValue: 0
        };
      }
      overdueBySeller[sellerId].overdueCount += 1;
      overdueBySeller[sellerId].overdueValue += opportunity.value;
    }
  }

  const pipelineMetrics = calculatePipelineMetrics(opportunities, todayStart);

  const orderedStages = ["prospeccao", "negociacao", "proposta"];
  const stageConversion = orderedStages.slice(0, -1).map((stage, index) => {
    const nextStage = orderedStages[index + 1];
    const currentCount = byStage[stage] || 0;
    const nextCount = byStage[nextStage] || 0;
    return {
      fromStage: stage,
      toStage: nextStage,
      baseCount: currentCount,
      progressedCount: nextCount,
      conversionRate: currentCount > 0 ? (nextCount / currentCount) * 100 : 0
    };
  });

  res.json({
    summary: {
      pipelineTotal: pipelineMetrics.pipelineTotal,
      weightedTotal: pipelineMetrics.weightedTotal,
      overdueCount: pipelineMetrics.overdueCount,
      overdueValue: pipelineMetrics.overdueValue
    },
    kpis: {
      pipelineByCrop: Object.entries(byCrop)
        .map(([crop, values]) => ({ crop, ...values }))
        .sort((a, b) => b.weighted - a.weighted),
      pipelineBySeason: Object.entries(bySeason)
        .map(([season, values]) => ({ season, ...values }))
        .sort((a, b) => b.weighted - a.weighted),
      topClientsByWeightedValue: Object.values(byClient)
        .sort((a, b) => b.weightedValue - a.weightedValue)
        .slice(0, 10),
      overdueBySeller: Object.values(overdueBySeller).sort((a, b) => b.overdueCount - a.overdueCount),
      stageConversion
    },
    tables: {
      portfolioByPotentialHa: Object.values(portfolioByPotential)
        .map((row) => ({
          ...row,
          potentialCoveragePercent: row.farmSizeHa > 0 ? (row.potentialHa / row.farmSizeHa) * 100 : 0
        }))
        .sort((a, b) => b.potentialHa - a.potentialHa),
      opportunitiesByPlantingWindow: Object.values(plantingWindow).sort((a, b) => a.month.localeCompare(b.month))
    }
  });
});

router.get("/reports/planned-vs-realized", async (req, res) => {
  const fromRaw = req.query.from as string | undefined;
  const toRaw = req.query.to as string | undefined;
  const sellerIdRaw = req.query.sellerId as string | undefined;

  if (!fromRaw || !toRaw) {
    return res.status(400).json({ message: "Parâmetros from e to são obrigatórios." });
  }

  const from = normalizeDateToUtc(fromRaw);
  const to = normalizeDateToUtc(toRaw, true);

  if (!from || !to) {
    return res.status(400).json({ message: "Parâmetros from/to inválidos." });
  }

  const scopedSellerId = req.user?.role === "vendedor" ? req.user.id : sellerIdRaw;

  const [sellers, plannedEvents, executedActivities, followUps] = await Promise.all([
    prisma.user.findMany({
      where: {
        role: "vendedor",
        isActive: true,
        ...(scopedSellerId ? { id: scopedSellerId } : {})
      },
      select: { id: true, name: true }
    }),
    prisma.agendaEvent.findMany({
      where: {
        type: "roteiro_visita",
        startDateTime: { gte: from, lte: to },
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      select: {
        sellerId: true
      }
    }),
    prisma.activity.findMany({
      where: {
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
        done: true,
        ...resolveActivityTypeFilters("visita", "reuniao", "followup", "follow_up"),
        ...resolveExecutionActivityDateFilter(from, to)
      },
      select: {
        ownerSellerId: true,
        opportunityId: true,
        type: true,
        dueDate: true,
        createdAt: true
      }
    }),
    prisma.activity.findMany({
      where: {
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
        done: true,
        ...resolveActivityTypeFilters("followup", "follow_up"),
        ...resolveExecutionActivityDateFilter(from, to)
      },
      select: { ownerSellerId: true }
    })
  ]);

  const plannedBySeller = plannedEvents.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = (acc[item.sellerId] || 0) + 1;
    return acc;
  }, {});

  const executedBySeller = executedActivities.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const followUpsBySeller = followUps.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const opportunitiesBySeller = executedActivities.reduce<Record<string, Set<string>>>((acc, item) => {
    if (!item.opportunityId) return acc;
    if (!acc[item.ownerSellerId]) acc[item.ownerSellerId] = new Set<string>();
    acc[item.ownerSellerId].add(item.opportunityId);
    return acc;
  }, {});

  const sellerStatsMap = sellers.reduce<
    Record<
      string,
      {
        sellerId: string;
        sellerName: string;
        planned: number;
        executed: number;
        punctualCount: number;
      }
    >
  >((acc, seller) => {
    acc[seller.id] = {
      sellerId: seller.id,
      sellerName: seller.name,
      planned: plannedBySeller[seller.id] || 0,
      executed: executedBySeller[seller.id] || 0,
      punctualCount: executedBySeller[seller.id] || 0
    };
    return acc;
  }, {});

  const sellerRows = Object.values(sellerStatsMap).map((stats) => {
    const notExecuted = Math.max(stats.planned - stats.executed, 0);
    const followUpsCount = followUpsBySeller[stats.sellerId] || 0;
    const opportunitiesCount = opportunitiesBySeller[stats.sellerId]?.size || 0;
    const executionRate = stats.planned ? (stats.executed / stats.planned) * 100 : 0;
    const punctualRate = stats.executed ? (stats.punctualCount / stats.executed) * 100 : 0;

    return {
      sellerId: stats.sellerId,
      sellerName: stats.sellerName,
      planned: stats.planned,
      executed: stats.executed,
      notExecuted,
      executionRate,
      punctualRate,
      followUps: followUpsCount,
      opportunities: opportunitiesCount
    };
  });

  const totalPlanned = sellerRows.reduce((sum, item) => sum + item.planned, 0);
  const totalExecuted = sellerRows.reduce((sum, item) => sum + item.executed, 0);
  const totalNotExecuted = sellerRows.reduce((sum, item) => sum + item.notExecuted, 0);
  const totalPunctual = sellerRows.reduce((sum, item) => sum + (item.punctualRate / 100) * item.executed, 0);
  const followUpGenerated = sellerRows.reduce((sum, item) => sum + item.followUps, 0);
  const opportunitiesGenerated = sellerRows.reduce((sum, item) => sum + item.opportunities, 0);

  return res.json({
    totalPlanned,
    totalExecuted,
    totalNotExecuted,
    executionRate: totalPlanned ? (totalExecuted / totalPlanned) * 100 : 0,
    punctualRate: totalExecuted ? (totalPunctual / totalExecuted) * 100 : 0,
    followUpGenerated,
    opportunitiesGenerated,
    sellers: sellerRows.sort((a, b) => b.executionRate - a.executionRate)
  });
});

router.get("/reports/weekly-discipline", async (req, res) => {
  const range = getCurrentWeekRangeFromBrazilNow();
  const scopedSellerId = req.user?.role === "vendedor" ? req.user.id : undefined;
  const [minimumRequired, sellers, visitsBySeller] = await Promise.all([
    getWeeklyVisitGoal(),
    prisma.user.findMany({
      where: {
        role: "vendedor",
        isActive: true,
        ...(scopedSellerId ? { id: scopedSellerId } : {})
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
        type: "visita",
        done: true,
        date: { gte: range.start, lte: range.end }
      },
      _count: { _all: true }
    })
  ]);

  const executedMap = visitsBySeller.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = item._count._all;
    return acc;
  }, {});

  return res.json(
    sellers.map((seller) => {
      const executed = executedMap[seller.id] || 0;
      return {
        sellerId: seller.id,
        sellerName: seller.name,
        planned: executed,
        executed,
        minimumRequired,
        belowMinimum: executed < minimumRequired
      };
    })
  );
});


router.get("/reports/weekly-visits", async (req, res) => {
  const weekStart = String(req.query.weekStart || "").trim();
  const range = getWeekRangeFromMonday(weekStart);

  if (!range) {
    return res.status(400).json({ message: "weekStart deve estar no formato YYYY-MM-DD e ser uma segunda-feira." });
  }

  const canViewAll = req.user!.role === "diretor" || req.user!.role === "gerente";
  const [goal, sellers, visitsBySeller] = await Promise.all([
    getWeeklyVisitGoal(),
    prisma.user.findMany({
      where: { role: "vendedor", isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        type: "visita",
        done: true,
        dueDate: { gte: range.start, lte: range.end }
      },
      _count: { _all: true }
    })
  ]);

  const visitsMap = visitsBySeller.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = item._count._all;
    return acc;
  }, {});

  const ranking = sellers
    .map((seller) => {
      const visitsDone = visitsMap[seller.id] || 0;
      return {
        userId: seller.id,
        name: seller.name,
        visitsDone,
        goal,
        medal: getWeeklyVisitMedal(visitsDone),
        missing: Math.max(goal - visitsDone, 0)
      };
    })
    .sort((a, b) => b.visitsDone - a.visitsDone || a.name.localeCompare(b.name, "pt-BR"));

  if (canViewAll) {
    return res.json(ranking);
  }

  const top3 = ranking.slice(0, 3);
  const own = ranking.find((item) => item.userId === req.user!.id);

  if (!own) {
    return res.json(top3);
  }

  const sellerView = new Map(top3.map((item) => [item.userId, item]));
  sellerView.set(own.userId, own);
  return res.json(Array.from(sellerView.values()));
});

router.get("/reports/weekly-missions", async (req, res) => {
  const weekStart = String(req.query.weekStart || "").trim();
  const range = getWeekRangeFromMonday(weekStart);

  if (!range) {
    return res.status(400).json({ message: "weekStart deve estar no formato YYYY-MM-DD e ser uma segunda-feira." });
  }

  const isManagerView = req.user!.role === "diretor" || req.user!.role === "gerente";
  const [visitGoal, sellers, visitsBySeller, followUpsBySeller, proposalsBySeller, overdueOpportunitiesBySeller] = await Promise.all([
    getWeeklyVisitGoal(),
    prisma.user.findMany({
      where: { role: "vendedor", isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...resolveActivityTypeFilters("visita"),
        done: true,
        ...resolveExecutionActivityDateFilter(range.start, range.end)
      },
      _count: { _all: true }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...resolveActivityTypeFilters("followup", "follow_up"),
        done: true,
        ...resolveExecutionActivityDateFilter(range.start, range.end)
      },
      _count: { _all: true }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...resolveActivityTypeFilters("proposta_enviada", "envio_proposta"),
        done: true,
        ...resolveExecutionActivityDateFilter(range.start, range.end)
      },
      _count: { _all: true }
    }),
    prisma.opportunity.groupBy({
      by: ["ownerSellerId"],
      where: {
        stage: { notIn: ["ganho", "perdido"] },
        expectedCloseDate: { lt: new Date() }
      },
      _count: { _all: true }
    })
  ]);

  const toCountMap = <T extends string>(rows: { _count: { _all: number } }[], key: T) =>
    rows.reduce<Record<string, number>>((acc, item) => {
      const ownerId = (item as Record<T, string>)[key];
      acc[ownerId] = item._count._all;
      return acc;
    }, {});

  const visitsMap = toCountMap(visitsBySeller, "ownerSellerId");
  const followUpsMap = toCountMap(followUpsBySeller, "ownerSellerId");
  const proposalsMap = toCountMap(proposalsBySeller, "ownerSellerId");
  const overdueMap = toCountMap(overdueOpportunitiesBySeller, "ownerSellerId");

  const ranking = sellers
    .map((seller) => {
      const visitsDone = visitsMap[seller.id] || 0;
      const followUpsDone = followUpsMap[seller.id] || 0;
      const proposalsDone = proposalsMap[seller.id] || 0;
      const overdueCount = overdueMap[seller.id] || 0;

      return {
        userId: seller.id,
        name: seller.name,
        missions: [
          {
            key: "visits_25",
            title: "25 visitas na semana",
            progress: visitsDone,
            target: visitGoal,
            done: visitsDone >= visitGoal,
            medal: getWeeklyVisitMedal(visitsDone)
          },
          {
            key: "followups_5",
            title: "5 follow-ups concluídos",
            progress: followUpsDone,
            target: 5,
            done: followUpsDone >= 5
          },
          {
            key: "proposals_2",
            title: "2 propostas enviadas",
            progress: proposalsDone,
            target: 2,
            done: proposalsDone >= 2
          },
          {
            key: "overdue_0",
            title: "0 oportunidades atrasadas",
            progress: overdueCount,
            target: 0,
            done: overdueCount === 0
          }
        ]
      };
    })
    .sort((a, b) => {
      const visitsA = a.missions[0]?.progress ?? 0;
      const visitsB = b.missions[0]?.progress ?? 0;
      return visitsB - visitsA || a.name.localeCompare(b.name, "pt-BR");
    });

  if (isManagerView) {
    return res.json(ranking);
  }

  const own = ranking.find((item) => item.userId === req.user!.id);
  const top3MainMissionOnly = ranking.slice(0, 3).map((item) => ({
    userId: item.userId,
    name: item.name,
    missions: [item.missions[0]]
  }));

  if (!own) {
    return res.json(top3MainMissionOnly);
  }

  const sellerView = new Map(top3MainMissionOnly.map((item) => [item.userId, item]));
  sellerView.set(own.userId, own);
  return res.json(Array.from(sellerView.values()));
});

router.get("/reports/discipline-ranking", async (req, res) => {
  const fromRaw = req.query.from as string | undefined;
  const toRaw = req.query.to as string | undefined;
  const sellerIdRaw = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";

  if (!fromRaw || !toRaw) {
    return res.status(400).json({ message: "Parâmetros from e to são obrigatórios." });
  }

  const from = normalizeDateToUtc(fromRaw);
  const to = normalizeDateToUtc(toRaw, true);

  if (!from || !to) {
    return res.status(400).json({ message: "Parâmetros from/to inválidos." });
  }

  const scopedSellerId = req.user?.role === "vendedor" ? req.user.id : sellerIdRaw || undefined;
  const inactivityWindow = getLastBusinessDaysWindow(3);
  const weeklyVisitGoal = await getWeeklyVisitGoal();

  const [sellers, plannedBySellerRows, executedActivities, recentExecutionRows] = await Promise.all([
    prisma.user.findMany({
      where: {
        role: "vendedor",
        isActive: true,
        ...(scopedSellerId ? { id: scopedSellerId } : {})
      },
      select: { id: true, name: true }
    }),
    prisma.agendaEvent.groupBy({
      by: ["sellerId"],
      where: {
        type: "roteiro_visita",
        startDateTime: { gte: from, lte: to },
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      _count: { _all: true }
    }),
    prisma.activity.findMany({
      where: {
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
        done: true,
        ...resolveActivityTypeFilters(...EXECUTION_ACTIVITY_TYPES),
        ...resolveExecutionActivityDateFilter(from, to)
      },
      select: {
        ownerSellerId: true,
        opportunityId: true,
        type: true,
        date: true
      }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
        done: true,
        ...resolveActivityTypeFilters("visita", "visita_tecnica", "reuniao"),
        ...resolveExecutionActivityDateFilter(inactivityWindow.start, inactivityWindow.end)
      },
      _count: { _all: true }
    })
  ]);

  const plannedBySeller = plannedBySellerRows.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = item._count._all;
    return acc;
  }, {});

  const activeSellersInWindow = new Set(recentExecutionRows.filter((item) => item._count._all > 0).map((item) => item.ownerSellerId));

  const followUpsIndex = executedActivities
    .filter((item) => normalizeActivityType(item.type) === "followup" && item.opportunityId)
    .reduce<Record<string, Date[]>>((acc, item) => {
      const key = `${item.ownerSellerId}:${item.opportunityId}`;
      if (!acc[key]) acc[key] = [];
      if (item.date) {
        acc[key].push(item.date);
      }
      return acc;
    }, {});

  const statsBySeller = sellers.reduce<
    Record<
      string,
      {
        sellerId: string;
        sellerName: string;
        planned: number;
        executed: number;
        punctual: number;
        followUpAfterVisit: number;
      }
    >
  >((acc, seller) => {
    acc[seller.id] = {
      sellerId: seller.id,
      sellerName: seller.name,
      planned: plannedBySeller[seller.id] || 0,
      executed: 0,
      punctual: 0,
      followUpAfterVisit: 0
    };
    return acc;
  }, {});

  for (const activity of executedActivities) {
    const sellerStats = statsBySeller[activity.ownerSellerId];
    if (!sellerStats) continue;
    sellerStats.executed += 1;
    sellerStats.punctual += 1;

    const normalizedType = normalizeActivityType(activity.type);
    if ((normalizedType === "visita" || normalizedType === "visita_tecnica" || normalizedType === "reuniao") && activity.opportunityId) {
      if (!activity.date) continue;
      const key = `${activity.ownerSellerId}:${activity.opportunityId}`;
      const executionDate = activity.date;
      const hasFollowUpAfterVisit = (followUpsIndex[key] || []).some((createdAt) => createdAt.getTime() >= executionDate.getTime());
      if (hasFollowUpAfterVisit) {
        sellerStats.followUpAfterVisit += 1;
      }
    }
  }

  const ranking = Object.values(statsBySeller)
    .map((stats) => {
      const executionRate = stats.planned ? (stats.executed / stats.planned) * 100 : stats.executed > 0 ? 100 : 0;
      const punctualRate = stats.executed ? (stats.punctual / stats.executed) * 100 : 0;
      const followUpRate = stats.executed ? (stats.followUpAfterVisit / stats.executed) * 100 : 0;
      const baseDisciplineScore = executionRate * 0.5 + punctualRate * 0.3 + followUpRate * 0.2;
      const isUnderExecutionThreshold = executionRate < 60;
      const hasInactivityFlag = !activeSellersInWindow.has(stats.sellerId);
      const disciplineScoreBase = isUnderExecutionThreshold ? baseDisciplineScore * 0.9 : baseDisciplineScore;
      const volumeFactor = stats.planned < weeklyVisitGoal ? stats.planned / weeklyVisitGoal : 1;
      const disciplineScoreFinal = disciplineScoreBase * volumeFactor;

      return {
        sellerId: stats.sellerId,
        sellerName: stats.sellerName,
        planned: stats.planned,
        executed: stats.executed,
        executionRate,
        punctualRate,
        followUpRate,
        disciplineScoreBase,
        volumeFactor,
        disciplineScoreFinal,
        disciplineScore: disciplineScoreFinal,
        isUnderExecutionThreshold,
        hasInactivityFlag
      };
    })
    .sort((a, b) => b.disciplineScoreFinal - a.disciplineScoreFinal);

  return res.json(ranking);
});

router.get("/reports/score-monthly", async (req, res) => {
  const month = String(req.query.month || "").trim();
  const userIdFilter = typeof req.query.userId === "string" ? req.query.userId.trim() : "";

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ message: "month deve estar no formato YYYY-MM" });
  }

  const role = req.user?.role;
  if (role !== "diretor" && role !== "gerente" && role !== "vendedor") {
    return res.status(403).json({ message: "Perfil sem permissão para consultar score mensal." });
  }

  if (role === "vendedor" && userIdFilter) {
    return res.status(403).json({ message: "Filtro userId não permitido para perfil vendedor." });
  }

  const { start, end } = getMonthRangeFromKey(month);

  const [sellers, monthSales, monthGoals, monthPipeline] = await Promise.all([
    prisma.user.findMany({
      where: { role: "vendedor", isActive: true },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" }
    }),
    prisma.opportunity.groupBy({
      by: ["ownerSellerId"],
      where: {
        stage: "ganho",
        ...buildWonOpportunityDateRangeFilter(start, end)
      },
      _sum: { value: true }
    }),
    prisma.goal.findMany({
      where: { month },
      select: { sellerId: true, targetValue: true }
    }),
    prisma.opportunity.findMany({
      where: {
        createdAt: { gte: start, lte: end }
      },
      select: {
        ownerSellerId: true,
        value: true,
        probability: true
      }
    })
  ]);

  const salesBySeller = monthSales.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = item._sum.value ?? 0;
    return acc;
  }, {});

  const goalsBySeller = monthGoals.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = item.targetValue ?? 0;
    return acc;
  }, {});

  const weightedPipelineBySeller = monthPipeline.reduce<Record<string, number>>((acc, item) => {
    const weightedValue = item.value * ((item.probability ?? 0) / 100);
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + weightedValue;
    return acc;
  }, {});

  const maxFaturado = Math.max(...sellers.map((seller) => salesBySeller[seller.id] || 0), 1);
  const maxPipeline = Math.max(...sellers.map((seller) => weightedPipelineBySeller[seller.id] || 0), 1);

  const rankedItems = sellers
    .map((seller) => {
      const faturadoMes = salesBySeller[seller.id] || 0;
      const objetivoMes = goalsBySeller[seller.id] || 0;
      const pipelinePonderado = weightedPipelineBySeller[seller.id] || 0;
      const atingimentoPercent = objetivoMes > 0 ? (faturadoMes / objetivoMes) * 100 : 0;

      const faturadoNormalizado = (faturadoMes / maxFaturado) * 1000;
      const pipelineNormalizado = (pipelinePonderado / maxPipeline) * 1000;
      const atingimentoRatio = Math.max(atingimentoPercent, 0) / 100;

      const score = faturadoNormalizado * 1.0 + atingimentoRatio * 1000 + pipelineNormalizado * 0.1;

      return {
        userId: seller.id,
        name: seller.name,
        role: seller.role,
        faturadoMes: Number(faturadoMes.toFixed(2)),
        objetivoMes: Number(objetivoMes.toFixed(2)),
        atingimentoPercent: Number(atingimentoPercent.toFixed(2)),
        pipelinePonderado: Number(pipelinePonderado.toFixed(2)),
        score: Number(score.toFixed(2))
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.pipelinePonderado !== a.pipelinePonderado) return b.pipelinePonderado - a.pipelinePonderado;
      if (b.faturadoMes !== a.faturadoMes) return b.faturadoMes - a.faturadoMes;
      return a.name.localeCompare(b.name, "pt-BR");
    })
    .map((item, index) => ({
      ...item,
      rank: index + 1
    }));

  if (role === "vendedor") {
    const me = rankedItems.find((item) => item.userId === req.user!.id);
    const topThree = rankedItems.slice(0, 3);

    const items = me && !topThree.some((item) => item.userId === me.userId) ? [...topThree, me] : topThree;

    return res.json({ month, items });
  }

  if (userIdFilter) {
    return res.json({ month, items: rankedItems.filter((item) => item.userId === userIdFilter) });
  }

  return res.json({ month, items: rankedItems });
});

router.get("/reports/weekly-highlights", async (req, res) => {
  const sellerIdRaw = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";
  const scopedSellerId = req.user?.role === "vendedor" ? req.user.id : sellerIdRaw || undefined;
  const range = getCurrentWeekRangeFromBrazilNow();
  const previousStart = new Date(range.start);
  previousStart.setUTCDate(previousStart.getUTCDate() - 7);
  const previousEnd = new Date(range.end);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 7);

  const weeklyVisitGoal = await getWeeklyVisitGoal();

  const [sellers, currentWonOpportunities, previousWonOpportunities, visitActivities, followUpActivities, opportunitiesCreated] = await Promise.all([
    prisma.user.findMany({
      where: { role: "vendedor", ...(scopedSellerId ? { id: scopedSellerId } : {}) },
      select: { id: true, name: true }
    }),
    prisma.opportunity.groupBy({
      by: ["ownerSellerId"],
      where: {
        stage: "ganho",
        ...sellerWhere(req),
        ...buildWonOpportunityDateRangeFilter(range.start, range.end)
      },
      _sum: { value: true }
    }),
    prisma.opportunity.groupBy({
      by: ["ownerSellerId"],
      where: {
        stage: "ganho",
        ...sellerWhere(req),
        ...buildWonOpportunityDateRangeFilter(previousStart, previousEnd)
      },
      _sum: { value: true }
    }),
    prisma.activity.findMany({
      where: {
        ...sellerWhere(req),
        done: true,
        type: "visita",
        date: { gte: range.start, lte: range.end }
      },
      select: {
        ownerSellerId: true,
        opportunityId: true
      }
    }),
    prisma.activity.findMany({
      where: {
        ...sellerWhere(req),
        done: true,
        ...resolveActivityTypeFilters("followup", "follow_up"),
        date: { gte: range.start, lte: range.end }
      },
      select: {
        ownerSellerId: true
      }
    }),
    prisma.opportunity.findMany({
      where: { createdAt: { gte: range.start, lte: range.end } },
      select: { ownerSellerId: true }
    })
  ]);

  const currentSalesMap = currentWonOpportunities.reduce<Record<string, number>>((acc, row) => {
    if (!row.ownerSellerId) return acc;
    acc[row.ownerSellerId] = row._sum.value ?? 0;
    return acc;
  }, {});

  const previousSalesMap = previousWonOpportunities.reduce<Record<string, number>>((acc, row) => {
    if (!row.ownerSellerId) return acc;
    acc[row.ownerSellerId] = row._sum.value ?? 0;
    return acc;
  }, {});

  const opportunitiesCreatedMap = opportunitiesCreated.reduce<Record<string, number>>((acc, row) => {
    acc[row.ownerSellerId] = (acc[row.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const executedBySeller = visitActivities.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const followUpsBySeller = followUpActivities.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const topByMetric = <T extends { metricValue: number }>(rows: T[]) => {
    if (rows.length === 0) return null;
    return rows.reduce((best, row) => (row.metricValue > best.metricValue ? row : best));
  };

  const bestResult = topByMetric(
    sellers.map((seller) => ({
      sellerId: seller.id,
      sellerName: seller.name,
      metricLabel: "Valor vendido na semana",
      metricValue: currentSalesMap[seller.id] || 0,
      medal: "🏆"
    }))
  );

  const bestEvolution = topByMetric(
    sellers.map((seller) => {
      const current = currentSalesMap[seller.id] || 0;
      const previous = previousSalesMap[seller.id] || 0;
      const growthPercent = previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? 100 : 0;

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        metricLabel: "Crescimento vs semana anterior (%)",
        metricValue: growthPercent,
        medal: "📈"
      };
    })
  );

  const bestExecutor = topByMetric(
    sellers.map((seller) => {
      const executed = executedBySeller[seller.id] || 0;
      const followUps = followUpsBySeller[seller.id] || 0;
      const followUpRate = executed > 0 ? (followUps / executed) * 100 : 0;
      const volumeFactor = executed < weeklyVisitGoal ? executed / weeklyVisitGoal : 1;
      const metricValue = (followUpRate * 0.4 + Math.min(executed, weeklyVisitGoal) / weeklyVisitGoal * 100 * 0.6) * volumeFactor;

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        metricLabel: "Disciplina de execução da semana",
        metricValue,
        medal: "🥇"
      };
    })
  );

  const bestConversion = topByMetric(
    sellers.map((seller) => {
      const created = opportunitiesCreatedMap[seller.id] || 0;
      const executed = executedBySeller[seller.id] || 0;
      const conversionRate = executed > 0 ? (created / executed) * 100 : 0;

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        metricLabel: "Oportunidades criadas / atividades executadas (%)",
        metricValue: conversionRate,
        medal: "🎯"
      };
    })
  );

  return res.json({
    bestResult: bestResult ? { ...bestResult, avatarUrl: null } : null,
    bestEvolution: bestEvolution ? { ...bestEvolution, avatarUrl: null } : null,
    bestExecutor: bestExecutor ? { ...bestExecutor, avatarUrl: null } : null,
    bestConversion: bestConversion ? { ...bestConversion, avatarUrl: null } : null
  });
});

router.get("/reports/commercial-score", async (req, res) => {
  const month = String(req.query.month || "");
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ message: "month deve estar no formato YYYY-MM" });
  }

  const scopedSellerId = undefined;
  const { start, end } = getMonthRangeFromKey(month);
  const stageOrder: Record<string, number> = {
    prospeccao: 0,
    negociacao: 1,
    proposta: 2,
    ganho: 3,
    perdido: 3
  };

  const [sellers, plannedEvents, openOpportunities, createdOpportunitiesInMonth, stageChanges, monthSales, monthGoals] = await Promise.all([
    prisma.user.findMany({
      where: {
        role: "vendedor",
        ...(scopedSellerId ? { id: scopedSellerId } : {})
      },
      select: { id: true, name: true }
    }),
    prisma.agendaEvent.groupBy({
      by: ["sellerId"],
      where: {
        type: "roteiro_visita",
        startDateTime: { gte: start, lte: end },
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      _count: { _all: true }
    }),
    prisma.opportunity.findMany({
      where: {
        stage: { notIn: ["ganho", "perdido"] },
        createdAt: { lte: end },
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {})
      },
      select: {
        id: true,
        ownerSellerId: true,
        followUpDate: true
      }
    }),
    prisma.opportunity.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {})
      },
      select: {
        ownerSellerId: true
      }
    }),
    prisma.timelineEvent.findMany({
      where: {
        type: "mudanca_etapa",
        createdAt: { gte: start, lte: end },
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {})
      },
      select: {
        ownerSellerId: true,
        description: true
      }
    }),
    prisma.opportunity.groupBy({
      by: ["ownerSellerId"],
      where: {
        stage: "ganho",
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {}),
        ...buildWonOpportunityDateRangeFilter(start, end)
      },
      _sum: { value: true }
    }),
    prisma.goal.findMany({
      where: {
        month,
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      select: {
        sellerId: true,
        targetValue: true
      }
    })
  ]);

  const plannedBySeller = plannedEvents.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = item._count._all;
    return acc;
  }, {});

  const executionActivities = await prisma.activity.findMany({
    where: {
      ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
      done: true,
      ...resolveActivityTypeFilters(...EXECUTION_ACTIVITY_TYPES),
      ...resolveExecutionActivityDateFilter(start, end)
    },
    select: {
      ownerSellerId: true,
      opportunityId: true,
      type: true,
      createdAt: true,
      dueDate: true,
      date: true
    }
  });

  const followUpsIndex = executionActivities
    .filter((item) => normalizeActivityType(item.type) === "followup" && item.opportunityId)
    .reduce<Record<string, Date[]>>((acc, item) => {
      if (!item.opportunityId) return acc;
      const key = `${item.ownerSellerId}:${item.opportunityId}`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(item.date || item.createdAt || item.dueDate);
      return acc;
    }, {});

  const disciplineBySeller = sellers.reduce<Record<string, { planned: number; executed: number; punctual: number; followUpAfterVisit: number }>>(
    (acc, seller) => {
      acc[seller.id] = { planned: plannedBySeller[seller.id] || 0, executed: 0, punctual: 0, followUpAfterVisit: 0 };
      return acc;
    },
    {}
  );

  for (const activity of executionActivities) {
    if (!disciplineBySeller[activity.ownerSellerId]) {
      disciplineBySeller[activity.ownerSellerId] = { planned: 0, executed: 0, punctual: 0, followUpAfterVisit: 0 };
    }

    const sellerStats = disciplineBySeller[activity.ownerSellerId];
    sellerStats.executed += 1;
    sellerStats.punctual += 1;

    const normalizedType = normalizeActivityType(activity.type);
    if ((normalizedType === "visita" || normalizedType === "reuniao") && activity.opportunityId) {
      const key = `${activity.ownerSellerId}:${activity.opportunityId}`;
      const executionDate = activity.date || activity.createdAt || activity.dueDate;
      const hasFollowUpAfterVisit = (followUpsIndex[key] || []).some((createdAt) => createdAt.getTime() >= executionDate.getTime());
      if (hasFollowUpAfterVisit) {
        sellerStats.followUpAfterVisit += 1;
      }
    }
  }

  const referenceDate = end.getTime() > Date.now() ? new Date() : end;

  const openOppCountBySeller = openOpportunities.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const followUpOnTimeBySeller = openOpportunities.reduce<Record<string, number>>((acc, item) => {
    if (item.followUpDate.getTime() >= referenceDate.getTime()) {
      acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    }
    return acc;
  }, {});

  const stageAdvanceBySeller = stageChanges.reduce<Record<string, { total: number; advanced: number }>>((acc, item) => {
    const match = item.description.match(/de\s+(.+?)\s+para\s+(.+)$/i);
    const fromLabel = match?.[1]?.trim() || "";
    const toLabel = match?.[2]?.trim() || "";
    const labelToStage: Record<string, keyof typeof stageOrder> = {
      Prospecção: "prospeccao",
      Negociação: "negociacao",
      Proposta: "proposta",
      Ganho: "ganho",
      Perdido: "perdido"
    };
    const fromStage = labelToStage[fromLabel];
    const toStage = labelToStage[toLabel];

    if (!fromStage || !toStage) return acc;
    if (!acc[item.ownerSellerId]) {
      acc[item.ownerSellerId] = { total: 0, advanced: 0 };
    }

    acc[item.ownerSellerId].total += 1;
    if (stageOrder[toStage] > stageOrder[fromStage]) {
      acc[item.ownerSellerId].advanced += 1;
    }

    return acc;
  }, {});

  const salesBySeller = monthSales.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = item._sum.value ?? 0;
    return acc;
  }, {});
  const goalsBySeller = monthGoals.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = item.targetValue;
    return acc;
  }, {});

  const maxOpenOpp = Math.max(...Object.values(openOppCountBySeller), 1);
  const createdOpportunitiesBySeller = createdOpportunitiesInMonth.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const baseRows = sellers
    .map((seller) => {
      const discipline = disciplineBySeller[seller.id] || { planned: 0, executed: 0, punctual: 0, followUpAfterVisit: 0 };
      const executionRate = discipline.planned ? (discipline.executed / discipline.planned) * 100 : 0;
      const punctualRate = discipline.executed ? (discipline.punctual / discipline.executed) * 100 : 0;
      const followUpRate = discipline.executed ? (discipline.followUpAfterVisit / discipline.executed) * 100 : 0;
      const disciplineScoreBase = executionRate * 0.5 + punctualRate * 0.3 + followUpRate * 0.2;
      const volumeFactor = discipline.planned >= 25 ? 1 : 0.7 + (discipline.planned / 25) * 0.3;
      const disciplineScore = disciplineScoreBase * volumeFactor;

      const openOpp = openOppCountBySeller[seller.id] || 0;
      const followUpsOnTime = followUpOnTimeBySeller[seller.id] || 0;
      const stageAdvance = stageAdvanceBySeller[seller.id] || { total: 0, advanced: 0 };

      const openOppScore = (openOpp / maxOpenOpp) * 100;
      const followUpOnTimeRate = openOpp ? (followUpsOnTime / openOpp) * 100 : 0;
      const stageAdvanceRate = stageAdvance.total ? (stageAdvance.advanced / stageAdvance.total) * 100 : 0;
      const pipelineScore = openOppScore * 0.4 + followUpOnTimeRate * 0.35 + stageAdvanceRate * 0.25;

      const soldValue = salesBySeller[seller.id] || 0;
      const monthGoal = goalsBySeller[seller.id] || 0;
      const goalAchievementPercent = monthGoal > 0 ? (soldValue / monthGoal) * 100 : 0;
      const resultScore = Math.min(Math.max(goalAchievementPercent, 0), 110);

      const finalScore = resultScore * 0.5 + disciplineScore * 0.3 + pipelineScore * 0.2;
      const punctualityPerfect = discipline.executed > 0 && punctualRate === 100;

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        disciplineScore: Number(disciplineScore.toFixed(2)),
        pipelineScore: Number(pipelineScore.toFixed(2)),
        resultScore: Number(resultScore.toFixed(2)),
        finalScore: Number(finalScore.toFixed(2)),
        breakdown: {
          resultadoScore: Number(resultScore.toFixed(2)),
          disciplinaScore: Number(disciplineScore.toFixed(2)),
          pipelineScore: Number(pipelineScore.toFixed(2)),
          finalScore: Number(finalScore.toFixed(2))
        },
        punctualityPerfect,
        createdOpportunities: createdOpportunitiesBySeller[seller.id] || 0
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);

  const topDisciplineScore = Math.max(...baseRows.map((item) => item.disciplineScore), 0);
  const topCreatedOpportunities = Math.max(...baseRows.map((item) => item.createdOpportunities), 0);

  const scoreRows = baseRows.map((row) => {
    const level = row.finalScore >= 95 ? "Diamante" : row.finalScore >= 85 ? "Ouro" : row.finalScore >= 75 ? "Prata" : row.finalScore >= 60 ? "Bronze" : null;
    const medals: string[] = [];

    if (level) medals.push(level);
    if (row.punctualityPerfect) medals.push("Pontualidade Perfeita");
    if (row.disciplineScore === topDisciplineScore && topDisciplineScore > 0) medals.push("Executor da Semana");
    if (row.createdOpportunities === topCreatedOpportunities && topCreatedOpportunities > 0) medals.push("Gerador de Oportunidades");

    return {
      sellerId: row.sellerId,
      sellerName: row.sellerName,
      disciplineScore: row.disciplineScore,
      pipelineScore: row.pipelineScore,
      resultScore: row.resultScore,
      finalScore: row.finalScore,
      breakdown: row.breakdown,
      level,
      medals
    };
  });

  return res.json({ sellers: scoreRows });
});

router.get("/reports/consistency", async (req, res) => {
  const sellerIdRaw = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";
  const monthKeys = getLastNMonthKeys(3);

  const scopedSellerFilter =
    req.user?.role === "vendedor"
      ? { id: req.user.id }
      : { role: "vendedor" as const, ...(sellerIdRaw ? { id: sellerIdRaw } : {}) };
  const sellers = await prisma.user.findMany({
    where: scopedSellerFilter,
    select: { id: true, name: true },
    orderBy: { name: "asc" }
  });

  const monthlyStats = await Promise.all(
    monthKeys.map(async (month) => {
      const { start, end } = getMonthRangeFromKey(month);
      const [sales, goals] = await Promise.all([
        prisma.opportunity.groupBy({
          by: ["ownerSellerId"],
          where: {
            stage: "ganho",
            ownerSellerId: { in: sellers.map((seller) => seller.id) },
            ...buildWonOpportunityDateRangeFilter(start, end)
          },
          _sum: { value: true }
        }),
        prisma.goal.findMany({
          where: {
            month,
            sellerId: { in: sellers.map((seller) => seller.id) }
          },
          select: {
            sellerId: true,
            targetValue: true
          }
        })
      ]);

      const salesBySeller = sales.reduce<Record<string, number>>((acc, item) => {
        acc[item.ownerSellerId] = item._sum.value ?? 0;
        return acc;
      }, {});

      const goalsBySeller = goals.reduce<Record<string, number>>((acc, item) => {
        acc[item.sellerId] = item.targetValue;
        return acc;
      }, {});

      return { month, salesBySeller, goalsBySeller };
    })
  );

  const ranking = sellers
    .map((seller) => {
      const monthlyPerformance = monthKeys.map((month, index) => {
        const soldValue = monthlyStats[index]?.salesBySeller[seller.id] || 0;
        const targetValue = monthlyStats[index]?.goalsBySeller[seller.id] || 0;
        const resultScore = targetValue > 0 ? (soldValue / targetValue) * 100 : 0;
        const finalScore = Math.min(Math.max(resultScore, 0), 110);

        return {
          month,
          soldValue,
          targetValue,
          resultScore,
          finalScore,
          metaHit: targetValue > 0 && soldValue >= targetValue
        };
      });

      const finalScores = monthlyPerformance.map((item) => item.finalScore);
      const resultScores = monthlyPerformance.map((item) => item.resultScore);
      const averageScore = calculateMean(finalScores);
      const metaHitRate = (monthlyPerformance.filter((item) => item.metaHit).length / monthKeys.length) * 100;
      const stdDevResult = calculateStandardDeviation(resultScores);
      const stability = Math.max(0, 100 - stdDevResult);
      const consistencyScore = averageScore * 0.6 + metaHitRate * 0.3 + stability * 0.1;

      const consistencyLevel = consistencyScore >= 80 ? "alta" : consistencyScore >= 60 ? "media" : "baixa";

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        averageScore: Number(averageScore.toFixed(2)),
        metaHitRate: Number(metaHitRate.toFixed(2)),
        stdDevResult: Number(stdDevResult.toFixed(2)),
        stability: Number(stability.toFixed(2)),
        consistencyScore: Number(consistencyScore.toFixed(2)),
        consistencyLevel,
        monthlyPerformance: monthlyPerformance.map((item) => ({
          month: item.month,
          soldValue: Number(item.soldValue.toFixed(2)),
          targetValue: Number(item.targetValue.toFixed(2)),
          resultScore: Number(item.resultScore.toFixed(2)),
          finalScore: Number(item.finalScore.toFixed(2)),
          metaHit: item.metaHit
        }))
      };
    })
    .sort((a, b) => b.consistencyScore - a.consistencyScore)
    .map((item, index) => ({
      ...item,
      position: index + 1
    }));

  return res.json({
    period: {
      months: monthKeys
    },
    ranking
  });
});

router.get("/clients", async (req, res) => {
  const search = String(req.query.q || "").trim();
  const state = String(req.query.uf || "").trim();
  const region = String(req.query.regiao || "").trim();
  const clientType = String(req.query.tipo || "").trim();
  const ownerSellerIdFilter = String(req.query.ownerSellerId || req.query.vendedorId || "").trim();
  const page = parsePositiveInt(req.query.page, 1);
  const pageSize = Math.min(parsePositiveInt(req.query.pageSize, 20), 100);
  const orderBy = parseClientSort(String(req.query.sort || "").trim() || undefined);

  const parsedClientType = clientType.toUpperCase();
  const isValidClientType = parsedClientType === ClientType.PF || parsedClientType === ClientType.PJ;

  const where: Prisma.ClientWhereInput = {
    ...sellerWhere(req),
    isArchived: false,
    ...(state ? { state: { equals: state, mode: "insensitive" } } : {}),
    ...(region ? { region: { equals: region, mode: "insensitive" } } : {}),
    ...(isValidClientType ? { clientType: parsedClientType } : {}),
    ...(req.user?.role !== "vendedor" && ownerSellerIdFilter ? { ownerSellerId: ownerSellerIdFilter } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { fantasyName: { contains: search, mode: "insensitive" } },
            { code: { contains: search, mode: "insensitive" } },
            { cnpj: { contains: search, mode: "insensitive" } },
            { city: { contains: search, mode: "insensitive" } },
            { state: { contains: search, mode: "insensitive" } },
            { region: { contains: search, mode: "insensitive" } },
            { segment: { contains: search, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const hasAdvancedQuery = ["q", "uf", "regiao", "tipo", "ownerSellerId", "vendedorId", "page", "pageSize", "sort"].some(
    (key) => req.query[key] !== undefined
  );

  if (!hasAdvancedQuery) {
    const data = await prisma.client.findMany({
      where,
      orderBy,
      include: {
        ownerSeller: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    return res.json(data);
  }

  const [items, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        ownerSeller: {
          select: {
            id: true,
            name: true
          }
        }
      }
    }),
    prisma.client.count({ where })
  ]);

  res.json({
    items,
    total,
    page,
    pageSize
  });
});

router.get("/clients/:id", async (req, res) => {
  const data = await prisma.client.findFirst({
    where: {
      id: req.params.id,
      isArchived: false,
      ...sellerWhere(req)
    }
  });

  if (!data) return res.status(404).json({ message: "Não encontrado" });

  const [openOpportunitiesCount, lastActivityAggregate, totalCompletedActivities] = await Promise.all([
    prisma.opportunity.count({
      where: {
        clientId: data.id,
        stage: {
          notIn: [OpportunityStage.ganho, OpportunityStage.perdido]
        }
      }
    }),
    prisma.activity.aggregate({
      where: {
        clientId: data.id
      },
      _max: {
        date: true,
        createdAt: true
      }
    }),
    prisma.activity.count({
      where: {
        clientId: data.id,
        done: true
      }
    })
  ]);

  const commercialSummary = {
    openOpportunitiesCount,
    lastActivityAt: lastActivityAggregate._max.date ?? lastActivityAggregate._max.createdAt ?? null,
    lastPurchaseDate: data.lastPurchaseDate ?? null,
    lastPurchaseValue: data.lastPurchaseValue ?? null,
    totalCompletedActivities,
    clientCode: data.code ?? null,
    fantasyName: data.fantasyName ?? null,
    erpUpdatedAt: data.erpUpdatedAt ?? null
  };

  res.json({
    ...data,
    commercialSummary
  });
});

const clientAiContextParamsSchema = z.object({
  id: z.string().trim().min(1, "id é obrigatório")
});

router.get("/clients/:id/ai-context", async (req, res) => {
  const parsed = clientAiContextParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ message: "Parâmetros inválidos", errors: parsed.error.issues });
  }

  const payload = await buildClientAiContext({
    clientId: parsed.data.id,
    scope: sellerWhere(req)
  });

  if (!payload) {
    return res.status(404).json({ message: "Cliente não encontrado" });
  }

  return res.json(payload);
});

const clientSuggestionBodySchema = z.object({
  clientId: z.string().trim().min(1, "clientId é obrigatório")
});

router.get("/ai/status", (_req, res) => {
  return res.json(aiService.getStatus());
});

router.get("/ai/knowledge-preview", authorize("diretor", "gerente"), async (req, res) => {
  const result = await getKnowledgeContextForAi(String(req.query.query || req.query.q || ""));
  return res.json({
    query: String(req.query.query || req.query.q || ""),
    elapsedMs: result.elapsedMs,
    documents: result.documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
      sourceType: doc.sourceType,
      sourceName: doc.sourceName,
      summary: doc.summary,
      snippet: doc.snippet,
      score: doc.score
    }))
  });
});

router.post("/ai/client-suggestion", async (req, res) => {
  const parsed = clientSuggestionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido", errors: parsed.error.issues });
  }

  const context = await buildClientAiContext({
    clientId: parsed.data.clientId,
    scope: sellerWhere(req)
  });

  if (!context) {
    return res.status(404).json({ message: "Cliente não encontrado" });
  }

  const suggestion = await generateClientSuggestion(context);
  return res.json(suggestion);
});

const assistantWhatsappMessageSchema = z.object({
  clientId: z.string().trim().min(1, "clientId é obrigatório")
});

router.post("/ai/assistant-whatsapp-message", async (req, res) => {
  const parsed = assistantWhatsappMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido", errors: parsed.error.issues });
  }

  const context = await buildClientAiContext({
    clientId: parsed.data.clientId,
    scope: sellerWhere(req)
  });

  if (!context) {
    return res.status(404).json({ message: "Cliente não encontrado" });
  }

  const sanitizedContext = buildAssistantWhatsappContext(context);
  const result = await generateAssistantWhatsappMessage(sanitizedContext);

  return res.json(result);
});

const assistantWhatsappContactSchema = z.object({
  clientId: z.string().trim().min(1, "clientId é obrigatório"),
  opportunityId: z.string().trim().min(1).optional()
});

router.post("/assistant-whatsapp/contact", async (req, res) => {
  const parsed = assistantWhatsappContactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido", errors: parsed.error.issues });
  }

  const client = await prisma.client.findFirst({
    where: { id: parsed.data.clientId, ...sellerWhere(req), isArchived: false },
    select: { id: true, ownerSellerId: true }
  });

  if (!client) {
    return res.status(404).json({ message: "Cliente não encontrado" });
  }

  const opportunity = parsed.data.opportunityId
    ? await prisma.opportunity.findFirst({
        where: { id: parsed.data.opportunityId, clientId: client.id, ...sellerWhere(req) },
        select: { id: true, ownerSellerId: true }
      })
    : await prisma.opportunity.findFirst({
        where: {
          clientId: client.id,
          stage: { in: ["prospeccao", "negociacao", "proposta"] },
          ...sellerWhere(req)
        },
        orderBy: [{ followUpDate: "asc" }, { createdAt: "desc" }],
        select: { id: true, ownerSellerId: true }
      });

  if (parsed.data.opportunityId && !opportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const ownerSellerId = opportunity?.ownerSellerId || client.ownerSellerId || req.user!.id;
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const activity = await tx.activity.create({
      data: {
        type: "whatsapp",
        done: true,
        notes: "Contato realizado via WhatsApp.",
        description: "Contato realizado via WhatsApp.",
        dueDate: now,
        date: now,
        clientId: client.id,
        opportunityId: opportunity?.id,
        ownerSellerId
      }
    });

    const timelineEvent = await tx.timelineEvent.create({
      data: {
        type: "status",
        description: "Contato via WhatsApp",
        clientId: client.id,
        opportunityId: opportunity?.id,
        ownerSellerId
      }
    });

    return { activity, timelineEvent };
  });

  return res.status(201).json(result);
});


const clientDuplicateCheckSchema = z.object({
  name: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  cnpj: z.string().optional(),
  ignoreClientId: z.string().optional()
});

router.post("/clients/check-duplicate", async (req, res) => {
  const parsed = clientDuplicateCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido para validação de cliente." });
  }

  const duplicate = await findDuplicateClient({
    candidate: parsed.data,
    scope: sellerWhere(req),
    ignoreClientId: parsed.data.ignoreClientId
  });

  if (!duplicate) {
    return res.json({ exists: false, existingClient: null, matchType: null });
  }

  return res.json({
    exists: true,
    matchType: duplicate.matchType,
    message: new DuplicateClientError(duplicate.existingClient, duplicate.matchType).message,
    existingClient: duplicate.existingClient
  });
});

router.post("/clients/exists-bulk", async (req, res) => {
  const parsed = clientExistsBulkRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido para verificação em lote." });
  }

  const page = parsed.data.page ?? 1;
  const pageSize = parsed.data.pageSize ?? 500;

  const normalizedKeys = parsed.data.keys.map((key) => ({
    cnpjDigits: normalizeCnpj(key.cnpjDigits),
    fallbackKey: key.fallbackKey ? normalizeText(key.fallbackKey).replace(/\s*\|\s*/g, "|") : ""
  }));

  const paginated = paginateArray(normalizedKeys, page, pageSize);
  const pageKeys = paginated.data;

  if (pageKeys.length === 0) {
    return res.json({ ...paginated, data: [] });
  }

  const cnpjSet = new Set<string>();
  const fallbackSet = new Set<string>();

  pageKeys.forEach((key) => {
    if (key.cnpjDigits) cnpjSet.add(key.cnpjDigits);
    if (key.fallbackKey) fallbackSet.add(key.fallbackKey);
  });

  const fallbackTuples = Array.from(fallbackSet).map((key) => {
    const [nameNormalized = "", cityNormalized = "", state = ""] = key.split("|");
    return { nameNormalized, cityNormalized, state: normalizeState(state) };
  });

  const fallbackOrChunks: Prisma.ClientWhereInput[] = [];
  const fallbackChunkSize = 100;
  for (let index = 0; index < fallbackTuples.length; index += fallbackChunkSize) {
    const chunk = fallbackTuples.slice(index, index + fallbackChunkSize);
    fallbackOrChunks.push({
      OR: chunk.map((tuple) => ({
        nameNormalized: tuple.nameNormalized,
        cityNormalized: tuple.cityNormalized,
        state: tuple.state
      }))
    });
  }

  const whereOr: Prisma.ClientWhereInput[] = [];
  if (cnpjSet.size > 0) {
    whereOr.push({
      OR: [{ cnpjNormalized: { in: Array.from(cnpjSet) } }, { cnpj: { in: Array.from(cnpjSet) } }]
    });
  }
  whereOr.push(...fallbackOrChunks);

  const existingClients = whereOr.length
    ? await prisma.client.findMany({
        where: {
          ...sellerWhere(req),
          isArchived: false,
          OR: whereOr
        },
        select: {
          id: true,
          cnpj: true,
          cnpjNormalized: true,
          name: true,
          city: true,
          state: true,
          nameNormalized: true,
          cityNormalized: true
        }
      })
    : [];

  const byCnpj = new Map<string, string>();
  const byFallback = new Map<string, string>();

  existingClients.forEach((client) => {
    const normalizedCnpj = client.cnpjNormalized || normalizeCnpj(client.cnpj);
    if (normalizedCnpj) byCnpj.set(normalizedCnpj, client.id);

    const fallbackKey = buildFallbackKey(
      client.nameNormalized || client.name,
      client.cityNormalized || client.city,
      client.state
    );
    byFallback.set(fallbackKey, client.id);
  });

  const data = pageKeys.map((key) => {
    const matchedByCnpj = key.cnpjDigits ? byCnpj.get(key.cnpjDigits) : undefined;
    const matchedByFallback = key.fallbackKey ? byFallback.get(key.fallbackKey) : undefined;
    const clientId = matchedByCnpj || matchedByFallback || null;

    return {
      cnpjDigits: key.cnpjDigits || null,
      fallbackKey: key.fallbackKey || null,
      exists: Boolean(clientId),
      clientId
    };
  });

  res.json({ ...paginated, data });
});

router.post("/clients", validateBody(clientSchema), async (req, res) => {
  try {
    const ownerSellerId =
      req.user!.role === "vendedor"
        ? req.user!.id
        : req.user!.role === "gerente" || req.user!.role === "diretor"
          ? resolveOwnerId(req, req.body.ownerSellerId)
          : resolveOwnerId(req);

    const payload = withClientNormalizedFields({ ...req.body, ownerSellerId });
    await ensureClientIsNotDuplicate({ candidate: payload, scope: sellerWhere(req) });

    const data = await prisma.client.create({ data: payload });
    res.status(201).json(data);
  } catch (error) {
    if (error instanceof DuplicateClientError) {
      return res.status(error.statusCode).json({ message: error.message, existingClient: error.existingClient, matchType: error.matchType });
    }
    if (isDatabaseUniqueViolation(error)) {
      return res.status(409).json({ message: DUPLICATE_CLIENT_MESSAGE });
    }
    throw error;
  }
});

// ✅ Preview (para UI: novos/duplicados/erros)
router.post("/clients/import/preview", async (req, res) => {
  const { rows, isValid } = resolveImportRows(req.body);
  if (!isValid) return res.status(400).json({ message: "Payload de importação inválido." });

  const preview = await buildImportPreview(req, rows);

  const novos = preview
    .filter((item) => item.status === "new")
    .map((item) => ({ rowNumber: item.rowNumber, row: item.row }));

  const duplicados = preview
    .filter((item) => item.status === "duplicate")
    .map((item) => ({
      rowNumber: item.rowNumber,
      row: item.row,
      existingClientId: item.existingClientId || null,
      reason: item.reason
    }));

  const erros = preview
    .filter((item) => item.status === "error")
    .map((item) => ({ rowNumber: item.rowNumber, row: item.row, message: item.error }));

  res.json({ novos, duplicados, erros });
});

// ✅ Alias: simulate (se você quiser um botão "Validar" sem importar)
router.post("/clients/import/simulate", async (req, res) => {
  const { rows, isValid } = resolveImportRows(req.body);
  if (!isValid) return res.status(400).json({ message: "Payload de importação inválido." });

  const preview = await buildImportPreview(req, rows);

  const summary = {
    total: preview.length,
    newCount: preview.filter((i) => i.status === "new").length,
    duplicateCount: preview.filter((i) => i.status === "duplicate").length,
    errorCount: preview.filter((i) => i.status === "error").length
  };

  res.json({ simulated: true, summary });
});

// ✅ Import (upsert inteligente)
router.post("/clients/import", async (req, res) => {
  const { rows, isValid } = resolveImportRows(req.body);
  if (!isValid) return res.status(400).json({ message: "Payload de importação inválido." });

  const preview = await buildImportPreview(req, rows);
  const scopedWhere = sellerWhere(req);

  const existingClients = await prisma.client.findMany({
    where: { ...scopedWhere, isArchived: false },
    select: {
      id: true,
      name: true,
      nameNormalized: true,
      fantasyName: true,
      code: true,
      city: true,
      state: true,
      cnpj: true
    }
  });

  const byCnpj = new Map<string, (typeof existingClients)[number]>();
  const byCode = new Map<string, (typeof existingClients)[number]>();

  const indexClient = (client: (typeof existingClients)[number]) => {
    const cnpj = normalizeCnpj(client.cnpj);
    if (cnpj) byCnpj.set(cnpj, client);

    const code = normalizeClientCode(client.code);
    if (code) byCode.set(code, client);

  };

  existingClients.forEach(indexClient);

  let created = 0;
  let updated = 0;
  let ignored = 0;
  let conflicts = 0;
  const errors: Array<{ rowNumber: number; clientName: string; message: string }> = [];
  const results: Array<{
    rowNumber: number;
    clientName: string;
    status: "IMPORTED" | "UPDATED" | "IGNORED" | "API_FAILURE";
    category: "imported" | "updated" | "ignored" | "duplicate" | "validation" | "api_error";
    reason: string;
  }> = [];

  const registerApiFailure = (rowNumber: number, clientName: string, message: string, category: "duplicate" | "validation" | "api_error" = "api_error") => {
    conflicts += 1;
    errors.push({ rowNumber, clientName, message });
    results.push({
      rowNumber,
      clientName,
      status: "API_FAILURE",
      category,
      reason: message
    });
  };

  for (const item of preview) {
    const rowAction = item.row?.action;
    const clientName = String(item.row?.name ?? "");

    if (item.status === "error") {
      registerApiFailure(item.rowNumber, clientName, item.error, "validation");
      continue;
    }

    if (rowAction === "skip") {
      ignored += 1;
      results.push({
        rowNumber: item.rowNumber,
        clientName,
        status: "IGNORED",
        category: "ignored",
        reason: "Linha ignorada por decisão do usuário."
      });
      continue;
    }

    try {
      const existingResolution = findImportExistingClient({
        payload: item.payload,
        byCnpj,
        byCode
      });

      if (existingResolution.match) {
        const { data: resolvedUpdateData, hasMeaningfulChanges, mergedClientForValidation } = resolveImportUpdateData(
          item.payload,
          req,
          existingResolution.match
        );

        if (!hasMeaningfulChanges) {
          ignored += 1;
          results.push({
            rowNumber: item.rowNumber,
            clientName,
            status: "IGNORED",
            category: "ignored",
            reason: "Cliente já existe e não há campos vazios para enriquecer."
          });
          continue;
        }

        await ensureClientIsNotDuplicate({
          candidate: mergedClientForValidation,
          scope: scopedWhere,
          ignoreClientId: existingResolution.match.id
        });

        const updatedClient = await prisma.client.update({
          where: { id: existingResolution.match.id },
          data: resolvedUpdateData
        });

        const updatedIndex = existingClients.findIndex((client) => client.id === updatedClient.id);
        if (updatedIndex >= 0) existingClients[updatedIndex] = { ...existingClients[updatedIndex], ...updatedClient };
        byCnpj.clear();
        byCode.clear();
        existingClients.forEach(indexClient);

        updated += 1;
        const reasonByMatch = existingResolution.reason === "cnpj" ? "CNPJ/CPF" : "código ERP";
        results.push({
          rowNumber: item.rowNumber,
          clientName,
          status: "UPDATED",
          category: "updated",
          reason: `Cliente existente identificado por ${reasonByMatch}; campos vazios atualizados.`
        });
        continue;
      }

      const payload = resolveImportCreateData(item.payload, req);
      await ensureClientIsNotDuplicate({ candidate: payload, scope: scopedWhere });
      const createdClient = await prisma.client.create({ data: payload });
      existingClients.push(createdClient as (typeof existingClients)[number]);
      indexClient(createdClient as (typeof existingClients)[number]);
      created += 1;
      results.push({
        rowNumber: item.rowNumber,
        clientName,
        status: "IMPORTED",
        category: "imported",
        reason: "Cliente importado com sucesso."
      });
    } catch (error) {
      if (isDatabaseUniqueViolation(error)) {
        registerApiFailure(item.rowNumber, clientName, "Cliente duplicado.", "duplicate");
        continue;
      }
      if (isDatabaseForeignKeyViolation(error)) {
        registerApiFailure(
          item.rowNumber,
          clientName,
          `Vendedor responsável não encontrado: ${String(item.row?.ownerSellerId || "").trim() || "(vazio)"}`,
          "validation"
        );
        continue;
      }
      registerApiFailure(item.rowNumber, clientName, getImportPersistenceErrorMessage(error));
    }
  }

  res.json({ created, updated, ignored, conflicts, errors, results });
});

router.put("/clients/:id", validateBody(clientSchema.partial()), async (req, res) => {
  const old = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ message: "Não encontrado" });
  if (req.user!.role === "vendedor" && old.ownerSellerId !== req.user!.id) {
    return res.status(403).json({ message: "Sem permissão" });
  }

  try {
    const mergedClientForValidation = {
      name: req.body.name ?? old.name,
      city: req.body.city ?? old.city,
      state: req.body.state ?? old.state,
      cnpj: req.body.cnpj ?? old.cnpj,
      code: req.body.code ?? old.code
    };

    const normalized = normalizeClientForComparison(mergedClientForValidation);

    await ensureClientIsNotDuplicate({
      candidate: mergedClientForValidation,
      scope: sellerWhere(req),
      ignoreClientId: old.id
    });

    const data = await prisma.client.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        state: normalized.state,
        nameNormalized: normalized.nameNormalized,
        cityNormalized: normalized.cityNormalized,
        cnpjNormalized: normalized.cnpjNormalized || null
      }
    });
    res.json(data);
  } catch (error) {
    if (error instanceof DuplicateClientError) {
      return res.status(error.statusCode).json({ message: error.message, existingClient: error.existingClient, matchType: error.matchType });
    }
    if (isDatabaseUniqueViolation(error)) {
      return res.status(409).json({ message: DUPLICATE_CLIENT_MESSAGE });
    }
    throw error;
  }
});

router.delete("/clients/:id", async (req, res) => {
  const old = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ message: "Não encontrado" });
  if (req.user!.role === "vendedor" && old.ownerSellerId !== req.user!.id) {
    return res.status(403).json({ message: "Sem permissão" });
  }

  await prisma.$transaction(async (tx) => {
    await tx.activity.deleteMany({
      where: {
        OR: [
          { clientId: req.params.id },
          { opportunity: { clientId: req.params.id } }
        ]
      }
    });

    await tx.timelineEvent.deleteMany({
      where: {
        OR: [
          { clientId: req.params.id },
          { opportunity: { clientId: req.params.id } }
        ]
      }
    });

    await tx.contact.deleteMany({ where: { clientId: req.params.id } });
    await tx.agendaStop.deleteMany({ where: { clientId: req.params.id } });
    await tx.agendaEvent.deleteMany({
      where: {
        OR: [
          { clientId: req.params.id },
          { opportunity: { clientId: req.params.id } }
        ]
      }
    });
    await tx.opportunityChangeLog.deleteMany({ where: { opportunity: { clientId: req.params.id } } });
    await tx.opportunity.deleteMany({ where: { clientId: req.params.id } });
    await tx.client.delete({ where: { id: req.params.id } });
  });

  res.status(204).send();
});

router.get("/clients/:id/contacts", async (req, res) => {
  const client = await prisma.client.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req),
      isArchived: false
    },
    select: { id: true }
  });

  if (!client) return res.status(404).json({ message: "Não encontrado" });

  const contacts = await prisma.contact.findMany({
    where: {
      clientId: req.params.id,
      ...sellerWhere(req)
    },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }]
  });

  res.json(contacts);
});

router.post(
  "/clients/:id/contacts",
  validateBody(clientContactSchema),
  async (req, res) => {
    const client = await prisma.client.findFirst({
      where: {
        id: req.params.id,
        ...sellerWhere(req),
        isArchived: false
      },
      select: { id: true }
    });

    if (!client) return res.status(404).json({ message: "Não encontrado" });

    const data = await prisma.contact.create({
      data: {
        ...req.body,
        clientId: req.params.id,
        ownerSellerId: resolveOwnerId(req),
      },
    });

    res.status(201).json(data);
  }
);

router.put(
  "/clients/:id/contacts/:contactId",
  validateBody(clientContactSchema.partial()),
  async (req, res) => {
    const client = await prisma.client.findFirst({
      where: {
        id: req.params.id,
        ...sellerWhere(req),
        isArchived: false
      },
      select: { id: true }
    });

    if (!client) return res.status(404).json({ message: "Não encontrado" });

    const existingContact = await prisma.contact.findFirst({
      where: {
        id: req.params.contactId,
        clientId: req.params.id,
        ...sellerWhere(req)
      },
      select: { id: true }
    });

    if (!existingContact) return res.status(404).json({ message: "Não encontrado" });

    const data = await prisma.contact.update({
      where: { id: req.params.contactId },
      data: req.body
    });

    res.json(data);
  }
);

router.delete("/clients/:id/contacts/:contactId", async (req, res) => {
  const existingContact = await prisma.contact.findFirst({
    where: {
      id: req.params.contactId,
      clientId: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true }
  });

  if (!existingContact) return res.status(404).json({ message: "Não encontrado" });

  await prisma.contact.delete({ where: { id: req.params.contactId } });
  res.status(204).send();
});

// Compatibilidade legada: empresas agora são clientes do tipo PJ
router.get("/companies", async (req, res) => {
  const data = await prisma.client.findMany({
    where: {
      ...sellerWhere(req),
      isArchived: false,
      clientType: "PJ"
    },
    orderBy: { createdAt: "desc" }
  });

  res.json(
    data.map((client) => ({
      id: client.id,
      name: client.name,
      cnpj: client.cnpj,
      segment: client.segment,
      ownerSellerId: client.ownerSellerId,
      createdAt: client.createdAt
    }))
  );
});

router.post("/companies", validateBody(companySchema), async (req, res) => {
  try {
    const payload = withClientNormalizedFields({
      name: req.body.name,
      city: "Não informado",
      state: "NI",
      region: req.user?.region || "Nacional",
      clientType: ClientType.PJ,
      cnpj: req.body.cnpj,
      segment: req.body.segment,
      ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId)
    });

    await ensureClientIsNotDuplicate({ candidate: payload, scope: sellerWhere(req) });

    const data = await prisma.client.create({ data: payload });

    res.status(201).json(data);
  } catch (error) {
    if (error instanceof DuplicateClientError) {
      return res.status(error.statusCode).json({ message: error.message, existingClient: error.existingClient, matchType: error.matchType });
    }
    if (isDatabaseUniqueViolation(error)) {
      return res.status(409).json({ message: DUPLICATE_CLIENT_MESSAGE });
    }
    throw error;
  }
});

router.put("/companies/:id", validateBody(companySchema.partial()), async (req, res) => {
  const old = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ message: "Não encontrado" });

  try {
    const mergedClientForValidation = {
      name: req.body.name ?? old.name,
      city: old.city,
      state: old.state,
      cnpj: req.body.cnpj ?? old.cnpj,
      code: req.body.code ?? old.code
    };

    await ensureClientIsNotDuplicate({
      candidate: mergedClientForValidation,
      scope: sellerWhere(req),
      ignoreClientId: old.id
    });

    const normalized = normalizeClientForComparison(mergedClientForValidation);

    const data = await prisma.client.update({
      where: { id: req.params.id },
      data: {
        ...(req.body.name ? { name: req.body.name } : {}),
        ...(req.body.cnpj !== undefined ? { cnpj: req.body.cnpj } : {}),
        ...(req.body.segment !== undefined ? { segment: req.body.segment } : {}),
        clientType: ClientType.PJ,
        state: normalized.state,
        nameNormalized: normalized.nameNormalized,
        cityNormalized: normalized.cityNormalized,
        cnpjNormalized: normalized.cnpjNormalized || null
      }
    });

    res.json(data);
  } catch (error) {
    if (error instanceof DuplicateClientError) {
      return res.status(error.statusCode).json({ message: error.message, existingClient: error.existingClient, matchType: error.matchType });
    }
    if (isDatabaseUniqueViolation(error)) {
      return res.status(409).json({ message: DUPLICATE_CLIENT_MESSAGE });
    }
    throw error;
  }
});

router.delete("/companies/:id", async (req, res) => {
  await prisma.client.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

router.get("/contacts", async (req, res) =>
  res.json(
    await prisma.contact.findMany({
      where: sellerWhere(req),
      include: { client: true },
      orderBy: { createdAt: "desc" }
    })
  )
);

router.post("/contacts", validateBody(contactSchema), async (req, res) =>
  res
    .status(201)
    .json(await prisma.contact.create({ data: { ...req.body, ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId) } }))
);

router.put("/contacts/:id", validateBody(contactSchema.partial()), async (req, res) =>
  res.json(await prisma.contact.update({ where: { id: req.params.id }, data: req.body }))
);

router.delete("/contacts/:id", async (req, res) => {
  await prisma.contact.delete({ where: { id: req.params.id } });
  res.status(204).send();
});


router.post("/ai/opportunity-insight", async (req, res) => {
  const parsed = opportunityInsightRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido", errors: parsed.error.issues });
  }

  const opportunity = await prisma.opportunity.findUnique({
    where: { id: parsed.data.opportunityId },
    select: {
      id: true,
      stage: true,
      value: true,
      createdAt: true,
      lastContactAt: true,
      followUpDate: true,
      client: {
        select: {
          id: true,
          name: true
        }
      },
      timelineEvents: {
        select: {
          id: true,
          createdAt: true,
          type: true,
          description: true
        },
        orderBy: { createdAt: "desc" },
        take: 25
      },
      activities: {
        select: {
          id: true,
          createdAt: true,
          date: true,
          notes: true,
          description: true,
          result: true
        },
        orderBy: { createdAt: "desc" },
        take: 15
      }
    }
  });

  if (!opportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const recentTimelineObservation = opportunity.timelineEvents
    .find((event) => event.description?.trim())
    ?.description
    ?.trim();

  const recentActivityWithObservation = opportunity.activities.find((activity) => {
    const texts = [activity.notes, activity.description, activity.result].map((text) => text?.trim() || "");
    return texts.some(Boolean);
  });

  const recentActivityObservation = recentActivityWithObservation
    ? [recentActivityWithObservation.notes, recentActivityWithObservation.description, recentActivityWithObservation.result]
      .map((text) => text?.trim() || "")
      .find(Boolean) || null
    : null;

  const recentActivityDate = recentActivityWithObservation
    ? (recentActivityWithObservation.date || recentActivityWithObservation.createdAt).getTime()
    : 0;
  const recentTimelineDate = opportunity.timelineEvents.find((event) => event.description?.trim())?.createdAt.getTime() || 0;

  const latestObservation = recentActivityDate >= recentTimelineDate
    ? recentActivityObservation
    : (recentTimelineObservation || recentActivityObservation);

  const insight = generateOpportunityInsight({
    ...opportunity,
    observationInsight: parseActivityObservation(latestObservation)
  });

  return res.json(insight);
});

const opportunityMessageQuerySchema = z.object({
  opportunityId: z.string().trim().min(1, "opportunityId é obrigatório")
});

const clientSummaryParamsSchema = z.object({
  clientId: z.string().trim().min(1, "clientId é obrigatório")
});

router.get("/ai/client-summary/:clientId", async (req, res) => {
  const parsed = clientSummaryParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ message: "Parâmetros inválidos", errors: parsed.error.issues });
  }

  const { clientId } = parsed.data;

  const client = await prisma.client.findFirst({
    where: {
      id: clientId,
      ...sellerWhere(req),
      isArchived: false
    },
    select: {
      id: true,
      name: true,
      city: true,
      state: true
    }
  });

  if (!client) {
    return res.status(404).json({ message: "Cliente não encontrado" });
  }

  const [recentActivities, openOpportunities, lastWonOpportunity] = await Promise.all([
    prisma.activity.findMany({
      where: { clientId: client.id },
      orderBy: [{ dueDate: "desc" }, { createdAt: "desc" }],
      take: 20,
      select: {
        type: true,
        notes: true,
        done: true,
        dueDate: true,
        createdAt: true,
        date: true
      }
    }),
    prisma.opportunity.findMany({
      where: {
        clientId: client.id,
        stage: { notIn: [...CLOSED_STAGE_VALUES] }
      },
      orderBy: [{ followUpDate: "asc" }, { createdAt: "desc" }],
      take: 20,
      select: {
        title: true,
        stage: true,
        followUpDate: true,
        value: true,
        notes: true,
        createdAt: true,
        lastContactAt: true
      }
    }),
    prisma.opportunity.findFirst({
      where: {
        clientId: client.id,
        stage: "ganho"
      },
      orderBy: [{ closedAt: "desc" }, { createdAt: "desc" }],
      select: {
        title: true,
        value: true,
        closedAt: true,
        createdAt: true
      }
    })
  ]);

  const recentObservations = recentActivities
    .map((activity) => ({ text: activity.notes?.trim() || "", createdAt: activity.createdAt }))
    .filter((activity) => Boolean(activity.text))
    .slice(0, 10);

  const lastContactCandidates = [
    ...recentActivities.map((activity) => activity.date || activity.dueDate || activity.createdAt),
    ...openOpportunities.map((opportunity) => opportunity.lastContactAt).filter(Boolean) as Date[],
    lastWonOpportunity?.closedAt || null,
    lastWonOpportunity?.createdAt || null
  ].filter(Boolean) as Date[];

  const lastContact = lastContactCandidates.length
    ? new Date(Math.max(...lastContactCandidates.map((value) => value.getTime())))
    : null;

  const payload = generateClientSummary({
    client: {
      name: client.name,
      city: client.city,
      state: client.state
    },
    recentActivities: recentActivities.map((activity) => ({
      type: activity.type,
      notes: activity.notes,
      done: activity.done,
      dueDate: activity.dueDate,
      createdAt: activity.createdAt
    })),
    recentObservations,
    openOpportunities: openOpportunities.map((opportunity) => ({
      title: opportunity.title,
      stage: opportunity.stage,
      followUpDate: opportunity.followUpDate,
      value: opportunity.value,
      notes: opportunity.notes,
      createdAt: opportunity.createdAt
    })),
    lastWonOpportunity: lastWonOpportunity
      ? {
          title: lastWonOpportunity.title,
          value: lastWonOpportunity.value,
          closedAt: lastWonOpportunity.closedAt,
          updatedAt: lastWonOpportunity.createdAt
        }
      : null,
    lastContact
  });

  return res.json(payload);
});

router.get("/ai/opportunity-message", async (req, res) => {
  const parsed = opportunityMessageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Query inválida", errors: parsed.error.issues });
  }

  const opportunity = await prisma.opportunity.findUnique({
    where: { id: parsed.data.opportunityId },
    select: {
      id: true,
      title: true,
      stage: true,
      crop: true,
      productOffered: true,
      value: true,
      probability: true,
      notes: true,
      followUpDate: true,
      lastContactAt: true,
      createdAt: true,
      client: {
        select: {
          name: true,
          city: true,
          state: true
        }
      },
      ownerSeller: {
        select: {
          name: true
        }
      },
      timelineEvents: {
        select: {
          description: true,
          createdAt: true
        },
        orderBy: { createdAt: "desc" },
        take: 2
      },
      activities: {
        select: {
          notes: true,
          description: true,
          result: true,
          product: true,
          date: true,
          createdAt: true
        },
        orderBy: { createdAt: "desc" },
        take: 2
      }
    }
  });

  if (!opportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const message = await generateSalesMessage({
    clientName: opportunity.client?.name || null,
    title: opportunity.title,
    crop: opportunity.crop,
    productOffered: opportunity.productOffered,
    stage: opportunity.stage,
    city: opportunity.client?.city || null,
    state: opportunity.client?.state || null,
    sellerName: opportunity.ownerSeller?.name || null,
    value: opportunity.value,
    probability: opportunity.probability,
    notes: opportunity.notes,
    followUpDate: opportunity.followUpDate,
    lastContactAt: opportunity.lastContactAt,
    createdAt: opportunity.createdAt,
    timelineEvents: opportunity.timelineEvents,
    activities: opportunity.activities
  });

  return res.json({ message });
});

router.get("/ai/today-priorities", async (req, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ message: "Não autenticado" });
  }

  const todayStart = getUtcTodayStart();
  const openOpportunities = await prisma.opportunity.findMany({
    where: {
      ownerSellerId: req.user.id,
      stage: { notIn: [...CLOSED_STAGE_VALUES] }
    },
    select: {
      id: true,
      value: true,
      followUpDate: true,
      createdAt: true,
      lastContactAt: true,
      stage: true,
      clientId: true,
      ownerSellerId: true,
      title: true,
      notes: true,
      client: {
        select: {
          id: true,
          name: true,
          lastPurchaseDate: true,
          lastPurchaseValue: true,
          ownerSellerId: true,
          financialProfile: true,
          openTitlesTotal: true,
          overdueTitlesTotal: true
        }
      },
      timelineEvents: {
        select: { createdAt: true, description: true },
        orderBy: { createdAt: "desc" },
        take: 25
      },
      activities: {
        select: {
          createdAt: true,
          date: true,
          dueDate: true,
          done: true,
          notes: true,
          description: true,
          result: true
        },
        orderBy: { createdAt: "desc" },
        take: 15
      }
    }
  });

  const priorities = calculateTodayPriorities(openOpportunities, todayStart);

  return res.json(priorities);
});

router.get("/opportunities/seller-options", async (req, res) => {
  if (!req.user) return res.status(401).json({ message: "Não autenticado" });

  if (req.user.role === "vendedor") {
    const seller = await prisma.user.findFirst({
      where: { id: req.user.id, role: Role.vendedor, isActive: true },
      select: { id: true, name: true, role: true, isActive: true }
    });
    return res.json(seller ? [seller] : []);
  }

  const sellers = await prisma.user.findMany({
    where: { role: Role.vendedor, isActive: true },
    select: { id: true, name: true, role: true, isActive: true },
    orderBy: { name: "asc" }
  });
  return res.json(sellers);
});

router.get("/opportunities", async (req, res) => {
  const parsedFilters = parseOpportunityFilterParams(req);
  if ("error" in parsedFilters) return res.status(400).json({ message: parsedFilters.error });
  const shouldLogOpportunityDiagnostics = process.env.NODE_ENV !== "production";

  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined;
  const page = parsePositiveInt(req.query.page, 1);
  const pageSize = parsePositiveInt(req.query.pageSize, 20);
  const todayStart = getUtcTodayStart();
  const where = buildOpportunityWhere(req, parsedFilters.params, todayStart);

  if (shouldLogOpportunityDiagnostics) {
    console.info("[diag-opportunities-api][list][request]", {
      userId: req.user?.id,
      role: req.user?.role,
      endpoint: "/opportunities",
      filters: parsedFilters.params,
      prismaWhere: where,
      query: req.query
    });
  }

  const baseQuery = {
    where,
    include: {
      client: { select: { id: true, code: true, name: true, fantasyName: true, cnpj: true, city: true, state: true } },
      ownerSeller: { select: { id: true, name: true } }
    },
    orderBy: [{ expectedCloseDate: "asc" }, { value: "desc" }] as Prisma.Enumerable<Prisma.OpportunityOrderByWithRelationInput>
  };

  if (!hasPagination) {
    const opportunities: any[] = await prisma.opportunity.findMany(baseQuery);
    if (shouldLogOpportunityDiagnostics) {
      const totals = opportunities.reduce((acc, opportunity) => {
        const weighted = getWeightedValue(opportunity.value, opportunity.probability);
        const isOverdue = isOpportunityOverdue(opportunity, todayStart);
        return {
          count: acc.count + 1,
          value: acc.value + opportunity.value,
          weighted: acc.weighted + weighted,
          overdueCount: acc.overdueCount + (isOverdue ? 1 : 0)
        };
      }, { count: 0, value: 0, weighted: 0, overdueCount: 0 });
      const consideredOpportunities = opportunities.slice(0, 50).map((opportunity) => ({
        id: opportunity.id,
        title: opportunity.title,
        stage: opportunity.stage,
        value: opportunity.value,
        closedAt: toIsoStringOrNull(opportunity.closedAt),
        expectedCloseDate: toIsoStringOrNull(opportunity.expectedCloseDate),
        proposalDate: toIsoStringOrNull(opportunity.proposalDate),
        sellerId: opportunity.ownerSeller?.id || null,
        sellerName: opportunity.ownerSeller?.name || null
      }));
      console.info("[diag-opportunities-api][list][response]", {
        userId: req.user?.id,
        role: req.user?.role,
        endpoint: "/opportunities",
        filters: parsedFilters.params,
        totals,
        consideredOpportunities
      });
    }
    return res.json(opportunities.map((opportunity) => serializeOpportunity(opportunity, todayStart)));
  }

  const [total, opportunities] = await Promise.all([
    prisma.opportunity.count({ where }),
    prisma.opportunity.findMany({
      ...baseQuery,
      skip: (page - 1) * pageSize,
      take: pageSize
    })
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (shouldLogOpportunityDiagnostics) {
    const totals = opportunities.reduce((acc, opportunity) => {
      const weighted = getWeightedValue(opportunity.value, opportunity.probability);
      const isOverdue = isOpportunityOverdue(opportunity, todayStart);
      return {
        count: acc.count + 1,
        value: acc.value + opportunity.value,
        weighted: acc.weighted + weighted,
        overdueCount: acc.overdueCount + (isOverdue ? 1 : 0)
      };
    }, { count: 0, value: 0, weighted: 0, overdueCount: 0 });
    const consideredOpportunities = opportunities.slice(0, 50).map((opportunity) => ({
      id: opportunity.id,
      title: opportunity.title,
      stage: opportunity.stage,
      value: opportunity.value,
      closedAt: toIsoStringOrNull(opportunity.closedAt),
      expectedCloseDate: toIsoStringOrNull(opportunity.expectedCloseDate),
      proposalDate: toIsoStringOrNull(opportunity.proposalDate),
      sellerId: opportunity.ownerSeller?.id || null,
      sellerName: opportunity.ownerSeller?.name || null
    }));
    console.info("[diag-opportunities-api][list][response-paginated]", {
      userId: req.user?.id,
      role: req.user?.role,
      endpoint: "/opportunities",
      filters: parsedFilters.params,
      prismaWhere: where,
      pagination: { page, pageSize, total },
      returnedTotals: totals,
      consideredOpportunities
    });
  }
  return res.json({
    items: opportunities.map((opportunity) => serializeOpportunity(opportunity, todayStart)),
    total,
    page,
    pageSize,
    totalPages
  });
});

router.get("/opportunities/summary", async (req, res) => {
  const parsedFilters = parseOpportunityFilterParams(req);
  if ("error" in parsedFilters) return res.status(400).json({ message: parsedFilters.error });
  const shouldLogOpportunityDiagnostics = process.env.NODE_ENV !== "production";

  const todayStart = getUtcTodayStart();
  const where = buildOpportunityWhere(req, parsedFilters.params, todayStart);

  if (shouldLogOpportunityDiagnostics) {
    console.info("[diag-opportunities-api][summary][request]", {
      userId: req.user?.id,
      role: req.user?.role,
      filters: parsedFilters.params,
      query: req.query
    });
  }

  const opportunities: any[] = await prisma.opportunity.findMany({
    where,
    select: {
      id: true,
      title: true,
      value: true,
      stage: true,
      crop: true,
      season: true,
      probability: true,
      followUpDate: true,
      closedAt: true,
      expectedCloseDate: true,
      proposalDate: true,
      ownerSeller: { select: { id: true, name: true } }
    }
  });

  const totalsByStage: Record<string, { value: number; weighted: number }> = {};
  const countByStage: Record<string, number> = {};
  const breakdownByCrop: Record<string, { value: number; weighted: number; count: number }> = {};
  const breakdownBySeason: Record<string, { value: number; weighted: number; count: number }> = {};

  const pipelineMetrics = calculatePipelineMetrics(opportunities, todayStart);
  let wonCount = 0;
  let lossCount = 0;

  for (const opportunity of opportunities) {
    const weighted = getWeightedValue(opportunity.value, opportunity.probability);

    if (opportunity.stage === "ganho") wonCount += 1;
    if (opportunity.stage === "perdido") lossCount += 1;

    if (!totalsByStage[opportunity.stage]) totalsByStage[opportunity.stage] = { value: 0, weighted: 0 };
    totalsByStage[opportunity.stage].value += opportunity.value;
    totalsByStage[opportunity.stage].weighted += weighted;
    countByStage[opportunity.stage] = (countByStage[opportunity.stage] || 0) + 1;

    const cropKey = opportunity.crop || "não informado";
    if (!breakdownByCrop[cropKey]) breakdownByCrop[cropKey] = { value: 0, weighted: 0, count: 0 };
    breakdownByCrop[cropKey].value += opportunity.value;
    breakdownByCrop[cropKey].weighted += weighted;
    breakdownByCrop[cropKey].count += 1;

    const seasonKey = opportunity.season || "não informado";
    if (!breakdownBySeason[seasonKey]) breakdownBySeason[seasonKey] = { value: 0, weighted: 0, count: 0 };
    breakdownBySeason[seasonKey].value += opportunity.value;
    breakdownBySeason[seasonKey].weighted += weighted;
    breakdownBySeason[seasonKey].count += 1;

  }

  const closedCount = wonCount + lossCount;
  const conversionRate = parsedFilters.params.status === "open" || closedCount === 0 ? 0 : (wonCount / closedCount) * 100;
  if (shouldLogOpportunityDiagnostics) {
    const wonOpportunities = opportunities.filter((opportunity) => opportunity.stage === "ganho");
    const sample = opportunities.slice(0, 50).map((opportunity) => ({
      id: opportunity.id,
      title: opportunity.title,
      stage: opportunity.stage,
      value: opportunity.value,
      closedAt: toIsoStringOrNull(opportunity.closedAt),
      expectedCloseDate: toIsoStringOrNull(opportunity.expectedCloseDate),
      proposalDate: toIsoStringOrNull(opportunity.proposalDate),
      sellerId: opportunity.ownerSeller?.id || null,
      sellerName: opportunity.ownerSeller?.name || null
    }));
    console.info("[diag-opportunities-api][summary][response]", {
      userId: req.user?.id,
      role: req.user?.role,
      endpoint: "/opportunities/summary",
      filters: parsedFilters.params,
      prismaWhere: where,
      totalCount: opportunities.length,
      pipelineTotal: pipelineMetrics.pipelineTotal,
      weightedTotal: pipelineMetrics.weightedTotal,
      overdueCount: pipelineMetrics.overdueCount,
      conversionRate,
      wonDiagnostics: { count: wonOpportunities.length },
      consideredOpportunities: sample
    });
  }
  res.json({
    pipelineTotalValue: pipelineMetrics.pipelineTotal,
    weightedValue: pipelineMetrics.weightedTotal,
    pipelineTotal: pipelineMetrics.pipelineTotal,
    weightedTotal: pipelineMetrics.weightedTotal,
    overdueCount: pipelineMetrics.overdueCount,
    overdueValue: pipelineMetrics.overdueValue,
    conversionRate,
    byStage: totalsByStage,
    totalPipelineValue: pipelineMetrics.pipelineTotal,
    totalWeightedValue: pipelineMetrics.weightedTotal,
    totalsByStage,
    countByStage,
    totalCount: opportunities.length,
    breakdownByCrop,
    breakdownBySeason
  });
});

router.patch("/opportunities/:id/close", async (req, res) => {
  const stage = normalizeStageInput(String(req.body?.stage || ""));
  if (!stage || !CLOSED_STAGES.has(stage)) {
    return res.status(400).json({ message: "Etapa de encerramento inválida." });
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const existingOpportunity = await prisma.opportunity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true, clientId: true, ownerSellerId: true, stage: true }
  });

  if (!existingOpportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const closedAt = new Date();
  const shouldLogOpportunityDiagnostics = process.env.NODE_ENV !== "production";

  if (shouldLogOpportunityDiagnostics) {
    console.info("[diag-opportunities-api][close][request]", {
      opportunityId: req.params.id,
      body: req.body,
      userId: req.user?.id,
      userRole: req.user?.role
    });
  }

  try {
    const updatedOpportunity = await prisma.$transaction(async (tx) => {
      const opportunity = await tx.opportunity.update({
        where: { id: req.params.id },
        data: {
          stage,
          closedAt,
          expectedCloseDate: closedAt,
          followUpDate: closedAt
        },
        include: {
          client: {
            select: { id: true, code: true, name: true, fantasyName: true, cnpj: true, city: true, state: true }
          },
          ownerSeller: {
            select: { id: true, name: true }
          }
        }
      });

      if (existingOpportunity.stage !== stage) {
        await tx.timelineEvent.create({
          data: {
            type: "mudanca_etapa",
            description: `Etapa alterada de ${STAGE_LABELS[STAGE_ALIASES[existingOpportunity.stage] || "prospeccao"]} para ${STAGE_LABELS[stage]}`,
            opportunityId: opportunity.id,
            clientId: opportunity.clientId,
            ownerSellerId: opportunity.ownerSellerId
          }
        });
      }

      await tx.timelineEvent.create({
        data: {
          type: "status",
          description: reason
            ? `Oportunidade encerrada como ${STAGE_LABELS[stage]}. Motivo/observação: ${reason}`
            : `Oportunidade encerrada como ${STAGE_LABELS[stage]}`,
          opportunityId: opportunity.id,
          clientId: opportunity.clientId,
          ownerSellerId: opportunity.ownerSellerId
        }
      });

      return opportunity;
    });

    const responsePayload = {
      message: `Oportunidade encerrada como ${STAGE_LABELS[stage]}`,
      opportunity: serializeOpportunity(updatedOpportunity, getUtcTodayStart())
    };

    if (shouldLogOpportunityDiagnostics) {
      console.info("[diag-opportunities-api][close][response]", {
        status: 200,
        opportunityId: responsePayload.opportunity?.id,
        stage: responsePayload.opportunity?.stage
      });
    }

    return res.status(200).json(responsePayload);
  } catch (error) {
    if (shouldLogOpportunityDiagnostics) {
      console.error("[diag-opportunities-api][close][error]", {
        opportunityId: req.params.id,
        error
      });
    }
    return res.status(422).json({
      message: "Não foi possível encerrar a oportunidade. Verifique as regras de negócio e tente novamente."
    });
  }
});

router.patch("/opportunities/:id/closed-report", async (req, res) => {
  const parsed = closedOpportunityEditSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message || "Payload inválido para edição." });
  }

  const existingOpportunity = await prisma.opportunity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req),
      stage: { in: ["ganho", "perdido"] }
    },
    include: {
      client: {
        select: { id: true, code: true, name: true, fantasyName: true, cnpj: true, city: true, state: true }
      },
      ownerSeller: {
        select: { id: true, name: true }
      }
    }
  });

  if (!existingOpportunity) {
    return res.status(404).json({ message: "Oportunidade encerrada não encontrada." });
  }

  const nextValues = parsed.data;
  const normalizedCrop = nextValues.crop === undefined ? undefined : (nextValues.crop?.trim() || null);
  const normalizedSeason = nextValues.season === undefined ? undefined : (nextValues.season?.trim() || null);

  const changedFields: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];

  if (nextValues.title !== undefined && nextValues.title !== existingOpportunity.title) {
    changedFields.push({ field: "title", oldValue: existingOpportunity.title, newValue: nextValues.title });
  }
  if (nextValues.value !== undefined && nextValues.value !== existingOpportunity.value) {
    changedFields.push({ field: "value", oldValue: String(existingOpportunity.value), newValue: String(nextValues.value) });
  }
  if (normalizedCrop !== undefined && normalizedCrop !== existingOpportunity.crop) {
    changedFields.push({ field: "crop", oldValue: existingOpportunity.crop, newValue: normalizedCrop });
  }
  if (normalizedSeason !== undefined && normalizedSeason !== existingOpportunity.season) {
    changedFields.push({ field: "season", oldValue: existingOpportunity.season, newValue: normalizedSeason });
  }
  if (nextValues.stage !== undefined && nextValues.stage !== existingOpportunity.stage) {
    changedFields.push({ field: "stage", oldValue: existingOpportunity.stage, newValue: nextValues.stage });
  }

  if (!changedFields.length) {
    return res.status(200).json({
      message: "Nenhuma alteração detectada.",
      opportunity: serializeOpportunity(existingOpportunity, getUtcTodayStart())
    });
  }

  const actorId = req.user?.id;
  if (!actorId) {
    return res.status(401).json({ message: "Usuário autenticado não encontrado." });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedOpportunity = await tx.opportunity.update({
      where: { id: req.params.id },
      data: {
        ...(nextValues.title !== undefined ? { title: nextValues.title } : {}),
        ...(nextValues.value !== undefined ? { value: nextValues.value } : {}),
        ...(normalizedCrop !== undefined ? { crop: normalizedCrop } : {}),
        ...(normalizedSeason !== undefined ? { season: normalizedSeason } : {}),
        ...(nextValues.stage !== undefined ? { stage: nextValues.stage } : {})
      },
      include: {
        client: {
          select: { id: true, code: true, name: true, fantasyName: true, cnpj: true, city: true, state: true }
        },
        ownerSeller: {
          select: { id: true, name: true }
        }
      }
    });

    await tx.opportunityChangeLog.createMany({
      data: changedFields.map((fieldChange) => ({
        opportunityId: updatedOpportunity.id,
        actorId,
        field: fieldChange.field,
        oldValue: fieldChange.oldValue,
        newValue: fieldChange.newValue
      }))
    });

    await Promise.all(changedFields.map((fieldChange) =>
      tx.timelineEvent.create({
        data: {
          type: fieldChange.field === "stage" ? "mudanca_etapa" : "status",
          description: `Edição de oportunidade encerrada: ${fieldChange.field} de '${fieldChange.oldValue ?? "—"}' para '${fieldChange.newValue ?? "—"}'`,
          opportunityId: updatedOpportunity.id,
          clientId: updatedOpportunity.clientId,
          ownerSellerId: updatedOpportunity.ownerSellerId
        }
      })
    ));

    return updatedOpportunity;
  });

  return res.json({
    message: "Oportunidade encerrada atualizada com sucesso.",
    opportunity: serializeOpportunity(updated, getUtcTodayStart())
  });
});

router.post("/opportunities/import", async (req, res) => {
  const payload = opportunityImportPayloadSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ message: "Payload inválido para importação." });

  const rows = payload.data.rows;
  const createClientIfMissing = Boolean(payload.data.options?.createClientIfMissing);
  const dryRun = Boolean(payload.data.options?.dryRun);
  const dedupe = {
    ...DEFAULT_OPPORTUNITY_IMPORT_DEDUPE,
    ...(payload.data.options?.dedupe ?? {})
  };

  const startedAt = new Date();
  const result = await processOpportunityImport({
    req,
    rows,
    createClientIfMissing,
    dryRun,
    dedupe
  });
  const finishedAt = new Date();

  console.info("[opportunities/import][audit]", {
    actorId: req.user?.id,
    actorEmail: req.user?.email,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    totalRows: rows.length,
    totalProcessed: result.summary.totalProcessed,
    created: result.summary.created,
    updated: result.summary.updated,
    ignored: result.summary.ignored,
    failed: result.summary.failed,
    batchSize: OPPORTUNITY_IMPORT_BATCH_SIZE,
    dryRun
  });

  return res.status(200).json({
    ...result,
    message: "Importação concluída",
    summary: {
      ...result.summary,
      created: result.summary.created,
      updated: result.summary.updated,
      ignored: result.summary.ignored,
      conflicts: result.summary.failed
    }
  });
});

router.post("/opportunities/import/preview", async (req, res) => {
  const payload = opportunityImportPayloadSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ message: "Payload inválido para preview." });

  const rows = payload.data.rows;
  const createClientIfMissing = Boolean(payload.data.options?.createClientIfMissing);
  const dedupe = {
    ...DEFAULT_OPPORTUNITY_IMPORT_DEDUPE,
    ...(payload.data.options?.dedupe ?? {}),
    mode: payload.data.options?.dedupe?.mode ?? "skip"
  };

  const result = await processOpportunityImport({
    req,
    rows,
    createClientIfMissing,
    dryRun: true,
    dedupe
  });

  return res.status(200).json(result);
});

router.get("/opportunities/import/dictionary", async (_req, res) => {
  return res.status(200).json({
    columns: [
      { key: "titulo", required: true, example: "Algodão Safra 25/26" },
      { key: "cliente", required: true, example: "Coop X" },
      { key: "vendedor_responsavel", required: true, notes: "nome do vendedor; também aceitamos email_responsavel" },
      { key: "email_responsavel", required: true, notes: "compatível com arquivos legados" },
      { key: "etapa", required: true, accepted: ["prospeccao", "negociacao", "proposta", "ganho"] },
      { key: "valor", required: true, example: "52000.00", notes: "use ponto como decimal" },
      { key: "probabilidade", required: true, notes: "0 a 100" },
      { key: "data_entrada", required: true, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
      { key: "follow_up", required: true, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
      { key: "area_ha", required: false },
      { key: "ticket_esperado_ha", required: false },
      { key: "cultura", required: false },
      { key: "safra", required: false },
      { key: "produto_ofertado", required: false },
      { key: "fechamento_previsto", required: false, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
      { key: "ultimo_contato", required: false, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
      { key: "observacoes", required: false },
      { key: "status", required: false, accepted: ["open", "closed"] }
    ],
    tips: [
      "Se 'cliente' não existir e a opção 'Criar cliente automaticamente' estiver ligada, será criado como PJ com dados mínimos.",
      "Etapa inválida vira erro na linha (não bloqueia o arquivo todo).",
      "Datas inválidas viram erro na linha."
    ]
  });
});



const productSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  priceTableCode: z.string().trim().min(1).max(60).optional()
});

const loadOpportunityPriceRules = async () => {
  const configs = await prisma.appConfig.findMany({
    where: { key: { in: ["erp.ultrafv3.priceVariations", "erp.ultrafv3.prices"] } },
    select: { key: true, value: true },
  });
  const configByKey = new Map(configs.map((config) => [config.key, config.value]));

  const parseRows = (value: string | undefined) => {
    if (!value?.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        for (const key of ["items", "data", "rows", "results", "content"]) {
          if (Array.isArray(record[key])) return record[key] as unknown[];
        }
      }
    } catch {
      return [];
    }
    return [];
  };

  return {
    priceVariations: parseRows(configByKey.get("erp.ultrafv3.priceVariations")),
    erpPrices: parseRows(configByKey.get("erp.ultrafv3.prices")),
  };
};

const opportunityItemPayloadSchema = z.object({
  productId: z.string().optional(),
  lineNumber: z.number().int().positive().optional(),
  erpProductCode: z.string().trim().min(1).max(60).optional(),
  erpProductClassCode: z.string().trim().min(1).max(60).optional(),
  productNameSnapshot: z.string().trim().min(1).max(240).optional(),
  unit: z.string().trim().max(30).optional(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  discountType: z.enum(["value", "percent"]).optional(),
  discountValue: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional()
});

const computeOpportunityItemTotals = (payload: { quantity: number; unitPrice: number; discountType?: "value" | "percent"; discountValue?: number }) => {
  const quantity = Number(payload.quantity || 0);
  const unitPrice = Number(payload.unitPrice || 0);
  const grossTotal = Number((quantity * unitPrice).toFixed(2));
  const discountType = payload.discountType || "value";
  const discountValue = Number(payload.discountValue || 0);
  // TODO: adicionar limites de desconto por perfil via Configurações.
  if (discountType === "percent" && (discountValue < 0 || discountValue > 100)) {
    throw Object.assign(new Error("Desconto percentual deve estar entre 0 e 100."), { status: 400 });
  }
  if (discountType === "value" && (discountValue < 0 || discountValue > grossTotal)) {
    throw Object.assign(new Error("Desconto em valor não pode ser maior que o valor bruto do item."), { status: 400 });
  }
  const rawDiscount = discountType === "percent" ? grossTotal * (discountValue / 100) : discountValue;
  const discountTotal = Number(Math.max(0, Math.min(grossTotal, rawDiscount)).toFixed(2));
  const netTotal = Number((grossTotal - discountTotal).toFixed(2));
  if (netTotal < 0) {
    throw Object.assign(new Error("Valor líquido do item não pode ser negativo."), { status: 400 });
  }
  return { grossTotal, discountTotal, netTotal, discountType, discountValue };
};

const mapOpportunityItemResponse = (item: any) => ({
  ...item,
  createdAt: toIsoStringOrNull(item.createdAt),
  updatedAt: toIsoStringOrNull(item.updatedAt)
});


const recalculateOpportunityValueFromItems = async (opportunityId: string) => {
  const aggregate = await prisma.opportunityItem.aggregate({
    where: { opportunityId },
    _sum: { netTotal: true }
  });
  const recalculatedValue = Number(Number(aggregate._sum.netTotal || 0).toFixed(2));
  await prisma.opportunity.update({ where: { id: opportunityId }, data: { value: recalculatedValue } });
  return recalculatedValue;
};

router.get("/products", async (_req, res) => {
  const products = await prisma.product.findMany({
    orderBy: [{ name: "asc" }],
    include: { prices: { orderBy: [{ validFrom: "desc" }] } }
  });
  return res.json(products);
});

const isSynchronizedProduct = (product: { rawErpPayload?: Prisma.JsonValue | null }) => {
  if (product.rawErpPayload == null) return false;
  if (typeof product.rawErpPayload !== "object") return true;
  if (Array.isArray(product.rawErpPayload)) return product.rawErpPayload.length > 0;
  return Object.keys(product.rawErpPayload).length > 0;
};

type HiddenProductDiagnosticReason = "inactive" | "not_synchronized" | "invalid_price";

router.get("/products/search", async (req, res) => {
  const parsed = productSearchQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ message: "Parâmetro q é obrigatório" });
  const q = parsed.data.q;
  const requestedPriceTableCode = normalizeOpportunityPriceTableCode(parsed.data.priceTableCode);
  const priceRules = await loadOpportunityPriceRules();
  const products = await prisma.product.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { erpProductCode: { contains: q, mode: "insensitive" } },
        { erpProductClassCode: { contains: q, mode: "insensitive" } },
        { className: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } }
      ]
    },
    take: 100,
    orderBy: [{ name: "asc" }],
    include: { prices: { orderBy: [{ validFrom: "desc" }] } }
  });

  const hiddenDiagnostics: Record<HiddenProductDiagnosticReason, number> = {
    inactive: 0,
    not_synchronized: 0,
    invalid_price: 0,
  };
  const hiddenSamples: Array<{
    id: string;
    erpProductCode: string;
    erpProductClassCode: string;
    reason: HiddenProductDiagnosticReason;
    price: number;
    priceTableMatched: boolean;
    priceSource: string;
  }> = [];

  const visibleProducts = products.flatMap((product) => {
    const pickedPrice = calculateOpportunityPriceForTable({
      product,
      priceTableCode: requestedPriceTableCode,
      priceVariations: priceRules.priceVariations,
      erpPrices: priceRules.erpPrices,
    });
    const stock = Number(product.stockQuantity || 0);
    const isActiveForErpOrder = product.isActive && !product.isSuspended;
    const isSynchronized = isSynchronizedProduct(product);
    const hasValidSelectedTablePrice = pickedPrice.price > 0 && pickedPrice.priceTableMatched;
    const hiddenReason: HiddenProductDiagnosticReason | null = !isActiveForErpOrder
      ? "inactive"
      : !isSynchronized
        ? "not_synchronized"
        : !hasValidSelectedTablePrice
          ? "invalid_price"
          : null;

    const normalizedErpProductCode = product.erpProductCode.replace(/^0+(?=\d)/, "");
    if (normalizedErpProductCode === "273") {
      logApiEvent("INFO", hiddenReason ? "product 273 search result rejected" : "product 273 search result accepted", {
        step: hiddenReason ? "search result rejected" : "search result accepted",
        source: "opportunityPriceService.searchProducts",
        query: q,
        priceTableCode: requestedPriceTableCode,
        productId: product.id,
        erpProductCode: product.erpProductCode,
        erpProductClassCode: product.erpProductClassCode,
        isActive: product.isActive,
        isSuspended: product.isSuspended,
        isSynchronized,
        stock,
        pickedPrice,
        hiddenReason,
        rejectionReason: hiddenReason,
        rejectionDetails: hiddenReason === "inactive"
          ? { isActive: product.isActive, isSuspended: product.isSuspended }
          : hiddenReason === "not_synchronized"
            ? { rawErpPayloadPresent: product.rawErpPayload != null }
            : hiddenReason === "invalid_price"
              ? { price: pickedPrice.price, priceTableMatched: pickedPrice.priceTableMatched, priceSource: pickedPrice.source, priceWarning: pickedPrice.priceWarning }
              : null,
      });
    } else if (normalizedErpProductCode === "228") {
      logApiEvent("INFO", `[products search] product ${normalizedErpProductCode} evaluated`, {
        query: q,
        priceTableCode: requestedPriceTableCode,
        productId: product.id,
        erpProductCode: product.erpProductCode,
        erpProductClassCode: product.erpProductClassCode,
        isActive: product.isActive,
        isSuspended: product.isSuspended,
        isSynchronized,
        stock,
        pickedPrice,
        hiddenReason,
      });
    }

    if (hiddenReason) {
      hiddenDiagnostics[hiddenReason] += 1;
      if (hiddenSamples.length < 5) {
        hiddenSamples.push({
          id: product.id,
          erpProductCode: product.erpProductCode,
          erpProductClassCode: product.erpProductClassCode,
          reason: hiddenReason,
          price: pickedPrice.price,
          priceTableMatched: pickedPrice.priceTableMatched,
          priceSource: pickedPrice.source,
        });
      }
      return [];
    }

    return [{
      id: product.id,
      name: product.name,
      erpProductCode: product.erpProductCode,
      erpProductClassCode: product.erpProductClassCode,
      className: product.className,
      unit: product.unit,
      price: pickedPrice.price,
      priceTableCode: pickedPrice.priceTableCode,
      priceTableMatched: pickedPrice.priceTableMatched,
      priceWarning: null,
      priceSource: pickedPrice.source,
      stock,
      brand: product.brand,
      groupName: product.groupName,
      status: stock <= 0 ? "sem estoque" : "disponível"
    }];
  }).slice(0, 30);

  const hiddenTotal = hiddenDiagnostics.inactive + hiddenDiagnostics.not_synchronized + hiddenDiagnostics.invalid_price;
  if (hiddenTotal > 0) {
    logApiEvent("INFO", "[products search] hidden invalid opportunity products", {
      query: q,
      priceTableCode: requestedPriceTableCode,
      visibleCount: visibleProducts.length,
      hiddenCount: hiddenTotal,
      hiddenDiagnostics,
      hiddenSamples,
    });
  }

  return res.json(visibleProducts);
});

router.get("/clients/diagnostics/duplicate-documents", async (_req, res) => {
  const duplicatedDocuments = await prisma.client.groupBy({
    by: ["cnpjNormalized"],
    where: { cnpjNormalized: { not: null }, isArchived: false },
    _count: { cnpjNormalized: true },
    having: {
      cnpjNormalized: {
        _count: { gt: 1 }
      }
    }
  });

  const details = await Promise.all(duplicatedDocuments.map(async (duplicate) => {
    const normalized = duplicate.cnpjNormalized;
    const clients = await prisma.client.findMany({
      where: { cnpjNormalized: normalized || undefined, isArchived: false },
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        fantasyName: true,
        cnpj: true,
        cnpjNormalized: true,
        ownerSellerId: true,
        createdAt: true,
        _count: {
          select: {
            opportunities: true,
            activities: true,
            timelineEvents: true
          }
        }
      }
    });
    return {
      normalizedDocument: normalized,
      totalClients: duplicate._count.cnpjNormalized,
      clients
    };
  }));

  return res.json({
    duplicates: details,
    instructions: [
      "Não execute DELETE automático.",
      "Ao mesclar, transfira oportunidades, atividades e histórico antes de desativar/arquivar o cadastro duplicado."
    ]
  });
});

const mergeDuplicatesSchema = z.object({
  primaryClientId: z.string().min(1),
  duplicateClientIds: z.array(z.string().min(1)).min(1),
  reason: z.string().trim().optional()
});

router.post("/clients/diagnostics/merge-duplicates", authorize("diretor", "gerente"), validateBody(mergeDuplicatesSchema), async (req, res) => {
  const { primaryClientId, duplicateClientIds, reason } = req.body as z.infer<typeof mergeDuplicatesSchema>;
  const uniqueDuplicateIds = Array.from(new Set<string>(duplicateClientIds.filter((id: string) => id !== primaryClientId)));
  if (uniqueDuplicateIds.length === 0) return res.status(400).json({ message: "Informe ao menos um cliente duplicado diferente do principal." });

  const [primary, duplicates] = await Promise.all([
    prisma.client.findUnique({ where: { id: primaryClientId } }),
    prisma.client.findMany({ where: { id: { in: uniqueDuplicateIds } } })
  ]);
  if (!primary) return res.status(404).json({ message: "Cliente principal não encontrado." });
  if (duplicates.length !== uniqueDuplicateIds.length) return res.status(404).json({ message: "Um ou mais clientes duplicados não foram encontrados." });

  const now = new Date();
  const archivedIds = await prisma.$transaction(async (tx) => {
    for (const duplicate of duplicates) {
      await tx.opportunity.updateMany({ where: { clientId: duplicate.id }, data: { clientId: primary.id } });
      await tx.activity.updateMany({ where: { clientId: duplicate.id }, data: { clientId: primary.id } });
      await tx.timelineEvent.updateMany({ where: { clientId: duplicate.id }, data: { clientId: primary.id } });
      await tx.contact.updateMany({ where: { clientId: duplicate.id }, data: { clientId: primary.id } });
      await tx.agendaEvent.updateMany({ where: { clientId: duplicate.id }, data: { clientId: primary.id } });
      await tx.agendaStop.updateMany({ where: { clientId: duplicate.id }, data: { clientId: primary.id } });

      await tx.client.update({
        where: { id: duplicate.id },
        data: {
          code: duplicate.code ? `${duplicate.code}__MERGED__${now.getTime()}` : null,
          cnpjNormalized: null,
          cnpj: duplicate.cnpj ? `${duplicate.cnpj} [MERGED INTO ${primary.id}]` : null,
          name: `[ARQUIVADO] ${duplicate.name}`,
          isArchived: true,
          archiveReason: reason || "manual_duplicate_merge"
        }
      });
    }
    return duplicates.map((item) => item.id);
  });

  return res.json({
    message: "Mesclagem concluída com sucesso.",
    primaryClientId,
    archivedDuplicateIds: archivedIds,
    reason: reason || null
  });
});

router.get("/products/:id", async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: { prices: { orderBy: [{ validFrom: "desc" }] } }
  });
  if (!product) return res.status(404).json({ message: "Produto não encontrado" });
  return res.json(product);
});

router.get("/opportunities/:id/items", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const items = await prisma.opportunityItem.findMany({
    where: { opportunityId: req.params.id },
    orderBy: [{ lineNumber: "asc" }],
    include: { product: true }
  });

  const totals = items.reduce(
    (acc, item) => ({ grossTotal: acc.grossTotal + item.grossTotal, discountTotal: acc.discountTotal + item.discountTotal, netTotal: acc.netTotal + item.netTotal }),
    { grossTotal: 0, discountTotal: 0, netTotal: 0 }
  );

  return res.json({
    items: items.map(mapOpportunityItemResponse),
    totals: {
      grossTotal: Number(totals.grossTotal.toFixed(2)),
      discountTotal: Number(totals.discountTotal.toFixed(2)),
      netTotal: Number(totals.netTotal.toFixed(2))
    }
  });
});

router.post("/opportunities/:id/items", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const parsed = opportunityItemPayloadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Payload inválido" });

  const payload = parsed.data;
  let product = null;
  if (payload.productId) {
    product = await prisma.product.findUnique({ where: { id: payload.productId } });
    if (!product) return res.status(404).json({ message: "Produto não encontrado" });
  }

  const maxLine = await prisma.opportunityItem.aggregate({
    where: { opportunityId: req.params.id },
    _max: { lineNumber: true }
  });

  const { grossTotal, discountTotal, netTotal, discountType, discountValue } = computeOpportunityItemTotals(payload);
  const nextLineNumber = payload.lineNumber || (maxLine._max.lineNumber || 0) + 1;

  const created = await prisma.opportunityItem.create({
    data: {
      opportunityId: req.params.id,
      productId: payload.productId || null,
      lineNumber: nextLineNumber,
      erpProductCode: payload.erpProductCode || product?.erpProductCode || "manual",
      erpProductClassCode: payload.erpProductClassCode || product?.erpProductClassCode || String(nextLineNumber),
      productNameSnapshot: payload.productNameSnapshot || product?.name || "Item sem produto",
      unit: payload.unit || product?.unit || null,
      quantity: payload.quantity,
      unitPrice: payload.unitPrice,
      discountType,
      discountValue,
      grossTotal,
      discountTotal,
      netTotal,
      notes: payload.notes || null
    },
    include: { product: true }
  });

  await recalculateOpportunityValueFromItems(req.params.id);

  return res.status(201).json(mapOpportunityItemResponse(created));
});

router.put("/opportunities/:id/items/:itemId", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const existing = await prisma.opportunityItem.findFirst({ where: { id: req.params.itemId, opportunityId: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Item não encontrado" });

  const parsed = opportunityItemPayloadSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Payload inválido" });

  const payload = parsed.data;
  const nextQuantity = payload.quantity ?? existing.quantity;
  const nextUnitPrice = payload.unitPrice ?? existing.unitPrice;
  const nextDiscountType = payload.discountType ?? existing.discountType;
  const nextDiscountValue = payload.discountValue ?? existing.discountValue;

  let product = null;
  const productId = payload.productId === undefined ? existing.productId : payload.productId;
  if (productId) {
    product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ message: "Produto não encontrado" });
  }

  const { grossTotal, discountTotal, netTotal } = computeOpportunityItemTotals({
    quantity: nextQuantity,
    unitPrice: nextUnitPrice,
    discountType: nextDiscountType,
    discountValue: nextDiscountValue
  });

  const updated = await prisma.opportunityItem.update({
    where: { id: existing.id },
    data: {
      productId: productId || null,
      lineNumber: payload.lineNumber ?? existing.lineNumber,
      erpProductCode: payload.erpProductCode ?? product?.erpProductCode ?? existing.erpProductCode,
      erpProductClassCode: payload.erpProductClassCode ?? product?.erpProductClassCode ?? existing.erpProductClassCode,
      productNameSnapshot: payload.productNameSnapshot ?? product?.name ?? existing.productNameSnapshot,
      unit: payload.unit ?? product?.unit ?? existing.unit,
      quantity: nextQuantity,
      unitPrice: nextUnitPrice,
      discountType: nextDiscountType,
      discountValue: nextDiscountValue,
      grossTotal,
      discountTotal,
      netTotal,
      notes: payload.notes === undefined ? existing.notes : payload.notes || null
    },
    include: { product: true }
  });

  await recalculateOpportunityValueFromItems(req.params.id);

  return res.json(mapOpportunityItemResponse(updated));
});

router.delete("/opportunities/:id/items/:itemId", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const existing = await prisma.opportunityItem.findFirst({ where: { id: req.params.itemId, opportunityId: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Item não encontrado" });

  await prisma.opportunityItem.delete({ where: { id: req.params.itemId } });
  await recalculateOpportunityValueFromItems(req.params.id);
  return res.status(204).send();
});

router.get("/opportunities/:id", async (req, res) => {
  const todayStart = getUtcTodayStart();
  const opportunity = await prisma.opportunity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    include: {
      client: {
        select: {
          id: true,
          code: true,
          name: true,
          fantasyName: true,
          cnpj: true,
          city: true,
          state: true
        }
      },
      ownerSeller: true
    }
  });

  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  return res.json(serializeOpportunity(opportunity, todayStart));
});


const ULTRAFV3_AUDIT_EXPECTED_HEADER_FIELDS = [
  "PEDIDO_ID",
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
] as const;

const ULTRAFV3_AUDIT_EXPECTED_ITEM_FIELDS = [
  "PEDIDO_ID",
  "ITEM",
  "CODPRODUTO",
  "CODPRODUTO_CLAS",
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
  "OBS",
  "VALOR_ICMS_DESON",
  "ICMS_DESON_DESCTO_FINANCEIRO",
] as const;

type ErpPayloadAuditDifference = {
  path: string;
  type: "missing" | "extra" | "type" | "format" | "value";
  current: unknown;
  expected: unknown;
  message: string;
};

const pickAuditFields = <T extends readonly string[]>(record: Record<string, unknown>, fields: T) =>
  Object.fromEntries(fields.map((field) => [field, record[field] ?? null]));

const buildExpectedUltraFv3ProductionPayload = (payload: UltraFv3OrderPayload): UltraFv3OrderPayload => ({
  ...pickAuditFields(payload, ULTRAFV3_AUDIT_EXPECTED_HEADER_FIELDS),
  ITENS: Array.isArray(payload.ITENS)
    ? payload.ITENS.map((item) => pickAuditFields(item, ULTRAFV3_AUDIT_EXPECTED_ITEM_FIELDS))
    : [],
}) as UltraFv3OrderPayload;

const isAuditBlank = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const addAuditRequiredFieldDifferences = (payload: UltraFv3OrderPayload, differences: ErpPayloadAuditDifference[]) => {
  for (const field of ULTRAFV3_AUDIT_EXPECTED_HEADER_FIELDS) {
    const current = payload[field];
    if (["PEDIDO_ID", "OBSERVACAO_INTERNA"].includes(field) ? current !== null : ["DATA_CANCELAMENTO", "OBS_PEDIDO"].includes(field) ? current === undefined || current === null : isAuditBlank(current)) {
      differences.push({
        path: field,
        type: "missing",
        current: current ?? null,
        expected: "valor obrigatório",
        message: `Campo obrigatório ausente no cabeçalho: ${field}.`,
      });
    }
  }

  if (typeof payload.NUM_PEDIDO !== "string") {
    differences.push({ path: "NUM_PEDIDO", type: "type", current: payload.NUM_PEDIDO ?? null, expected: "string", message: "NUM_PEDIDO deve ser string." });
  }
  const datePattern = /^\d{2}\.\d{2}\.\d{4}$/;
  for (const field of ["DATA_PEDIDO", "DATA_PREV_ENTREGA"] as const) {
    if (typeof payload[field] !== "string" || !datePattern.test(payload[field])) {
      differences.push({ path: field, type: "format", current: payload[field] ?? null, expected: "DD.MM.YYYY", message: `${field} deve estar no formato DD.MM.YYYY.` });
    }
  }
  if (payload.TIPO_MOVIMENTO !== "PEDIDO") {
    differences.push({ path: "TIPO_MOVIMENTO", type: "value", current: payload.TIPO_MOVIMENTO ?? null, expected: "PEDIDO", message: 'TIPO_MOVIMENTO deve ser "PEDIDO".' });
  }

  if (!Array.isArray(payload.ITENS) || payload.ITENS.length === 0) {
    differences.push({ path: "ITENS", type: "missing", current: payload.ITENS ?? null, expected: "ao menos um item", message: "ITENS deve conter ao menos um item." });
    return;
  }

  payload.ITENS.forEach((item, index) => {
    for (const field of ULTRAFV3_AUDIT_EXPECTED_ITEM_FIELDS) {
      const current = item[field];
      if (["PEDIDO_ID", "PESO_PRODUTO"].includes(field) ? current !== null : ["MOTIVO_CANCELAMENTO", "OBS"].includes(field) ? current === undefined || current === null : isAuditBlank(current)) {
        differences.push({
          path: `ITENS[${index}].${field}`,
          type: "missing",
          current: current ?? null,
          expected: "valor obrigatório",
          message: `Campo obrigatório ausente no item ${index + 1}: ${field}.`,
        });
      }
    }
    if (item.ITEM !== index + 1) {
      differences.push({ path: `ITENS[${index}].ITEM`, type: "value", current: item.ITEM ?? null, expected: index + 1, message: `ITENS[${index}].ITEM deve ser sequencial iniciando em 1.` });
    }
  });
};

const buildUltraFv3PayloadAudit = (payload: UltraFv3OrderPayload) => {
  const expectedPayload = buildExpectedUltraFv3ProductionPayload(payload);
  const differences: ErpPayloadAuditDifference[] = [];
  const expectedHeaderSet = new Set<string>([...ULTRAFV3_AUDIT_EXPECTED_HEADER_FIELDS, "ITENS"]);
  const expectedItemSet = new Set<string>(ULTRAFV3_AUDIT_EXPECTED_ITEM_FIELDS);

  for (const field of Object.keys(payload)) {
    if (!expectedHeaderSet.has(field)) {
      differences.push({
        path: field,
        type: "extra",
        current: payload[field],
        expected: "campo ausente no payload UltraFV3 validado em produção",
        message: `Campo extra no cabeçalho atual do CRM: ${field}.`,
      });
    }
  }

  if (Array.isArray(payload.ITENS)) {
    payload.ITENS.forEach((item, index) => {
      for (const field of Object.keys(item)) {
        if (!expectedItemSet.has(field)) {
          differences.push({
            path: `ITENS[${index}].${field}`,
            type: "extra",
            current: item[field],
            expected: "campo ausente no item UltraFV3 validado em produção",
            message: `Campo extra no item ${index + 1} atual do CRM: ${field}.`,
          });
        }
      }
    });
  }

  addAuditRequiredFieldDifferences(payload, differences);

  return {
    currentPayload: payload,
    expectedPayload,
    correctedPayload: expectedPayload,
    differences,
    divergentFields: differences.map((difference) => difference.path),
    requiredFields: {
      header: ULTRAFV3_AUDIT_EXPECTED_HEADER_FIELDS,
      items: ULTRAFV3_AUDIT_EXPECTED_ITEM_FIELDS,
    },
    fieldSources: {
      NUM_PEDIDO: "Reservado pelo CRM em sequência PostgreSQL global iniciada em 900001; qualquer NUMERO_PEDIDO retornado por /salesmen é apenas diagnóstico e não alimenta o payload.",
      OPERADOR: "Resolvido do vendedor UltraFV3 retornado em /salesmen que casa com o CODVENDEDOR do usuário CRM; usa o campo OPERADOR do SALESMAN e só mantém erpOperatorCode do usuário como fallback interno.",
      CODPRODUTO_CLAS: "Resolvido do item da oportunidade (OpportunityItem.erpProductClassCode), preenchido pela sincronização de produtos UltraFV3; se estiver vazio, o CRM bloqueia antes do POST /orders.",
      DESCRICAO_UNMED: "Resolvida do payload sincronizado do produto; para UND_MEDIDA SC, o CRM envia descrição compatível com SACO.",
    },
    recommendation: differences.length
      ? "Não fazer merge de alinhamento automático ainda: revisar os campos divergentes e confirmar com UltraFV3 se os campos extras devem ser removidos do envio real."
      : "Payload atual do CRM já está alinhado à projeção validada em produção para os campos auditados; seguir com merge somente após validação manual do relatório.",
  };
};

const buildErpDebugPayloadDetails = (payload: UltraFv3OrderPayload) => ({
  NUM_PEDIDO: payload.NUM_PEDIDO ?? null,
  PEDIDO_ID_IMPORTACAO: payload.PEDIDO_ID_IMPORTACAO ?? null,
  PARCEIRO: payload.PARCEIRO ?? null,
  DATA_PEDIDO: payload.DATA_PEDIDO ?? null,
  DATA_PREV_ENTREGA: payload.DATA_PREV_ENTREGA ?? null,
  CODVENDEDOR: payload.VENDEDOR ?? null,
  OPERADOR: payload.OPERADOR ?? null,
  TABELA_PRECO: payload.TABELA_PRECO ?? null,
  FORMA_PAGAMENTO: payload.FORMA ?? null,
  CONDICAO_RECEBIMENTO: payload.CODCONDREC ?? null,
  FILIAL: payload.CODFILIAL ?? null,
  OPERACAO: payload.CODOPER ?? null,
  itens: Array.isArray(payload.ITENS)
    ? payload.ITENS.map((item) => ({
        ITEM: item.ITEM ?? null,
        CODPRODUTO: item.CODPRODUTO ?? null,
        CODPRODUTO_CLAS: item.CODPRODUTO_CLAS ?? null,
        descricaoClassificacao: (item as Record<string, unknown>).DESCRICAO_CLASSIFICACAO ?? null,
        DESCRICAO_UNMED: item.DESCRICAO_UNMED ?? null,
        UND_MEDIDA: item.UND_MEDIDA ?? null,
        unidadeEnviada: item.UND_MEDIDA ?? null,
        quantidade: item.QTD_PEDIDO ?? null,
        unidade: item.UND_MEDIDA ?? item.DESCRICAO_UNMED ?? null,
        preco: item.PRECO ?? null,
      }))
    : [],
  vendedorErp: payload.VENDEDOR ?? null,
  operadorErp: payload.OPERADOR ?? null,
  numPedidoSalesmen: payload.NUM_PEDIDO ?? null,
  clienteErp: payload.PARCEIRO ?? null,
  produtosErp: Array.isArray(payload.ITENS)
    ? payload.ITENS.map((item) => ({
        item: item.ITEM ?? null,
        codigoProduto: item.CODPRODUTO ?? null,
        classificacaoProduto: item.CODPRODUTO_CLAS ?? null,
        descricaoClassificacao: (item as Record<string, unknown>).DESCRICAO_CLASSIFICACAO ?? null,
        descricaoUnidade: item.DESCRICAO_UNMED ?? null,
        unidadeEnviada: item.UND_MEDIDA ?? null,
        quantidade: item.QTD_PEDIDO ?? null,
        unidade: item.UND_MEDIDA ?? item.DESCRICAO_UNMED ?? null,
        preco: item.PRECO ?? null,
        precoLista: item.PRECO_LISTA ?? null,
        valorBruto: item.VALOR_BRUTO ?? null,
        valorDesconto: item.VALOR_DESCONTO ?? null,
        valorLiquido: item.VALOR_LIQUIDO ?? null,
      }))
    : [],
  formaPagamento: payload.FORMA ?? null,
  condicaoRecebimento: payload.CODCONDREC ?? null,
  tabelaPreco: payload.TABELA_PRECO ?? null,
  filial: payload.CODFILIAL ?? null,
  operacao: payload.CODOPER ?? null,
});

const ERP_DEBUG_ORDER_PARAM_FIELDS = [
  "paymentMethodCode",
  "receivingConditionCode",
  "priceTableCode",
  "branchCode",
  "operationCode",
  "expectedDeliveryDate",
] as const;

type ErpDebugOrderParamField = typeof ERP_DEBUG_ORDER_PARAM_FIELDS[number];
type ErpDebugOrderParamInput = Parameters<typeof normalizeErpOrderParameterCodes>[0];

const ERP_DEBUG_ORDER_PARAM_CONFIG_KEYS: Record<ErpDebugOrderParamField, string> = {
  paymentMethodCode: "erp.ultrafv3.paymentMethods",
  receivingConditionCode: "erp.ultrafv3.receivingConditions",
  priceTableCode: "erp.ultrafv3.priceTables",
  branchCode: "erp.ultrafv3.branches",
  operationCode: "erp.ultrafv3.operations",
  expectedDeliveryDate: "",
};

const pickDebugQueryValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
};

const parseErpDebugConfigRows = (value: string | null | undefined): unknown[] => {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["data", "items", "rows", "result", "results", "content"]) {
        if (Array.isArray(record[key])) return record[key] as unknown[];
      }
    }
  } catch {
    return [];
  }
  return [];
};

const formatDateInput = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const loadErpDebugFallbackParams = async (): Promise<Partial<Record<ErpDebugOrderParamField, unknown>>> => {
  const configs = await prisma.appConfig.findMany({
    where: { key: { in: Object.values(ERP_DEBUG_ORDER_PARAM_CONFIG_KEYS) } },
    select: { key: true, value: true },
  });
  const configByKey = new Map(configs.map((config) => [config.key, config.value]));

  return Object.fromEntries(
    ERP_DEBUG_ORDER_PARAM_FIELDS.map((field) => {
      if (field === "expectedDeliveryDate") return [field, formatDateInput(new Date())];
      const rows = parseErpDebugConfigRows(configByKey.get(ERP_DEBUG_ORDER_PARAM_CONFIG_KEYS[field]));
      return [field, rows[0] ?? null];
    }),
  ) as Partial<Record<ErpDebugOrderParamField, unknown>>;
};

const resolveErpDebugOrderParams = async (query: Request["query"]) => {
  const fallbackParams = await loadErpDebugFallbackParams();
  const paramsReceived = Object.fromEntries(
    ERP_DEBUG_ORDER_PARAM_FIELDS.map((field) => [
      field,
      Object.prototype.hasOwnProperty.call(query, field) ? pickDebugQueryValue(query[field]) : null,
    ]),
  ) as Record<ErpDebugOrderParamField, unknown>;

  const rawResolvedParams = Object.fromEntries(
    ERP_DEBUG_ORDER_PARAM_FIELDS.map((field) => [
      field,
      paramsReceived[field] !== null ? paramsReceived[field] : fallbackParams[field] ?? null,
    ]),
  ) as Record<ErpDebugOrderParamField, unknown>;

  const paramsResolved = normalizeErpOrderParameterCodes({ ...rawResolvedParams, simulateOnly: true } as ErpDebugOrderParamInput);
  const missingParams = ERP_DEBUG_ORDER_PARAM_FIELDS.filter((field) => !paramsResolved[field]);
  return { paramsReceived, rawResolvedParams, paramsResolved, missingParams };
};


router.get("/erp-integration/salesmen-diagnostic", authorize("diretor"), async (req, res) => {
  const correlationId = req.correlationId || randomUUID();
  try {
    const sellerCode = normalizeOptionalString(req.query.sellerCode);
    if (!sellerCode) return res.status(400).json({ error: "sellerCode obrigatório para diagnóstico sanitizado de /salesmen" });
    const body = await ultraFv3Client.request<unknown>("/salesmen", { correlationId, timeoutMs: ULTRAFV3_REQUEST_TIMEOUT_MS });
    const diagnostic = buildSalesmenDiagnostic(body, { sellerErpCode: sellerCode }, 200);
    logApiEvent("INFO", "[ultrafv3/order] salesmen-response-shape", { correlationId, ...diagnostic });
    return res.json(diagnostic);
  } catch (error: any) {
    const message = sanitizeErpOrderErrorMessage(error?.message || String(error));
    logApiEvent("WARN", "[ultrafv3/order] salesmen-response-shape", { correlationId, result: "failed", errorCode: message });
    return res.status(502).json({ error: message, correlationId });
  }
});


router.get("/erp-orders/zero-num-pedido-dry-run", authorize("diretor"), async (_req, res) => {
  const report = await getZeroNumPedidoDryRunReport();
  return res.json(report);
});

router.post("/erp-orders/preflight", authorize("diretor"), async (req, res) => {
  const correlationId = req.correlationId || randomUUID();
  try {
    const opportunityId = normalizeOptionalString(req.body?.opportunityId);
    if (!opportunityId) return res.status(400).json({ ready: false, error: "opportunityId_required", correlationId });
    const params = normalizeErpOrderParameterCodes({ ...(req.body || {}), simulateOnly: true });
    const opportunity = await prisma.opportunity.findFirst({
      where: { id: opportunityId },
      include: { client: true, ownerSeller: true, items: { orderBy: [{ lineNumber: "asc" }], include: { product: { select: { stockQuantity: true, unit: true, className: true, rawErpPayload: true } } } } }
    });
    if (!opportunity) return res.status(404).json({ ready: false, error: "opportunity_not_found", correlationId });
    const preview = await createErpOrderFromOpportunity(opportunity, params, { correlationId });
    const payload = preview.payloadSent as UltraFv3OrderPayload;
    return res.json({ ready: true, postOrdersSent: false, numPedido: payload.NUM_PEDIDO, sellerMatched: true, operatorResolved: Boolean(payload.OPERADOR), itemsValid: payload.ITENS.length > 0, warnings: [], salesmenDiagnostics: "salesmenDiagnostics" in preview ? preview.salesmenDiagnostics : null });
  } catch (error: any) {
    const status = Number(error?.status || 422);
    return res.status(status >= 400 && status < 600 ? status : 422).json({ ready: false, postOrdersSent: false, error: error?.code || "erp_order_preview_failed", message: sanitizeErpOrderErrorMessage(error?.message || String(error)), correlationId, salesmenDiagnostics: error?.diagnostics || null });
  }
});

router.get("/opportunities/:id/erp/payload-audit", async (req, res) => {
  const correlationId = req.correlationId || randomUUID();
  const opportunityId = req.params.id;
  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  logApiEvent("INFO", "[erp payload audit route] request started", {
    opportunityId,
    userId: req.user?.id ?? null,
    correlationId,
    requestId: req.requestId,
  });

  let debugParamsContext: Awaited<ReturnType<typeof resolveErpDebugOrderParams>> | null = null;

  try {
    debugParamsContext = await resolveErpDebugOrderParams(req.query);
    const { paramsReceived, rawResolvedParams, paramsResolved, missingParams } = debugParamsContext;
    if (missingParams.length) {
      throw Object.assign(new Error(`Parâmetro obrigatório ausente: ${missingParams[0]}`), {
        status: 400,
        paramsReceived,
        paramsResolved,
        missingParams,
      });
    }

    const opportunity = await prisma.opportunity.findFirst({
      where: { id: opportunityId, ...sellerWhere(req) },
      include: { client: true, ownerSeller: true, items: { orderBy: [{ lineNumber: "asc" }], include: { product: { select: { stockQuantity: true, unit: true, className: true, rawErpPayload: true } } } } }
    });
    if (!opportunity) throw Object.assign(new Error("Oportunidade não encontrada"), { status: 404, paramsReceived, paramsResolved, missingParams });

    const preview = await createErpOrderFromOpportunity(opportunity, paramsResolved, { correlationId });
    const payload = preview.payloadSent as UltraFv3OrderPayload;
    const audit = buildUltraFv3PayloadAudit(payload);
    const salesmenDiagnostics = "salesmenDiagnostics" in preview ? preview.salesmenDiagnostics : null;
    const classificationDiagnostics = "classificationDiagnostics" in preview ? preview.classificationDiagnostics : [];

    logApiEvent("INFO", "[ERP PAYLOAD AUDIT]", {
      opportunityId,
      correlationId,
      endpoint: "/orders",
      willSubmitOrders: false,
      paramsReceived,
      rawResolvedParams,
      paramsResolved,
      missingParams,
      divergentFields: audit.divergentFields,
      differences: audit.differences,
      salesmenDiagnostics,
      classificationDiagnostics,
    });

    return res.status(200).json({
      correlationId,
      simulated: true,
      postOrdersSent: false,
      endpoint: "/orders",
      message: "Auditoria comparativa gerada; nenhum POST /orders foi enviado ao UltraFV3.",
      paramsReceived,
      paramsResolved,
      missingParams,
      payloadAtual: audit.currentPayload,
      payloadEsperado: audit.expectedPayload,
      payloadCorrigido: audit.correctedPayload,
      diferencasEncontradas: audit.differences,
      camposDivergentes: audit.divergentFields,
      camposObrigatoriosValidados: audit.requiredFields,
      origemDocumental: audit.fieldSources,
      recomendacaoFinal: audit.recommendation,
      salesmenDiagnostics,
      classificationDiagnostics,
    });
  } catch (error: any) {
    const statusCandidate = Number(error?.status || 502);
    const status = statusCandidate >= 400 && statusCandidate < 600 ? statusCandidate : 502;
    const message = sanitizeErpOrderErrorMessage(typeof error?.message === "string" && error.message.trim() ? error.message : "Falha ao gerar auditoria do payload ERP.");
    logApiEvent(status >= 500 ? "ERROR" : "WARN", "[erp payload audit route] request failed", {
      opportunityId,
      correlationId,
      httpStatus: status,
      error: message,
      diagnostics: error?.diagnostics || null,
    });
    return res.status(status).json({
      correlationId,
      simulated: true,
      postOrdersSent: false,
      paramsReceived: error?.paramsReceived || debugParamsContext?.paramsReceived || null,
      paramsResolved: error?.paramsResolved || debugParamsContext?.paramsResolved || null,
      missingParams: Array.isArray(error?.missingParams) ? error.missingParams : debugParamsContext?.missingParams || [],
      payloadAtual: null,
      payloadEsperado: null,
      payloadCorrigido: null,
      diferencasEncontradas: [],
      camposDivergentes: [],
      status: "erro",
      message,
      salesmenDiagnostics: error?.diagnostics || null,
      ...(error?.payload ? { invalidPayload: error.payload } : {}),
    });
  }
});

router.get("/opportunities/:id/erp/debug-payload", async (req, res) => {
  const correlationId = req.correlationId || randomUUID();
  const opportunityId = req.params.id;
  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  logApiEvent("INFO", "[erp debug payload route] request started", {
    opportunityId,
    userId: req.user?.id ?? null,
    correlationId,
    requestId: req.requestId,
  });

  let debugParamsContext: Awaited<ReturnType<typeof resolveErpDebugOrderParams>> | null = null;

  try {
    debugParamsContext = await resolveErpDebugOrderParams(req.query);
    const { paramsReceived, rawResolvedParams, paramsResolved, missingParams } = debugParamsContext;
    if (missingParams.length) {
      throw Object.assign(new Error(`Parâmetro obrigatório ausente: ${missingParams[0]}`), {
        status: 400,
        paramsReceived,
        paramsResolved,
        missingParams,
      });
    }

    const opportunity = await prisma.opportunity.findFirst({
      where: { id: opportunityId, ...sellerWhere(req) },
      include: { client: true, ownerSeller: true, items: { orderBy: [{ lineNumber: "asc" }], include: { product: { select: { stockQuantity: true, unit: true, className: true, rawErpPayload: true } } } } }
    });
    if (!opportunity) throw Object.assign(new Error("Oportunidade não encontrada"), { status: 404, paramsReceived, paramsResolved, missingParams });

    const preview = await createErpOrderFromOpportunity(opportunity, paramsResolved, { correlationId });
    const payload = preview.payloadSent as UltraFv3OrderPayload;
    const details = buildErpDebugPayloadDetails(payload);
    const salesmenDiagnostics = "salesmenDiagnostics" in preview ? preview.salesmenDiagnostics : null;
    const classificationDiagnostics = "classificationDiagnostics" in preview ? preview.classificationDiagnostics : [];

    logApiEvent("INFO", "[ERP DEBUG PAYLOAD]", {
      opportunityId,
      correlationId,
      endpoint: "/orders",
      willSubmitOrders: false,
      paramsReceived,
      rawResolvedParams,
      paramsResolved,
      missingParams,
      ...details,
      payload,
      salesmenDiagnostics,
      classificationDiagnostics,
    });

    return res.status(200).json({
      correlationId,
      simulated: true,
      postOrdersSent: false,
      endpoint: "/orders",
      message: "Payload gerado para debug; nenhum POST /orders foi enviado ao UltraFV3.",
      paramsReceived,
      paramsResolved,
      missingParams,
      payload,
      ...details,
      salesmenDiagnostics,
      classificationDiagnostics,
    });
  } catch (error: any) {
    const statusCandidate = Number(error?.status || 502);
    const status = statusCandidate >= 400 && statusCandidate < 600 ? statusCandidate : 502;
    const message = sanitizeErpOrderErrorMessage(typeof error?.message === "string" && error.message.trim() ? error.message : "Falha ao gerar debug do payload ERP.");
    logApiEvent(status >= 500 ? "ERROR" : "WARN", "[erp debug payload route] request failed", {
      opportunityId,
      correlationId,
      httpStatus: status,
      error: message,
      diagnostics: error?.diagnostics || null,
    });
    return res.status(status).json({
      correlationId,
      simulated: true,
      postOrdersSent: false,
      paramsReceived: error?.paramsReceived || debugParamsContext?.paramsReceived || null,
      paramsResolved: error?.paramsResolved || debugParamsContext?.paramsResolved || null,
      missingParams: Array.isArray(error?.missingParams) ? error.missingParams : debugParamsContext?.missingParams || [],
      payload: null,
      status: "erro",
      message,
      salesmenDiagnostics: error?.diagnostics || null,
      ...(error?.payload ? { invalidPayload: error.payload } : {}),
    });
  }
});

const erpOrderProtocolTestSchema = erpOrderGenerationSchema.extend({
  opportunityId: z.string().trim().min(1),
  confirmation: z.literal("CONFIRMAR_TESTE_ULTRAFV3"),
  numPedidoMode: z.literal("zero"),
});

router.post("/erp-orders/protocol-test", authorize("diretor"), async (req, res) => {
  const correlationId = req.correlationId || randomUUID();
  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  if (!env.ultraFv3OrderProtocolTestEnabled) {
    return res.status(403).json({
      error: "feature_disabled",
      message: "Teste de protocolo UltraFV3 desabilitado. Defina ULTRAFV3_ORDER_PROTOCOL_TEST_ENABLED=true somente durante a janela controlada.",
      correlationId,
    });
  }

  const parsed = erpOrderProtocolTestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_confirmation_or_payload",
      message: parsed.error.issues[0]?.message || "Payload inválido para teste de protocolo UltraFV3.",
      correlationId,
    });
  }

  try {
    const opportunity = await prisma.opportunity.findFirst({
      where: { id: parsed.data.opportunityId },
      include: { client: true, ownerSeller: true, items: { orderBy: [{ lineNumber: "asc" }], include: { product: { select: { stockQuantity: true, unit: true, className: true, rawErpPayload: true } } } } },
    });
    if (!opportunity) return res.status(404).json({ error: "opportunity_not_found", correlationId });
    const report = await runUltraFv3OrderProtocolTest(opportunity, parsed.data, { correlationId });
    return res.status(200).json(report);
  } catch (error: any) {
    const statusCandidate = Number(error?.status || 502);
    const status = statusCandidate >= 400 && statusCandidate < 600 ? statusCandidate : 502;
    const report = error?.protocolTestReport && typeof error.protocolTestReport === "object"
      ? sanitizeErpOrderPayload(error.protocolTestReport)
      : null;
    return res.status(status).json({
      error: status === 409 ? "duplicate_or_uncertain_attempt" : "protocol_test_failed",
      message: sanitizeErpOrderErrorMessage(error?.message || String(error)),
      correlationId,
      ...(report ? { report } : {}),
    });
  }
});

const logErpOrderRouteDiagnostic = (
  level: "INFO" | "WARN" | "ERROR",
  message: "[ERP ORDER ROUTE HIT]" | "[ERP ORDER ERROR]",
  context: {
    correlationId: string;
    opportunityId: string;
    userId: string | null;
    startedAt: number;
    routeStage: string;
  },
  extra: Record<string, unknown> = {},
) => {
  logApiEvent(level, message, {
    correlationId: context.correlationId,
    opportunityId: context.opportunityId,
    userId: context.userId,
    durationMs: Date.now() - context.startedAt,
    routeStage: context.routeStage,
    ...extra,
  });
};

router.post(["/opportunities/:id/erp/orders", "/opportunities/:id/orders"], async (req, res) => {
  try {
  const correlationId = req.correlationId || randomUUID();
  const opportunityId = req.params.id;
  const routeStartedAt = Date.now();
  const routeTimestamp = new Date(routeStartedAt).toISOString();
  let finalLogWritten = false;
  let normalizedParams = {} as ReturnType<typeof normalizeErpOrderParameterCodes>;
  let parameterDiagnostics = {} as ReturnType<typeof getErpOrderParameterDiagnostics>;
  let opportunity: any = null;
  let previousOrderCount = 0;

  req.correlationId = correlationId;
  req.erpOrderRouteHit = true;
  req.erpOrderFailureStage = "handler";
  res.setHeader("x-correlation-id", correlationId);
  logApiEvent("INFO", "[erp order route] request started", {
    routeHit: true,
    opportunityId,
    userId: req.user?.id ?? null,
    correlationId,
    requestId: req.requestId,
    timestamp: routeTimestamp,
  });
  logErpOrderRouteDiagnostic("INFO", "[ERP ORDER ROUTE HIT]", {
    correlationId,
    opportunityId,
    userId: req.user?.id ?? null,
    startedAt: routeStartedAt,
    routeStage: "route-hit",
  }, {
    requestId: req.requestId,
    timestamp: routeTimestamp,
  });

  const logRouteFinal = (completion: "finish" | "close") => {
    if (finalLogWritten) return;
    finalLogWritten = true;
    logApiEvent(res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO", "[erp order route] request finished", {
      routeHit: true,
      opportunityId,
      userId: req.user?.id ?? null,
      correlationId,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      startedAt: routeTimestamp,
      completion,
      responseFinished: res.writableEnded,
      httpStatus: res.statusCode,
      durationMs: Date.now() - routeStartedAt,
    });
  };

  res.once("finish", () => logRouteFinal("finish"));
  res.once("close", () => logRouteFinal("close"));

  // O fluxo pode incluir autenticação, consulta de vendedor e POST /orders. Ele precisa
  // de um orçamento maior que o timeout global da API, mas ainda menor que o proxy externo.
  res.setTimeout(ERP_ORDER_ROUTE_TIMEOUT_MS, () => {
    try {
      if (res.headersSent || res.writableEnded) return;
      logApiEvent("ERROR", "[erp order route] controlled route timeout", {
        routeHit: true,
        opportunityId,
        userId: req.user?.id ?? null,
        correlationId,
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        timeoutMs: ERP_ORDER_ROUTE_TIMEOUT_MS,
      });
      req.erpOrderFailureStage = "timeout";
      res.status(504).type("application/json").send(safeJsonStringify(buildControlledErpOrderFailurePayload({
        status: 504,
        etapa: "timeout",
        message: "O envio ao ERP excedeu o tempo limite. Confirme o pedido no ERP antes de tentar novamente.",
        correlationId,
      })));
    } catch (timeoutError) {
      logApiEvent("ERROR", "[erp order route] failed to write controlled timeout response", {
        routeHit: true,
        opportunityId,
        userId: req.user?.id ?? null,
        correlationId,
        requestId: req.requestId,
        error: timeoutError instanceof Error ? sanitizeErpOrderErrorMessage(timeoutError.message) : sanitizeErpOrderErrorMessage(String(timeoutError)),
      });
    }
  });

  try {
    req.erpOrderFailureStage = "validate-payload";
    normalizedParams = normalizeErpOrderParameterCodes({});
    parameterDiagnostics = getErpOrderParameterDiagnostics({});
    const opportunityParameterDefaults = await prisma.opportunity.findFirst({
      where: { id: opportunityId, ...sellerWhere(req) },
      select: { priceTableCode: true }
    });
    const erpOrderRequestBody = {
      ...(req.body || {}),
      priceTableCode: normalizeOptionalString(req.body?.priceTableCode) || normalizeOpportunityPriceTableCode(opportunityParameterDefaults?.priceTableCode)
    };
    const parsed = erpOrderGenerationSchema.safeParse(erpOrderRequestBody);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message || "Payload inválido";
      parameterDiagnostics = getErpOrderParameterDiagnostics(erpOrderRequestBody);
      logApiEvent("WARN", "[erp order route] request payload validation failed before UltraFV3", {
        routeHit: true,
        correlationId,
        opportunityId,
        userId: req.user?.id ?? null,
        payloadValidado: false,
        requestId: req.requestId,
        error: sanitizeErpOrderErrorMessage(message),
        ...parameterDiagnostics,
      });
      throw Object.assign(new Error(`Payload inválido: ${message}`), { status: 422, parameterDiagnostics });
    }
    normalizedParams = normalizeErpOrderParameterCodes(parsed.data);
    parameterDiagnostics = getErpOrderParameterDiagnostics(parsed.data);
    logApiEvent("INFO", "[erp order route] request payload validated before UltraFV3", {
      routeHit: true,
      correlationId,
      opportunityId,
      userId: req.user?.id ?? null,
      payloadValidado: true,
      requestId: req.requestId,
      simulateOnly: normalizedParams.simulateOnly,
      ...parameterDiagnostics,
    });

    req.erpOrderFailureStage = "load-opportunity";
    opportunity = await prisma.opportunity.findFirst({
      where: { id: opportunityId, ...sellerWhere(req) },
      include: { client: true, ownerSeller: true, items: { orderBy: [{ lineNumber: "asc" }], include: { product: { select: { stockQuantity: true, unit: true, className: true, rawErpPayload: true } } } } }
    });
    if (!opportunity) throw Object.assign(new Error("Oportunidade não encontrada"), { status: 404 });

    previousOrderCount = await prisma.erpOrderSync.count({ where: { opportunityId: opportunity.id } });
    req.erpOrderFailureStage = "submit-order";
    const sync = await createErpOrderFromOpportunity(opportunity, parsed.data, { correlationId });

    if (!normalizedParams.simulateOnly) {
      try {
        req.erpOrderFailureStage = "persist-timeline";
        const erpOrderObservation = normalizedParams.erpOrderObservation.trim();
        await prisma.timelineEvent.create({
          data: {
            type: "status",
            description: [
              `${previousOrderCount > 0 ? "Reenvio" : "Geração"} de pedido ERP concluída. ${sync.erpOrderNumber ? `Pedido ERP: ${sync.erpOrderNumber}.` : "Pedido enviado, número ERP não retornado."}`,
              erpOrderObservation ? `Observações do pedido ERP enviadas: ${erpOrderObservation}` : "",
            ].filter(Boolean).join(" "),
            clientId: opportunity.clientId,
            opportunityId: opportunity.id,
            ownerSellerId: opportunity.ownerSellerId
          }
        });
      } catch (timelineError) {
        logApiEvent("ERROR", "[erp order route] failed to persist success timeline", {
          opportunityId,
          correlationId,
          error: timelineError instanceof Error ? timelineError.message : String(timelineError),
        });
      }
    }

    req.erpOrderFailureStage = "handler";
    if (res.headersSent || res.writableEnded) return;
    return res.status(201).json({
      correlationId,
      id: sync.id,
      pedidoIdImportacao: sync.pedidoIdImportacao,
      numPedido: sync.numPedido,
      erpOrderNumber: sync.erpOrderNumber,
      status: sync.status,
      orderStatus: sync.orderStatus,
      simulated: normalizedParams.simulateOnly,
      payload: sanitizeErpOrderPayload(sync.payloadSent),
      response: sync.erpResponse
    });
  } catch (error: any) {
    const statusCandidate = Number(error?.status || 502);
    const status = statusCandidate >= 400 && statusCandidate < 600 ? statusCandidate : 502;
    const message = sanitizeErpOrderErrorMessage(typeof error?.message === "string" && error.message.trim() ? error.message : "Erro no envio ao ERP");
    const sanitizedStack = error instanceof Error && error.stack ? sanitizeErpOrderErrorMessage(error.stack) : null;
    const failureEndpoint = error?.endpoint || error?.ultraFv3Failure?.endpoint || error?.diagnostics?.endpoint || null;
    const missingConfig = Array.isArray(error?.missingConfig) ? error.missingConfig : undefined;
    const failureStage = missingConfig?.length
      ? "configuration"
      : failureEndpoint === "/salesmen"
      ? "resolve-salesman"
      : failureEndpoint === "/orders"
        ? "submit-order"
        : req.erpOrderFailureStage || "handler";
    req.erpOrderFailureStage = failureStage;

    if (opportunity && !normalizedParams.simulateOnly) {
      try {
        await prisma.timelineEvent.create({
          data: {
            type: "status",
            description: `${previousOrderCount > 0 ? "Reenvio" : "Geração"} de pedido ERP falhou: ${message}. correlationId=${correlationId}${error?.ultraFv3Failure?.PEDIDO_ID_IMPORTACAO ? `; PEDIDO_ID_IMPORTACAO=${error.ultraFv3Failure.PEDIDO_ID_IMPORTACAO}` : ""}.`,
            clientId: opportunity.clientId,
            opportunityId: opportunity.id,
            ownerSellerId: opportunity.ownerSellerId
          }
        });
      } catch (timelineError) {
        logApiEvent("ERROR", "[erp order route] failed to persist error timeline", {
          opportunityId,
          correlationId,
          error: timelineError instanceof Error ? timelineError.message : String(timelineError),
        });
      }
    }

    logErpOrderRouteDiagnostic(status >= 500 ? "ERROR" : "WARN", "[ERP ORDER ERROR]", {
      correlationId,
      opportunityId,
      userId: req.user?.id ?? null,
      startedAt: routeStartedAt,
      routeStage: failureStage,
    }, {
      requestId: req.requestId,
      httpStatus: status,
      endpoint: failureEndpoint || "/orders",
      error: message,
      pedidoIdImportacao: error?.pedidoIdImportacao,
      diagnostics: error?.diagnostics || null,
    });

    logApiEvent(status >= 500 ? "ERROR" : "WARN", "[erp order route] order submission rejected", {
      routeHit: true,
      opportunityId,
      userId: req.user?.id ?? null,
      correlationId,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      httpStatus: status,
      pedidoIdImportacao: error?.pedidoIdImportacao,
      existingErpOrderSyncId: error?.existingErpOrderSyncId,
      simulateOnly: normalizedParams.simulateOnly,
      error: message,
      stack: sanitizedStack,
      ...parameterDiagnostics
    });

    if (res.headersSent || res.writableEnded) return;
    try {
      if (status === 504 && (failureEndpoint === "/orders" || failureEndpoint === "/salesmen" || error?.diagnostics?.endpoint)) {
        return res.status(504).type("application/json").send(safeJsonStringify(buildUltraFv3TimeoutPayload({
          correlationId,
          endpoint: failureEndpoint || error?.diagnostics?.endpoint || "/orders",
          method: error?.diagnostics?.method || (failureEndpoint === "/salesmen" ? "GET" : "POST"),
          timeoutMs: error?.diagnostics?.timeoutMs || ULTRAFV3_REQUEST_TIMEOUT_MS,
        })));
      }

      const failurePayload = buildControlledErpOrderFailurePayload({
        correlationId,
        status,
        etapa: failureStage,
        message,
        details: {
          pedidoIdImportacao: error?.pedidoIdImportacao,
          existingErpOrderSyncId: error?.existingErpOrderSyncId,
          endpoint: failureEndpoint || "/orders",
          mensagem: message,
          ...(missingConfig?.length ? { missingConfig } : {}),
          ...(Array.isArray(error?.errors) ? { errors: error.errors } : {}),
          ...(error?.payload ? { payload: sanitizeErpOrderPayload(error.payload) } : {}),
          ...(error?.ultraFv3Failure ? { ultraFv3: sanitizeErpOrderPayload(error.ultraFv3Failure) } : {}),
          ...(error?.diagnostics ? { salesmenDiagnostics: sanitizeErpOrderPayload(error.diagnostics) } : {}),
          ...(error?.parameterDiagnostics || parameterDiagnostics),
        },
      });
      return res.status(status).type("application/json").send(safeJsonStringify(failurePayload));
    } catch (responseError) {
      logApiEvent("ERROR", "[erp order route] failed to serialize controlled error response", {
        routeHit: true,
        opportunityId,
        userId: req.user?.id ?? null,
        correlationId,
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        stack: responseError instanceof Error && responseError.stack ? sanitizeErpOrderErrorMessage(responseError.stack) : String(responseError),
      });
      if (res.headersSent || res.writableEnded) return;
      return res.status(500).type("application/json").send(safeJsonStringify(buildControlledErpOrderFailurePayload({
        status: 500,
        etapa: "serialize-response",
        message: "Erro interno ao preparar a resposta do envio ao ERP.",
        correlationId,
      })));
    }
  }
  } catch (fatalError) {
    const fallbackCorrelationId = req.correlationId || randomUUID();
    req.correlationId = fallbackCorrelationId;
    const message = sanitizeErpOrderErrorMessage(fatalError instanceof Error ? fatalError.message : String(fatalError));
    logApiEvent("ERROR", "[ERP ORDER ERROR]", {
      correlationId: fallbackCorrelationId,
      opportunityId: req.params.id,
      userId: req.user?.id ?? null,
      durationMs: 0,
      routeStage: req.erpOrderFailureStage || "handler",
      requestId: req.requestId,
      error: message,
    });

    logApiEvent("ERROR", "[erp order route] unhandled handler failure contained", {
      routeHit: true,
      opportunityId: req.params.id,
      userId: req.user?.id ?? null,
      correlationId: fallbackCorrelationId,
      requestId: req.requestId,
      payloadValidado: false,
      error: message,
    });
    if (res.headersSent || res.writableEnded) return;
    res.setHeader("x-correlation-id", fallbackCorrelationId);
    return res.status(500).type("application/json").send(safeJsonStringify(buildControlledErpOrderFailurePayload({
      status: 500,
      etapa: "handler",
      message,
      correlationId: fallbackCorrelationId,
    })));
  }
});


const pickLatestSyncErrorEntry = (syncErrors: unknown): Record<string, unknown> | null => {
  const rows = Array.isArray(syncErrors) ? syncErrors : syncErrors && typeof syncErrors === "object" ? [syncErrors] : [];
  const firstObject = rows.find((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row)));
  return firstObject || null;
};

const readSanitizedErrorText = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return sanitizeErpOrderErrorMessage(value.trim());
  }
  return null;
};

router.get("/opportunities/:id/erp/last-order-error", async (req, res) => {
  const correlationId = req.correlationId || randomUUID();
  const opportunityId = req.params.id;
  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);

  try {
    const opportunity = await prisma.opportunity.findFirst({ where: { id: opportunityId, ...sellerWhere(req) }, select: { id: true } });
    if (!opportunity) return res.status(404).json({ correlationId, message: "Oportunidade não encontrada" });

    const [lastErpOrderSync, lastTimelineEvent] = await Promise.all([
      prisma.erpOrderSync.findFirst({
        where: { opportunityId },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      }),
      prisma.timelineEvent.findFirst({
        where: { opportunityId },
        orderBy: [{ createdAt: "desc" }],
      }),
    ]);

    if (!lastErpOrderSync && !lastTimelineEvent) {
      return res.status(200).json({ correlationId, lastErpOrderSync: null, lastTimelineEvent: null, item: null, message: "Nenhum pedido ERP ou evento de timeline encontrado para esta oportunidade." });
    }

    const syncErrorEntry = pickLatestSyncErrorEntry(lastErpOrderSync?.syncErrors);
    const syncResponse = lastErpOrderSync?.erpResponse && typeof lastErpOrderSync.erpResponse === "object" && !Array.isArray(lastErpOrderSync.erpResponse)
      ? lastErpOrderSync.erpResponse as Record<string, unknown>
      : null;
    const rawSource = syncErrorEntry || syncResponse || null;
    const nestedUltra = rawSource?.ultraFv3 && typeof rawSource.ultraFv3 === "object" && !Array.isArray(rawSource.ultraFv3)
      ? rawSource.ultraFv3 as Record<string, unknown>
      : null;
    const rawStatus = rawSource?.status ?? nestedUltra?.status ?? syncResponse?.status ?? null;
    const status = typeof rawStatus === "number" ? rawStatus : Number.isFinite(Number(rawStatus)) ? Number(rawStatus) : lastErpOrderSync ? 502 : 500;
    const message = readSanitizedErrorText(rawSource?.message, nestedUltra?.message, syncResponse?.message, lastTimelineEvent?.description) || "Erro de pedido ERP sem mensagem detalhada.";
    const sourceCorrelationId = readSanitizedErrorText(rawSource?.correlationId, nestedUltra?.correlationId, lastErpOrderSync?.pedidoIdImportacao) || correlationId;
    const payload = rawSource?.payload ?? nestedUltra?.payload ?? lastErpOrderSync?.payloadSent ?? null;

    return res.status(200).json({
      correlationId,
      lastErpOrderSync: lastErpOrderSync ? sanitizeErpOrderPayload(lastErpOrderSync) : null,
      lastTimelineEvent: lastTimelineEvent ? sanitizeErpOrderPayload(lastTimelineEvent) : null,
      item: {
        source: lastErpOrderSync ? "ErpOrderSync" : "timeline",
        erpOrderSyncId: lastErpOrderSync?.id ?? null,
        timelineEventId: lastTimelineEvent?.id ?? null,
        createdAt: lastErpOrderSync?.createdAt ?? lastTimelineEvent?.createdAt ?? null,
        updatedAt: lastErpOrderSync?.updatedAt ?? null,
        payload: payload ? sanitizeErpOrderPayload(payload) : null,
        correlationId: sourceCorrelationId,
        status,
        message,
        rawError: rawSource ? sanitizeErpOrderPayload(rawSource) : lastTimelineEvent ? { description: sanitizeErpOrderErrorMessage(lastTimelineEvent.description) } : null,
      },
    });
  } catch (error) {
    const message = sanitizeErpOrderErrorMessage(error instanceof Error ? error.message : String(error));
    logApiEvent("ERROR", "[erp last order error route] request failed", {
      opportunityId,
      userId: req.user?.id ?? null,
      correlationId,
      error: message,
    });
    return res.status(500).json({ correlationId, status: 500, message });
  }
});

router.get("/opportunities/:id/erp/orders", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) }, select: { id: true } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const orders = await prisma.erpOrderSync.findMany({
    where: { opportunityId: req.params.id },
    orderBy: [
      { status: "desc" },
      { sentAt: "desc" },
      { createdAt: "desc" }
    ]
  });
  const sentOrders = orders.filter((order) => order.status === ErpOrderSyncStatus.sent);

  return res.status(200).json({
    items: sentOrders.length ? sentOrders : orders,
    hiddenSupersededErrorCount: sentOrders.length ? orders.filter((order) => order.status !== ErpOrderSyncStatus.sent).length : 0,
  });
});

router.get("/opportunities/:id/erp/orders/:orderId/pdf", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) }, select: { id: true } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const order = await prisma.erpOrderSync.findFirst({
    where: {
      id: req.params.orderId,
      opportunityId: req.params.id,
      status: ErpOrderSyncStatus.sent,
    },
    include: {
      opportunity: {
        include: {
          client: true,
          ownerSeller: { select: { name: true, erpCode: true } },
          items: { orderBy: [{ lineNumber: "asc" }], include: { product: { select: { name: true, className: true, unit: true, rawErpPayload: true } } } },
        },
      },
    },
  });

  if (!order) return res.status(404).json({ message: "Pedido ERP enviado não encontrado para esta oportunidade" });

  try {
    const pdfOrder = order as ErpOrderPdfRecord;
    const regenerate = req.query.regenerate === "true";
    const [company, metadata] = await Promise.all([
      getErpOrderPdfCompany(prisma, pdfOrder),
      getErpOrderPdfMetadata(prisma, pdfOrder),
    ]);
    const pdf = buildErpOrderPdf(pdfOrder, company, metadata, {
      logRawFields: true,
      regenerate,
    });
    const filename = getErpOrderPdfFilename(pdfOrder, metadata);
    if (regenerate) res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(pdf.length));
    return res.status(200).send(pdf);
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    const message = error instanceof Error ? error.message : "Falha ao gerar PDF do pedido ERP.";
    logApiEvent(status >= 500 ? "ERROR" : "WARN", "[erp order pdf route] PDF generation failed", {
      opportunityId: req.params.id,
      erpOrderSyncId: req.params.orderId,
      userId: req.user?.id ?? null,
      error: message,
    });
    return res.status(status).json({ message });
  }
});

router.post("/opportunities/:id/erp/orders/status", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) }, select: { id: true } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  try {
    const result = await syncErpOrderStatuses(req.params.id);
    const orders = await prisma.erpOrderSync.findMany({ where: { opportunityId: req.params.id }, orderBy: [{ createdAt: "desc" }] });
    return res.status(200).json({ ...result, items: orders });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[erp order status route] opportunity status sync failed", { opportunityId: req.params.id, error: details });
    return res.status(typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502).json({ message: "Falha ao consultar /orderStatus no UltraFV3.", details });
  }
});

router.post("/opportunities", validateBody(opportunitySchema), async (req, res) => {
  if (!assertProbability(req.body.probability)) return res.status(400).json({ message: "probability deve estar entre 0 e 100" });

  const proposalDate = (req.body.proposalDate || req.body.proposalEntryDate) as string | undefined;
  const expectedCloseDate = (req.body.expectedCloseDate || req.body.expectedReturnDate) as string | undefined;
  if (!validateDateOrder(proposalDate, expectedCloseDate)) {
    return res.status(400).json({ message: "expectedReturnDate não pode ser anterior a proposalEntryDate" });
  }

  const ownerSellerId = resolveOwnerId(req, req.body.ownerSellerId);
  const data = await prisma.opportunity.create({
    data: {
      ...(normalizeOpportunityDates(req.body) as any),
      ownerSellerId
    }
  });

  await createEvent({
    type: "status",
    description: `Oportunidade criada: ${data.title}`,
    opportunityId: data.id,
    clientId: data.clientId,
    ownerSellerId
  });

  if (req.body.notes?.trim()) {
    await createEvent({
      type: "comentario",
      description: req.body.notes,
      opportunityId: data.id,
      clientId: data.clientId,
      ownerSellerId
    });
  }

  return res.status(201).json(data);
});
router.put("/opportunities/:id", validateBody(opportunitySchema.partial()), async (req, res) => {
  if (!assertProbability(req.body.probability)) return res.status(400).json({ message: "probability deve estar entre 0 e 100" });

  const proposalDate = (req.body.proposalDate || req.body.proposalEntryDate) as string | undefined;
  const expectedCloseDate = (req.body.expectedCloseDate || req.body.expectedReturnDate) as string | undefined;
  if (!validateDateOrder(proposalDate, expectedCloseDate)) {
    return res.status(400).json({ message: "expectedReturnDate não pode ser anterior a proposalEntryDate" });
  }

  const previous = await prisma.opportunity.findUnique({
    where: { id: req.params.id },
    select: { stage: true, notes: true, clientId: true, ownerSellerId: true, followUpDate: true, probability: true }
  });

  const nextStageRaw = typeof req.body.stage === "string" ? STAGE_ALIASES[req.body.stage] : undefined;
  const isMovingToClosedStage = !!(nextStageRaw && CLOSED_STAGES.has(nextStageRaw) && previous && !CLOSED_STAGES.has(previous.stage));
  const closedAt = isMovingToClosedStage ? new Date() : null;

  const data = await prisma.opportunity.update({
    where: { id: req.params.id },
    data: {
      ...(normalizeOpportunityDates(req.body) as any),
      ...(closedAt ? { closedAt, expectedCloseDate: closedAt, followUpDate: closedAt } : {}),
      ...(nextStageRaw && !CLOSED_STAGES.has(nextStageRaw) ? { closedAt: null } : {})
    }
  });

  if (req.body.stage && previous && req.body.stage !== previous.stage) {
    const fromStage = STAGE_ALIASES[previous.stage] || "prospeccao";
    const toStage = STAGE_ALIASES[req.body.stage] || "prospeccao";
    await createEvent({
      type: "mudanca_etapa",
      description: `Etapa alterada de ${STAGE_LABELS[fromStage]} para ${STAGE_LABELS[toStage]}`,
      opportunityId: data.id,
      clientId: data.clientId,
      ownerSellerId: data.ownerSellerId
    });
  }

  if (req.body.followUpDate && previous && previous.followUpDate.getTime() !== data.followUpDate.getTime()) {
    await createEvent({
      type: "status",
      description: `Follow-up alterado de ${previous.followUpDate.toISOString().slice(0, 10)} para ${data.followUpDate.toISOString().slice(0, 10)}`,
      opportunityId: data.id,
      clientId: data.clientId,
      ownerSellerId: data.ownerSellerId
    });
  }

  if (req.body.probability !== undefined && previous && previous.probability !== data.probability) {
    await createEvent({
      type: "status",
      description: `Probabilidade alterada de ${previous.probability ?? 0}% para ${data.probability ?? 0}%`,
      opportunityId: data.id,
      clientId: data.clientId,
      ownerSellerId: data.ownerSellerId
    });
  }

  if (req.body.notes && previous && req.body.notes !== previous.notes) {
    await createEvent({
      type: "comentario",
      description: req.body.notes,
      opportunityId: data.id,
      clientId: data.clientId,
      ownerSellerId: data.ownerSellerId
    });
  }

  return res.json(data);
});
router.delete("/opportunities/:id", async (req, res) => { await prisma.opportunity.delete({ where: { id: req.params.id } }); res.status(204).send(); });

const resolveStatus = (payload: { done: boolean; endAt: Date }) => {
  if (payload.done) return "realizado";
  return payload.endAt.getTime() < getBrazilNow().getTime() ? "vencido" : "agendado";
};

const mapActivity = (activity: any) => {
  const status = resolveStatus({ done: activity.done, endAt: activity.dueDate });
  return {
    ...activity,
    ownerId: activity.ownerSellerId,
    status,
    isOverdue: status === "vencido"
  };
};

router.get("/activities", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const month = req.query.month ? String(req.query.month) : "";
  const doneQuery = req.query.done === "true" ? true : req.query.done === "false" ? false : undefined;
  const type = req.query.type ? String(req.query.type) : "";
  const clientId = req.query.clientId ? String(req.query.clientId) : "";
  const overdueOnly = req.query.overdueOnly === "true";
  const sellerId = req.user!.role === "vendedor" ? req.user!.id : (req.query.sellerId as string | undefined);

  const monthRange = month && /^\d{4}-\d{2}$/.test(month) ? getMonthRangeFromKey(month) : null;

  const activities = await prisma.activity.findMany({
    where: {
      ...(sellerId ? { ownerSellerId: sellerId } : sellerWhere(req)),
      ...(type ? resolveActivityTypeFilters(type) : {}),
      ...(doneQuery !== undefined ? { done: doneQuery } : {}),
      ...(monthRange
        ? (doneQuery === true
            ? { date: { gte: monthRange.start, lte: monthRange.end } }
            : { dueDate: { gte: monthRange.start, lte: monthRange.end } })
        : {}),
      ...(clientId
        ? {
            OR: [
              { clientId },
              { opportunity: { clientId } }
            ]
          }
        : {}),
      ...(q
        ? {
            OR: [
              { notes: { contains: q, mode: "insensitive" } },
              { client: { name: { contains: q, mode: "insensitive" } } },
              { opportunity: { title: { contains: q, mode: "insensitive" } } },
              { opportunity: { client: { name: { contains: q, mode: "insensitive" } } } }
            ]
          }
        : {})
    },
    include: {
      ownerSeller: { select: { id: true, name: true } },
      client: {
        select: {
          id: true,
          name: true
        }
      },
      opportunity: {
        select: {
          id: true,
          title: true,
          client: { select: { id: true, name: true } }
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });

  const mapped = activities.map(mapActivity);
  return res.json(overdueOnly ? mapped.filter((item) => item.isOverdue) : mapped);
});
router.get("/activities/monthly-counts", async (req, res) => {
  const month = (req.query.month as string | undefined) || getMonthKey(new Date());
  const sellerIdQuery = req.query.sellerId as string | undefined;

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ message: "month deve estar no formato YYYY-MM" });
  }

  const sellerId = req.user!.role === "vendedor" ? req.user!.id : sellerIdQuery;
  const { start, end } = getMonthRangeFromKey(month);

  const groupedCounts = await prisma.activity.groupBy({
    by: ["ownerSellerId", "type"],
    where: {
      ...(sellerId ? { ownerSellerId: sellerId } : sellerWhere(req)),
      createdAt: { gte: start, lte: end }
    },
    _count: { _all: true }
  });

  return res.json(
    groupedCounts.map((countEntry) => ({
      sellerId: countEntry.ownerSellerId,
      type: countEntry.type,
      month,
      logicalCount: countEntry._count._all
    }))
  );
});
router.post("/activities", validateBody(activitySchema), async (req, res) => {
  const ownerSellerId = resolveOwnerId(req, req.body.ownerSellerId || req.body.ownerId);
  const notes = (req.body.notes || req.body.description || "Sem notas").trim();

  const relatedOpportunity = req.body.opportunityId
    ? await prisma.opportunity.findFirst({
      where: {
        id: req.body.opportunityId,
        ...sellerWhere(req)
      },
      select: { id: true, clientId: true, title: true }
    })
    : null;

  if (req.body.opportunityId && !relatedOpportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const providedClientId = req.body.clientId || undefined;
  const resolvedClientId = relatedOpportunity?.clientId || providedClientId;

  if (providedClientId && relatedOpportunity && providedClientId !== relatedOpportunity.clientId) {
    return res.status(400).json({ message: "Cliente informado é diferente do cliente da oportunidade" });
  }

  const agendaEventId = req.body.agendaEventId || undefined;
  if (agendaEventId) {
    const agendaEvent = await prisma.agendaEvent.findFirst({
      where: {
        id: agendaEventId,
        ...(req.user!.role === "vendedor" ? { sellerId: req.user!.id } : {})
      },
      select: { id: true }
    });

    if (!agendaEvent) {
      return res.status(404).json({ message: "Evento da agenda não encontrado." });
    }
  }

  const normalizedType = normalizeActivityType(req.body.type);

  const activityDateSource = req.body.date || req.body.dueDate;
  if (!activityDateSource) {
    return res.status(400).json({ message: "Informe date ou dueDate para a atividade." });
  }
  const dueDate = new Date(req.body.dueDate || activityDateSource);
  const executionDate = req.body.date ? new Date(req.body.date) : dueDate;
  const isExecuted = Boolean(req.body.done);

  if (isExecuted && (!req.body.description || !String(req.body.description).trim())) {
    return res.status(400).json({ message: "Atividades concluídas exigem o resumo da visita." });
  }

  const createdActivity = await prisma.$transaction(async (tx) => {
    const activity = await tx.activity.create({
      data: {
        type: normalizedType,
        notes,
        description: req.body.description || notes,
        result: req.body.result,
        dueDate,
        date: executionDate,
        duration: req.body.duration,
        city: req.body.city,
        crop: req.body.crop,
        areaEstimated: req.body.areaEstimated,
        product: req.body.product,
        checkInAt: req.body.checkInAt ? new Date(req.body.checkInAt) : null,
        checkInLat: req.body.checkInLat ?? null,
        checkInLng: req.body.checkInLng ?? null,
        checkInAccuracy: req.body.checkInAccuracy ?? null,
        done: req.body.done,
        clientId: resolvedClientId,
        opportunityId: req.body.opportunityId,
        agendaEventId,
        ownerSellerId
      }
    });

    if (agendaEventId) {
      await tx.agendaEvent.update({
        where: { id: agendaEventId },
        data: { status: "realizado" }
      });
    }

    if (activity.done && activity.clientId) {
      await tx.timelineEvent.create({
        data: {
          type: "status",
          description: buildActivityExecutedDescription({ ...activity, opportunityTitle: relatedOpportunity?.title }),
          clientId: activity.clientId,
          opportunityId: activity.opportunityId,
          ownerSellerId: activity.ownerSellerId
        }
      });
    }

    return activity;
  });

  await createEvent({
    type: "status",
    description: `Atividade criada: ${createdActivity.type}`,
    opportunityId: createdActivity.opportunityId || undefined,
    clientId: resolvedClientId,
    ownerSellerId
  });

  const month = getMonthKey(createdActivity.createdAt);
  const logicalCount = await getActivityCountByTypeInMonth(ownerSellerId, normalizeActivityType(createdActivity.type), month);

  return res.status(201).json({
    ...mapActivity(createdActivity),
    metrics: {
      month,
      logicalCount
    }
  });
});
const activityUpdateSchema = activitySchema.partial().extend({
  description: z.string().optional()
});

router.put("/activities/:id", validateBody(activityUpdateSchema), async (req, res) => {
  const normalizedType = req.body.type ? normalizeActivityType(req.body.type) : undefined;
  const notes = req.body.notes ?? req.body.description;

  const ownerSellerId = req.body.ownerSellerId ?? req.body.ownerId;
  const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : undefined;
  const executionDate = req.body.date ? new Date(req.body.date) : undefined;

  const existingActivity = await prisma.activity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: {
      id: true,
      done: true,
      type: true,
      date: true,
      description: true,
      result: true,
      clientId: true,
      opportunityId: true,
      ownerSellerId: true
    }
  });

  if (!existingActivity) {
    return res.status(404).json({ message: "Atividade não encontrada" });
  }

  const nextDone = req.body.done ?? existingActivity.done;
  const nextDescription = req.body.description !== undefined ? req.body.description : existingActivity.description;
  if (nextDone && !String(nextDescription || "").trim()) {
    return res.status(400).json({ message: "Atividades concluídas exigem o resumo da visita." });
  }

  const updatedActivity = await prisma.$transaction(async (tx) => {
    const activity = await tx.activity.update({
      where: { id: req.params.id },
      data: {
        ...(normalizedType ? { type: normalizedType } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(req.body.description !== undefined ? { description: req.body.description } : {}),
        ...(req.body.result !== undefined ? { result: req.body.result } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(executionDate ? { date: executionDate } : {}),
        ...(req.body.duration !== undefined ? { duration: req.body.duration } : {}),
        ...(req.body.city !== undefined ? { city: req.body.city } : {}),
        ...(req.body.crop !== undefined ? { crop: req.body.crop } : {}),
        ...(req.body.areaEstimated !== undefined ? { areaEstimated: req.body.areaEstimated } : {}),
        ...(req.body.product !== undefined ? { product: req.body.product } : {}),
        ...(req.body.checkInAt !== undefined ? { checkInAt: req.body.checkInAt ? new Date(req.body.checkInAt) : null } : {}),
        ...(req.body.checkInLat !== undefined ? { checkInLat: req.body.checkInLat } : {}),
        ...(req.body.checkInLng !== undefined ? { checkInLng: req.body.checkInLng } : {}),
        ...(req.body.checkInAccuracy !== undefined ? { checkInAccuracy: req.body.checkInAccuracy } : {}),
        ...(req.body.done !== undefined ? { done: req.body.done } : {}),
        ...(req.body.clientId !== undefined ? { clientId: req.body.clientId } : {}),
        ...(req.body.opportunityId !== undefined ? { opportunityId: req.body.opportunityId } : {}),
        ...(req.body.agendaEventId !== undefined ? { agendaEventId: req.body.agendaEventId } : {}),
        ...(ownerSellerId !== undefined ? { ownerSellerId } : {})
      }
    });

    const transitionedToDone = !existingActivity.done && activity.done;
    if (transitionedToDone && activity.clientId) {
      await tx.timelineEvent.create({
        data: {
          type: "status",
          description: buildActivityExecutedDescription(activity),
          clientId: activity.clientId,
          opportunityId: activity.opportunityId,
          ownerSellerId: activity.ownerSellerId
        }
      });
    }

    return activity;
  });
  return res.json(mapActivity(updatedActivity));
});
router.patch("/activities/:id/done", async (req, res) => {
  const existingActivity = await prisma.activity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true }
  });

  if (!existingActivity) {
    return res.status(404).json({ message: "Atividade não encontrada" });
  }

  const updatedActivity = await prisma.activity.update({ where: { id: req.params.id }, data: { done: Boolean(req.body.done) } });
  return res.json(mapActivity(updatedActivity));
});
router.delete("/activities/:id", async (req, res) => {
  const existingActivity = await prisma.activity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true }
  });

  if (!existingActivity) {
    return res.status(404).json({ message: "Atividade não encontrada" });
  }

  await prisma.activity.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

router.get("/events", async (req, res) => {
  const opportunityId = req.query.opportunityId as string | undefined;
  const clientId = req.query.clientId as string | undefined;
  const takeRaw = Number(req.query.take ?? 20);
  const take = Number.isFinite(takeRaw) ? Math.min(Math.max(Math.trunc(takeRaw), 1), 100) : 20;
  const cursor = req.query.cursor as string | undefined;

  const events = await prisma.timelineEvent.findMany({
    where: buildTimelineEventWhere({
      baseWhere: sellerWhere(req),
      opportunityId,
      clientId
    }),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take,
    include: {
      ownerSeller: { select: { id: true, name: true } },
      opportunity: { select: { id: true, title: true } },
      client: { select: { id: true, name: true } }
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });

  const hasMore = events.length === take;
  const nextCursor = hasMore ? events[events.length - 1]?.id ?? null : null;

  res.json({
    items: events,
    nextCursor
  });
});
router.post("/events", validateBody(eventSchema), async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({
    where: {
      id: req.body.opportunityId,
      ...sellerWhere(req)
    },
    select: {
      clientId: true
    }
  });

  if (!opportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const ownerSellerId = resolveOwnerId(req, req.body.ownerSellerId);
  const created = await createEvent({
    type: req.body.type,
    description: req.body.description,
    opportunityId: req.body.opportunityId,
    clientId: opportunity.clientId,
    ownerSellerId
  });

  return res.status(201).json(created);
});

router.delete(["/events/:id", "/agenda/:id", "/agenda/events/:id"], async (req, res) => {
  const agendaEvent = await prisma.agendaEvent.findUnique({
    where: { id: req.params.id },
    select: { id: true, sellerId: true }
  });

  if (agendaEvent) {
    if (req.user!.role === "vendedor" && agendaEvent.sellerId !== req.user!.id) {
      return res.status(403).json({ message: "Acesso negado." });
    }

    await prisma.agendaEvent.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  }

  const timelineEvent = await prisma.timelineEvent.findUnique({
    where: { id: req.params.id },
    select: { id: true, ownerSellerId: true }
  });

  if (!timelineEvent) {
    return res.status(404).json({ message: "Evento não encontrado." });
  }

  if (req.user!.role === "vendedor" && timelineEvent.ownerSellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  await prisma.timelineEvent.delete({ where: { id: req.params.id } });
  return res.status(204).send();
});

const mapAgendaEvent = (agendaEvent: any) => {
  const status = mapAgendaStatusFromDb(agendaEvent.status);
  const startsAt = agendaEvent.startDateTime.toISOString();
  const endsAt = agendaEvent.endDateTime.toISOString();
  const ownerId = agendaEvent.sellerId;
  const isOverdue = status === "planned" && new Date(endsAt).getTime() < Date.now();
  const linkedActivityId = agendaEvent.activities?.[0]?.id || null;

  return {
  id: agendaEvent.id,
  ownerId,
  userId: ownerId,
  sellerId: ownerId,
  title: agendaEvent.title,
  type: agendaEvent.type,
  startsAt,
  endsAt,
  startDateTime: startsAt,
  endDateTime: endsAt,
  clientId: agendaEvent.clientId,
  opportunityId: agendaEvent.opportunityId,
  status,
  isOverdue,
  city: agendaEvent.city,
  notes: agendaEvent.notes,
  linkedActivityId,
  hasLinkedActivity: Boolean(linkedActivityId),
  stops: (agendaEvent.stops || []).map((stop: any) => ({
    id: stop.id,
    order: stop.order,
    clientId: stop.clientId,
    clientName: stop.client?.name || null,
    city: stop.city,
    address: stop.address,
    plannedTime: stop.plannedTime ? stop.plannedTime.toISOString() : null,
    notes: stop.notes,
    checkInAt: stop.checkInAt ? stop.checkInAt.toISOString() : null,
    checkInLat: stop.checkInLat,
    checkInLng: stop.checkInLng,
    checkInAccuracy: stop.checkInAccuracy,
    checkOutAt: stop.checkOutAt ? stop.checkOutAt.toISOString() : null,
    checkOutLat: stop.checkOutLat,
    checkOutLng: stop.checkOutLng,
    checkOutAccuracy: stop.checkOutAccuracy,
    resultStatus: stop.resultStatus,
    resultReason: stop.resultReason,
    resultSummary: stop.resultSummary,
    nextStep: stop.nextStep,
    nextStepDate: stop.nextStepDate ? stop.nextStepDate.toISOString() : null
  }))
  };
};

router.get(["/agenda", "/agenda/events"], async (req, res) => {
  const fromInput = req.query.from as string | undefined;
  const toInput = req.query.to as string | undefined;

  const from = fromInput ? normalizeDateToUtc(fromInput) : new Date(Date.now() - 86400000 * 7);
  const to = toInput ? normalizeDateToUtc(toInput, true) : new Date(Date.now() + 86400000 * 30);

  if (!from || !to) {
    return res.status(400).json({ message: "Parâmetros from/to inválidos." });
  }

  const requestedOwnerId = (req.query.ownerId || req.query.sellerId) as string | undefined;
  const scopedSellerId = req.user?.role === "vendedor" ? req.user.id : requestedOwnerId;

  const where: Prisma.AgendaEventWhereInput = {
    ...(scopedSellerId ? { sellerId: scopedSellerId } : {}),
    startDateTime: { lte: to },
    endDateTime: { gte: from }
  };

  const events = await prisma.agendaEvent.findMany({
    where,
    include: {
      stops: { include: { client: { select: { name: true } } }, orderBy: { order: "asc" } },
      client: true,
      activities: { select: { id: true }, orderBy: { createdAt: "desc" }, take: 1 }
    },
    orderBy: { startDateTime: "asc" }
  });

  const mappedEvents = events.map(mapAgendaEvent);
  const summary = mappedEvents.reduce(
    (acc, event) => {
      if (event.status !== "planned") return acc;

      if (event.type === "roteiro_visita") acc.routes += 1;
      else if (event.type === "followup") acc.followups += 1;
      else acc.meetings += 1;

      if (new Date(event.endsAt || event.endDateTime).getTime() < Date.now()) acc.overdue += 1;
      return acc;
    },
    { meetings: 0, routes: 0, followups: 0, overdue: 0 }
  );

  return res.json({
    items: mappedEvents,
    summary,
    period: {
      from: from.toISOString(),
      to: to.toISOString()
    }
  });
});

router.post(["/agenda", "/agenda/events"], validateBody(agendaEventCreateSchema), async (req, res) => {
  const sellerId = resolveOwnerId(req, req.body.ownerId || req.body.ownerSellerId || req.body.sellerId);

  if (req.body.type === "roteiro_visita" && (!Array.isArray(req.body.stops) || req.body.stops.length === 0)) {
    return res.status(400).json({ message: "Roteiro de visita deve conter ao menos uma parada." });
  }

  const event = await prisma.agendaEvent.create({
    data: {
      title: req.body.title,
      type: req.body.type,
      startDateTime: new Date(req.body.startsAt || req.body.startDateTime),
      endDateTime: new Date(req.body.endsAt || req.body.endDateTime),
      sellerId,
      clientId: req.body.clientId,
      city: req.body.city,
      notes: req.body.notes,
      opportunityId: req.body.opportunityId,
      ...(req.body.stops?.length
        ? {
            stops: {
              create: req.body.stops.map((stop: any, index: number) => ({
                order: index + 1,
                clientId: stop.clientId,
                city: stop.city,
                address: stop.address,
                plannedTime: stop.plannedTime ? new Date(stop.plannedTime) : undefined,
                notes: stop.notes
              }))
            }
          }
        : {})
    },
    include: { stops: { include: { client: { select: { name: true } } }, orderBy: { order: "asc" } } }
  });

  if (event.clientId) {
    await createEvent({
      type: "status",
      description: buildAgendaCreatedDescription({ type: event.type, title: event.title }),
      clientId: event.clientId,
      ownerSellerId: event.sellerId
    });
  }

  if (event.type === "roteiro_visita" && event.stops?.length) {
    for (const stop of event.stops) {
      if (!stop.clientId) continue;
      const stopLabel = `Visita em roteiro planejada: ${event.title} (parada ${stop.order})`;
      await createEvent({
        type: "status",
        description: stopLabel,
        clientId: stop.clientId,
        ownerSellerId: event.sellerId
      });
    }
  }

  return res.status(201).json(mapAgendaEvent(event));
});

router.patch(["/agenda/:id", "/agenda/events/:id"], validateBody(agendaEventUpdateSchema), async (req, res) => {
  const event = await prisma.agendaEvent.findUnique({
    where: { id: req.params.id },
    select: { sellerId: true, title: true, type: true, status: true, clientId: true }
  });
  if (!event) return res.status(404).json({ message: "Evento não encontrado." });
  if (req.user!.role === "vendedor" && event.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  const updated = await prisma.agendaEvent.update({
    where: { id: req.params.id },
    data: {
      ...(req.body.title ? { title: req.body.title } : {}),
      ...((req.body.startsAt || req.body.startDateTime) ? { startDateTime: new Date(req.body.startsAt || req.body.startDateTime) } : {}),
      ...((req.body.endsAt || req.body.endDateTime) ? { endDateTime: new Date(req.body.endsAt || req.body.endDateTime) } : {}),
      ...(req.body.status ? { status: mapAgendaStatusToDb(req.body.status) } : {}),
      ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}),
      ...(req.body.city !== undefined ? { city: req.body.city } : {}),
      ...(req.body.opportunityId !== undefined ? { opportunityId: req.body.opportunityId } : {})
    },
    include: { stops: { include: { client: { select: { name: true } } }, orderBy: { order: "asc" } } }
  });

  const previousStatus = mapAgendaStatusFromDb(event.status);
  const currentStatus = mapAgendaStatusFromDb(updated.status);
  if (event.clientId && previousStatus !== currentStatus && (currentStatus === "completed" || currentStatus === "cancelled")) {
    await createEvent({
      type: "status",
      description: buildAgendaStatusDescription(currentStatus, { type: updated.type, title: updated.title }),
      clientId: event.clientId,
      ownerSellerId: updated.sellerId
    });
  }

  return res.json(mapAgendaEvent(updated));
});

router.post("/agenda/events/:id/stops", validateBody(agendaStopCreateSchema), async (req, res) => {
  const event = await prisma.agendaEvent.findUnique({ where: { id: req.params.id }, include: { stops: true } });
  if (!event) return res.status(404).json({ message: "Evento não encontrado." });
  if (req.user!.role === "vendedor" && event.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  const stop = await prisma.agendaStop.create({
    data: {
      agendaEventId: req.params.id,
      order: event.stops.length + 1,
      clientId: req.body.clientId,
      city: req.body.city,
      address: req.body.address,
      plannedTime: req.body.plannedTime ? new Date(req.body.plannedTime) : undefined,
      notes: req.body.notes
    },
    include: { client: { select: { name: true } } }
  });

  return res.status(201).json({
    id: stop.id,
    order: stop.order,
    clientId: stop.clientId,
    clientName: stop.client?.name || null,
    city: stop.city,
    address: stop.address,
    plannedTime: stop.plannedTime ? stop.plannedTime.toISOString() : null,
    notes: stop.notes
  });
});

router.patch("/agenda/events/:id/stops/reorder", validateBody(agendaStopReorderSchema), async (req, res) => {
  const event = await prisma.agendaEvent.findUnique({ where: { id: req.params.id }, select: { sellerId: true } });
  if (!event) return res.status(404).json({ message: "Evento não encontrado." });
  if (req.user!.role === "vendedor" && event.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  await prisma.$transaction(
    req.body.stopIds.map((stopId: string, index: number) =>
      prisma.agendaStop.update({ where: { id: stopId }, data: { order: index + 1 } })
    )
  );

  const stops = await prisma.agendaStop.findMany({
    where: { agendaEventId: req.params.id },
    include: { client: { select: { name: true } } },
    orderBy: { order: "asc" }
  });

  return res.json(
    stops.map((stop) => ({
      id: stop.id,
      order: stop.order,
      clientId: stop.clientId,
      clientName: stop.client?.name || null,
      city: stop.city,
      address: stop.address,
      plannedTime: stop.plannedTime ? stop.plannedTime.toISOString() : null,
      notes: stop.notes
    }))
  );
});

router.patch(["/agenda-events/:id/check-in", "/agenda/events/:id/check-in"], validateBody(agendaStopGeoSchema), async (req, res) => {
  const stop = await prisma.agendaStop.findUnique({ where: { id: req.params.id }, include: { agendaEvent: { select: { sellerId: true } } } });
  if (!stop) return res.status(404).json({ message: "Parada não encontrada." });
  if (req.user!.role === "vendedor" && stop.agendaEvent.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  const checkInAt = req.body.timestamp ? new Date(req.body.timestamp) : new Date();
  const updated = await prisma.agendaStop.update({
    where: { id: req.params.id },
    data: {
      checkInAt,
      checkInLat: req.body.lat ?? null,
      checkInLng: req.body.lng ?? null,
      checkInAccuracy: req.body.accuracy ?? null
    }
  });
  return res.json({
    id: updated.id,
    checkInAt: updated.checkInAt?.toISOString() || null,
    checkInLat: updated.checkInLat,
    checkInLng: updated.checkInLng,
    checkInAccuracy: updated.checkInAccuracy
  });
});

router.patch(["/agenda-events/:id/check-out", "/agenda/events/:id/check-out"], validateBody(agendaStopGeoSchema), async (req, res) => {
  const stop = await prisma.agendaStop.findUnique({ where: { id: req.params.id }, include: { agendaEvent: { select: { sellerId: true } } } });
  if (!stop) return res.status(404).json({ message: "Parada não encontrada." });
  if (req.user!.role === "vendedor" && stop.agendaEvent.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  const checkOutAt = req.body.timestamp ? new Date(req.body.timestamp) : new Date();
  const updated = await prisma.agendaStop.update({
    where: { id: req.params.id },
    data: {
      checkOutAt,
      checkOutLat: req.body.lat ?? null,
      checkOutLng: req.body.lng ?? null,
      checkOutAccuracy: req.body.accuracy ?? null
    }
  });
  return res.json({
    id: updated.id,
    checkOutAt: updated.checkOutAt?.toISOString() || null,
    checkOutLat: updated.checkOutLat,
    checkOutLng: updated.checkOutLng,
    checkOutAccuracy: updated.checkOutAccuracy
  });
});

router.patch(["/agenda-events/:id/result", "/agenda/events/:id/result"], validateBody(agendaStopResultSchema), async (req, res) => {
  const stop = await prisma.agendaStop.findUnique({
    where: { id: req.params.id },
    include: { agendaEvent: { select: { sellerId: true, title: true } } }
  });
  if (!stop) return res.status(404).json({ message: "Parada não encontrada." });
  if (req.user!.role === "vendedor" && stop.agendaEvent.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  if (req.body.status === "nao_realizada" && !req.body.reason) {
    return res.status(400).json({ message: "Motivo é obrigatório quando a visita não é realizada." });
  }
  const ownerSellerIdForAutoActivity = stop.agendaEvent.sellerId || req.user!.id;
  if (req.body.status === "realizada" && !stop.clientId) {
    return res.status(400).json({ message: "clientId é obrigatório para registrar atividade automática da parada." });
  }
  if (req.body.status === "realizada" && !ownerSellerIdForAutoActivity) {
    return res.status(400).json({ message: "ownerSellerId é obrigatório para registrar atividade automática da parada." });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const completionAt = req.body.status === "realizada" ? (stop.checkOutAt ?? new Date()) : null;
    const updatedStop = await tx.agendaStop.update({
      where: { id: req.params.id },
      data: {
        resultStatus: req.body.status,
        resultReason: req.body.reason,
        resultSummary: req.body.summary,
        nextStep: req.body.nextStep,
        nextStepDate: req.body.nextStepDate ? new Date(req.body.nextStepDate) : null,
        ...(completionAt && !stop.checkOutAt ? { checkOutAt: completionAt } : {})
      }
    });

    if (req.body.status === "realizada") {
      const executionDate = updatedStop.checkOutAt ?? completionAt;
      if (!executionDate) {
        throw new Error("Não foi possível determinar o horário de conclusão da parada.");
      }
      const ownerSellerId = ownerSellerIdForAutoActivity!;
      const clientId = updatedStop.clientId || stop.clientId!;
      const stopRefToken = `[AUTO_AGENDA_STOP:${updatedStop.id}]`;
      const summary = (req.body.summary || "").trim();
      const agendaTitle = stop.agendaEvent.title?.trim() || "Roteiro de visita";
      const notes = summary || `Parada do roteiro "${agendaTitle}" concluída.`;
      const result = summary || "Visita realizada em parada de roteiro.";
      const description = `Visita em roteiro (${agendaTitle}) ${stopRefToken}`;
      const activityData = {
        type: ActivityType.visita,
        done: true,
        notes,
        result,
        description,
        dueDate: executionDate,
        date: executionDate,
        agendaEventId: updatedStop.agendaEventId,
        ownerSellerId,
        clientId
      };

      const existingAutoActivity = await tx.activity.findFirst({
        where: {
          agendaEventId: updatedStop.agendaEventId,
          ownerSellerId,
          type: ActivityType.visita,
          description: { contains: stopRefToken }
        },
        orderBy: { createdAt: "asc" }
      });

      if (existingAutoActivity) {
        await tx.activity.update({
          where: { id: existingAutoActivity.id },
          data: activityData
        });
      } else {
        await tx.activity.create({ data: activityData });
      }
    }

    return updatedStop;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (updated.clientId) {
    const statusLabel = updated.resultStatus === "realizada" ? "Compromisso concluído" : "Compromisso cancelado";
    await createEvent({
      type: "status",
      description: `${statusLabel}: Visita em roteiro (${stop.agendaEvent.title})`,
      clientId: updated.clientId,
      ownerSellerId: stop.agendaEvent.sellerId
    });
  }

  return res.json({
    id: updated.id,
    resultStatus: updated.resultStatus,
    resultReason: updated.resultReason,
    resultSummary: updated.resultSummary,
    nextStep: updated.nextStep,
    nextStepDate: updated.nextStepDate ? updated.nextStepDate.toISOString() : null
  });
});



const ultraFv3SyncHandlers = {
  connection: syncConnection,
  products: syncProducts,
  partners: syncPartners,
  financialProfiles: syncFinancialProfiles,
  partnerTitles: syncPartnerTitles,
  salesmen: syncSalesmen,
  paymentMethods: syncPaymentMethods,
  receivingConditions: syncReceivingConditions,
  priceTables: syncPriceTables,
  priceVariations: syncPriceVariations,
  prices: syncPrices,
  branches: syncBranches,
  operations: syncOperations
} as const;

const runUltraFv3Sync = (scope: keyof typeof ultraFv3SyncHandlers) => async (_req: Request, res: express.Response) => {
  try {
    const result = await ultraFv3SyncHandlers[scope]();
    return res.status(200).json({ scope, ...result });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[ultrafv3 sync route] scope sync failed", { scope, error: details });
    return res.status(typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502).json({
      scope,
      message: "Falha na sincronização UltraFV3.",
      details
    });
  }
};


router.post("/erp/sync-all", authorize("diretor", "gerente"), async (_req, res) => {
  try {
    const job = await startUltraFv3FullSyncJob();
    logApiEvent("INFO", "[ultrafv3 sync-all route] async job response sent", {
      correlationId: job.correlationId,
      runId: job.runId,
      status: job.status,
      alreadyRunning: job.alreadyRunning,
    });
    return res.status(job.alreadyRunning ? 200 : 202).json(job);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[ultrafv3 sync-all route] failed to start async job", { error: details });
    return res.status(typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502).json({
      success: false,
      message: "Falha ao iniciar a Sincronização Completa ERP.",
      details,
    });
  }
});


const priceDiagnosticsQuerySchema = z.object({
  codes: z.string().trim().min(1).max(200).default("273,228"),
  priceTableCode: z.string().trim().min(1).max(60).optional(),
});

const summarizeRawErpPayloadForPriceDiagnostics = (raw: Prisma.JsonValue | null | undefined) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw ? { type: typeof raw } : null;
  const record = raw as Record<string, unknown>;
  const allowedKeys = [
    "CODPRODUTO",
    "CODPRODUTO_CLAS",
    "DSCPRODUTO",
    "DSCPRODUTO_CLAS",
    "UND_MEDIDA",
    "PRECO",
    "PRECO_MINIMO",
    "QTD_ESTOQUE",
    "CODGRUPO",
    "TABELA_PRECO",
    "SUSPENDER_PEDIDOS",
    "IDN_FORA_LINHA",
  ];
  return Object.fromEntries(allowedKeys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
};

router.get("/erp/ultrafv3/price-diagnostics", authorize("diretor", "gerente"), async (req, res) => {
  const parsed = priceDiagnosticsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ message: "Parâmetro codes inválido." });
  const correlationId = randomUUID();
  const requestedCodes = parsed.data.codes.split(",").map((code) => code.trim()).filter(Boolean);
  const normalizedCodes = requestedCodes.map((code) => code.replace(/^0+(?=\d)/, ""));
  const priceTableCode = normalizeOpportunityPriceTableCode(parsed.data.priceTableCode || "1");
  const priceRules = await loadOpportunityPriceRules();
  const parseDiagnosticRows = (value: string | undefined) => {
    if (!value?.trim()) return [] as unknown[];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        for (const key of ["items", "data", "rows", "results", "content"]) {
          if (Array.isArray(record[key])) return record[key] as unknown[];
        }
      }
    } catch {
      return [] as unknown[];
    }
    return [] as unknown[];
  };
  const getCodeFromDiagnosticRow = (row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return "";
    const record = row as Record<string, unknown>;
    const value = record.CODPRODUTO ?? record.COD_PRODUTO ?? record.productCode ?? record.erpProductCode ?? record.produto;
    return String(value ?? "").trim().replace(/^0+(?=\d)/, "");
  };
  const readDiagnosticNumber = (row: unknown, keys: string[]) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const record = row as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (value === undefined || value === null || String(value).trim() === "") continue;
      const raw = String(value).trim();
      const parsed = Number(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };
  const appConfigs = await prisma.appConfig.findMany({
    where: { key: { in: ["erp.ultrafv3.products", "erp.ultrafv3.prices", "erp.ultrafv3.priceVariations"] } },
    select: { key: true, value: true, updatedAt: true },
  });
  const configByKey = new Map(appConfigs.map((config) => [config.key, config]));
  const productRows = parseDiagnosticRows(configByKey.get("erp.ultrafv3.products")?.value);
  const priceRows = parseDiagnosticRows(configByKey.get("erp.ultrafv3.prices")?.value);
  const priceVariationRows = parseDiagnosticRows(configByKey.get("erp.ultrafv3.priceVariations")?.value);
  const [products, syncRuns] = await Promise.all([
    prisma.product.findMany({
      where: { OR: requestedCodes.flatMap((code, index) => [{ erpProductCode: code }, { erpProductCode: normalizedCodes[index] }]) },
      include: { prices: { orderBy: [{ erpPriceId: "asc" }, { branchCode: "asc" }, { validFrom: "desc" }] } },
      orderBy: [{ erpProductCode: "asc" }, { erpProductClassCode: "asc" }],
    }),
    prisma.erpSyncRun.findMany({
      where: { scope: { in: ["products", "prices", "priceVariations"] } },
      orderBy: [{ startedAt: "desc" }],
      take: 10,
      select: { id: true, scope: true, status: true, startedAt: true, finishedAt: true, syncedCount: true, metrics: true, errors: true, errorMessage: true, correlationId: true },
    }),
  ]);

  const diagnostics = requestedCodes.map((requestedCode) => {
    const normalizedCode = requestedCode.replace(/^0+(?=\d)/, "");
    const matches = products.filter((product) => product.erpProductCode.replace(/^0+(?=\d)/, "") === normalizedCode);
    const productRowsForCode = productRows.filter((row) => getCodeFromDiagnosticRow(row) === normalizedCode);
    const priceRowsForCode = priceRows.filter((row) => getCodeFromDiagnosticRow(row) === normalizedCode);
    const variationRowsForCode = priceVariationRows.filter((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
      const record = row as Record<string, unknown>;
      const rowCode = getCodeFromDiagnosticRow(row);
      if (rowCode) return rowCode === normalizedCode;
      const groups = productRowsForCode.map((productRow) => {
        if (!productRow || typeof productRow !== "object" || Array.isArray(productRow)) return "";
        const productRecord = productRow as Record<string, unknown>;
        return String(productRecord.CODGRUPO ?? productRecord.COD_GRUPO ?? productRecord.groupCode ?? productRecord.codigoGrupo ?? "").trim().replace(/^0+(?=\d)/, "");
      }).filter(Boolean);
      const variationGroup = String(record.CODGRUPO ?? record.COD_GRUPO ?? record.groupCode ?? record.codigoGrupo ?? record.grupo ?? "").trim().replace(/^0+(?=\d)/, "");
      return Boolean(variationGroup && groups.includes(variationGroup));
    });
    const productDiagnostics = matches.map((product) => {
      const searchPrice = calculateOpportunityPriceForTable({ product, priceTableCode, priceVariations: priceRules.priceVariations, erpPrices: priceRules.erpPrices });
      const selectable = product.isActive && !product.isSuspended && searchPrice.price > 0 && searchPrice.priceTableMatched;
      const divergences = [
        !product.isActive ? "Produto inativo no CRM." : null,
        product.isSuspended ? "Produto suspenso no CRM." : null,
        !searchPrice.priceTableMatched ? `Sem preço válido sincronizado para a tabela ${priceTableCode}.` : null,
        searchPrice.source === "rawProduct" ? "Busca ainda dependeria de rawErpPayload; revisar fonte de verdade." : null,
        product.prices.some((price) => Number(price.price) <= 0) && Number(product.defaultPrice || 0) > 0 ? "ProductPrice inválido/zero com defaultPrice positivo." : null,
      ].filter(Boolean);
      return {
        product: {
          id: product.id,
          erpProductCode: product.erpProductCode,
          erpProductClassCode: product.erpProductClassCode,
          name: product.name,
          unit: product.unit,
          isActive: product.isActive,
          isSuspended: product.isSuspended,
          stockQuantity: product.stockQuantity,
          defaultPrice: product.defaultPrice,
          minPrice: product.minPrice,
          updatedAt: product.updatedAt,
        },
        productPrices: product.prices.map((price) => ({ id: price.id, erpPriceId: price.erpPriceId, branchCode: price.branchCode, price: price.price, validFrom: price.validFrom, updatedAt: price.updatedAt })),
        rawErpPayloadSummary: summarizeRawErpPayloadForPriceDiagnostics(product.rawErpPayload),
        opportunitySearchForTable: { selectable, reason: selectable ? "visible" : divergences[0] || "hidden_invalid_or_inactive", ...searchPrice },
        priceSource: searchPrice.source === "product.PRECO" ? "/products.PRECO" : searchPrice.source === "productPrice" ? "ProductPrice (/prices or /products table field)" : searchPrice.source,
        divergences,
      };
    });
    return {
      requestedCode,
      normalizedCode,
      appearedInProductsEndpoint: productRowsForCode.length > 0,
      productsEndpointPreco: productRowsForCode.map((row) => readDiagnosticNumber(row, ["PRECO", "price", "defaultPrice", "preco"])),
      appearedInPricesEndpoint: priceRowsForCode.length > 0,
      pricesEndpointRows: priceRowsForCode,
      appearedInPriceVariationsEndpoint: variationRowsForCode.length > 0,
      priceVariationRows: variationRowsForCode,
      crmProductFound: matches.length > 0,
      candidateCount: matches.length,
      products: productDiagnostics,
    };
  });

  logApiEvent("INFO", "[ultrafv3 price diagnostics] generated", { correlationId, codes: requestedCodes, priceTableCode });
  return res.json({ correlationId, endpoint: "GET /erp/ultrafv3/price-diagnostics", priceTableCode, diagnostics, lastSyncRuns: syncRuns });
});

router.post("/erp/ultrafv3/sync/connection", authorize("diretor", "gerente"), runUltraFv3Sync("connection"));
router.post("/erp/ultrafv3/sync/products", authorize("diretor", "gerente", "vendedor"), runUltraFv3Sync("products"));
router.post("/erp/ultrafv3/sync/partners", authorize("diretor", "gerente"), runUltraFv3Sync("partners"));
router.post("/erp/ultrafv3/sync/financial-profiles", authorize("diretor", "gerente"), runUltraFv3Sync("financialProfiles"));
router.post("/erp/ultrafv3/sync/partner-titles", authorize("diretor", "gerente"), runUltraFv3Sync("partnerTitles"));
router.post("/erp/ultrafv3/sync/partners/opportunity-clients", authorize("diretor", "gerente", "vendedor"), async (req, res) => {
  try {
    const result = await syncPartnersForAllConfiguredSellers({ trigger: ErpSyncTrigger.manual });
    logApiEvent("INFO", "[ultrafv3 sync route] opportunity clients all-sellers sync finished", {
      userId: req.user!.id,
      role: req.user!.role,
      totalUsers: result.totalUsers,
      successCount: result.successCount,
      errorCount: result.errorCount,
      skippedCount: result.skippedCount,
      created: result.created,
      updated: result.updated,
      sellerChangedCount: result.sellerChangedCount,
    });
    return res.status(result.errorCount > 0 ? 207 : 200).json({
      scope: "partners",
      authMode: "all_sellers",
      allSellers: true,
      syncedCount: result.results.reduce((total, item) => total + (item.syncedCount ?? 0), 0),
      ...result,
    });
  } catch (error) {
    if (res.headersSent) {
      logApiEvent("WARN", "[ultrafv3 sync route] opportunity clients sync failed after response was sent", { userId: req.user!.id, role: req.user!.role });
      return;
    }
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[ultrafv3 sync route] opportunity clients sync failed", { userId: req.user!.id, role: req.user!.role, error: details });
    return res.status(typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502).json({
      scope: "partners",
      message: "Falha ao atualizar clientes do UltraFV3.",
      details
    });
  }
});

router.post("/erp/ultrafv3/sync/partners/by-user/:userId", authorize("diretor", "gerente"), async (req, res) => {
  try {
    const result = await syncPartnersByUser(req.params.userId);
    return res.status(200).json({ scope: "partners", authMode: "seller", sellerId: req.params.userId, ...result });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[ultrafv3 sync route] seller partners sync failed", { userId: req.params.userId, error: details });
    return res.status(typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502).json({
      scope: "partners",
      authMode: "seller",
      sellerId: req.params.userId,
      message: "Falha na sincronização UltraFV3 por vendedor.",
      details
    });
  }
});
router.post("/erp/ultrafv3/sync/partners/all-sellers", authorize("diretor", "gerente"), async (_req, res) => {
  const result = await syncPartnersForAllConfiguredSellers();
  return res.status(result.errorCount > 0 ? 207 : 200).json(result);
});
router.post("/erp/ultrafv3/sync/salesmen", authorize("diretor", "gerente"), runUltraFv3Sync("salesmen"));
router.post("/erp/ultrafv3/sync/payment-methods", authorize("diretor", "gerente"), runUltraFv3Sync("paymentMethods"));
router.post("/erp/ultrafv3/sync/receiving-conditions", authorize("diretor", "gerente"), runUltraFv3Sync("receivingConditions"));
router.post("/erp/ultrafv3/sync/price-tables", authorize("diretor", "gerente"), runUltraFv3Sync("priceTables"));
router.post("/erp/ultrafv3/sync/price-variations", authorize("diretor", "gerente"), runUltraFv3Sync("priceVariations"));
router.post("/erp/ultrafv3/sync/prices", authorize("diretor", "gerente"), runUltraFv3Sync("prices"));
router.post("/erp/ultrafv3/sync/branches", authorize("diretor", "gerente"), runUltraFv3Sync("branches"));
router.post("/erp/ultrafv3/sync/operations", authorize("diretor", "gerente"), runUltraFv3Sync("operations"));
router.post("/erp/ultrafv3/sync/order-status", authorize("diretor", "gerente"), async (_req, res) => {
  try {
    const result = await syncOrderStatus(() => syncErpOrderStatuses());
    return res.status(200).json({ scope: "orderStatus", ...result });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[erp order status route] global status sync failed", { error: details });
    return res.status(typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502).json({ message: "Falha ao consultar /orderStatus no UltraFV3.", details });
  }
});

router.get("/erp/ultrafv3/salesmen/options", authorize("diretor", "gerente"), async (_req, res) => {
  const options = await loadErpSalesmenOptions();
  return res.status(200).json(options);
});

router.get("/erp/ultrafv3/sync/status", authorize("diretor", "gerente"), async (_req, res) => {
  const status = await getUltraFv3SyncStatus();
  const integration = getUltraFv3IntegrationDiagnostics(status);
  const [productCount, clientCount, operational] = await Promise.all([
    prisma.product.count({ where: { isActive: true } }),
    prisma.client.count({ where: { isArchived: false } }),
    getErpOrderOperationalSummary()
  ]);
  const history = await getUltraFv3SyncHistory(25);
  const automaticSync = await refreshErpAutomaticSyncConfig();
  return res.status(200).json({ status, integration, productCount, clientCount, operational, history, automaticSync });
});


router.get("/erp/ultrafv3/scheduler/status", authorize("diretor", "gerente"), async (_req, res) => {
  const automaticSync = await refreshErpAutomaticSyncConfig();
  return res.status(200).json({ automaticSync });
});

router.patch("/erp/ultrafv3/sync/automatic", authorize("diretor", "gerente"), validateBody(z.object({ enabled: z.boolean() })), async (req, res) => {
  const automaticSync = await setErpAutomaticSyncEnabled(req.body.enabled);
  return res.status(200).json({ automaticSync });
});

router.post("/erp-sync/automatic/run-now", authorize("diretor", "gerente"), async (_req, res) => {
  const automaticSync = await runAutomaticErpSyncNow();
  return res.status(200).json({ automaticSync });
});

router.get("/erp/ultrafv3/sync/history", authorize("diretor", "gerente"), async (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  const history = await getUltraFv3SyncHistory(Number.isFinite(limit) ? limit : 20);
  return res.status(200).json({ items: history });
});

router.get("/erp/ultrafv3/healthcheck", authorize("diretor", "gerente"), async (_req, res) => {
  const status = await getUltraFv3SyncStatus();
  const integration = getUltraFv3IntegrationDiagnostics(status);
  const operational = await getErpOrderOperationalSummary();
  const hasOperationalErrors = Object.values(status).some((item) => item.status === "error") || operational.errorOrders > 0;
  return res.status(hasOperationalErrors ? 207 : 200).json({
    ok: integration.isConfigured && !hasOperationalErrors,
    integration,
    operational,
    status,
  });
});

router.get("/erp/ultrafv3/diagnostics", authorize("diretor", "gerente"), async (_req, res) => {
  const status = await getUltraFv3SyncStatus();
  const integration = getUltraFv3IntegrationDiagnostics(status);
  const operational = await getErpOrderOperationalSummary();
  return res.status(200).json({
    ultraFv3Status: integration.authenticationStatus,
    lastLoginAt: integration.lastLoginAt ?? null,
    tokenExpired: Boolean(integration.tokenExpired),
    tokenExpiresAt: integration.tokenExpiresAt ?? null,
    lastProductsSyncAt: status.products.lastSyncAt ?? null,
    lastPartnersSyncAt: status.partners.lastSyncAt ?? null,
    pendingOrders: operational.pendingOrders,
    errorOrders: operational.errorOrders,
    operational,
    integration,
    status,
  });
});


router.get("/erp/ultrafv3/auth/mode-diagnostics", authorize("diretor", "gerente"), async (_req, res) => {
  const sellers = await prisma.user.findMany({
    where: { role: "vendedor", isActive: true },
    select: { id: true, erpCode: true, erpOperatorCode: true, erpLoginUsername: true, erpLoginPasswordEncrypted: true },
  });
  const totalSellers = sellers.length;
  const sellersWithErpLink = sellers.filter((user) => Boolean(user.erpCode?.trim() && user.erpOperatorCode?.trim())).length;
  const sellersWithFv3Login = sellers.filter((user) => Boolean(user.erpLoginUsername?.trim() && user.erpLoginPasswordEncrypted)).length;
  const hasGlobalCredentials = ultraFv3Client.hasGlobalCredentials();
  const allSellersLinked = totalSellers === 0 || sellersWithErpLink === totalSellers;
  const hasAnySellerLogin = sellersWithFv3Login > 0;
  const allSellersWithLogin = totalSellers > 0 && sellersWithFv3Login === totalSellers;
  const recommendation = (!hasGlobalCredentials && hasAnySellerLogin) || allSellersWithLogin
    ? "por_vendedor"
    : hasGlobalCredentials && allSellersLinked
      ? "global"
      : "indefinido";

  return res.status(200).json({
    hasGlobalCredentials,
    encryptionKeyConfigured: isErpCredentialEncryptionConfigured(),
    sellers: {
      total: totalSellers,
      withErpLink: sellersWithErpLink,
      missingErpLink: Math.max(totalSellers - sellersWithErpLink, 0),
      withFv3Login: sellersWithFv3Login,
      missingFv3Login: Math.max(totalSellers - sellersWithFv3Login, 0),
    },
    recommendation,
    rationale: recommendation === "por_vendedor"
      ? "Modo por vendedor ativo: use Login FV3/Senha FV3 de vendedor para sincronizar catálogos quando credencial global estiver ausente."
      : recommendation === "global"
        ? "Há credencial técnica global e os vendedores ativos possuem CODVENDEDOR/OPERADOR para montar pedidos."
        : "Configuração insuficiente para afirmar o modo: revise credencial global, vínculo CODVENDEDOR/OPERADOR e logins FV3 por vendedor.",
  });
});

router.get("/erp/ultrafv3/order-debug/:opportunityId", authorize("diretor", "gerente"), async (req, res) => {
  const correlationId = randomUUID();
  const opportunityId = req.params.opportunityId;
  logApiEvent("INFO", "[erp order debug] request started", { opportunityId, correlationId, requestId: req.requestId });

  try {
    const parsed = erpOrderGenerationSchema.safeParse({ ...req.query, simulateOnly: true });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message || "Parâmetros inválidos";
      throw Object.assign(new Error(`Parâmetros inválidos para prévia do pedido ERP: ${message}`), { status: 400 });
    }

    const opportunity = await prisma.opportunity.findUnique({
      where: { id: opportunityId },
      include: { client: true, ownerSeller: true, items: { orderBy: [{ lineNumber: "asc" }], include: { product: { select: { stockQuantity: true, unit: true, className: true, rawErpPayload: true } } } } }
    });
    if (!opportunity) throw Object.assign(new Error("Oportunidade não encontrada."), { status: 404 });

    const preview = await createErpOrderFromOpportunity(opportunity, parsed.data, { correlationId });
    logApiEvent("INFO", "[erp order debug] preview completed without submission", { opportunityId, correlationId, numPedido: preview.numPedido });
    return res.status(200).json({
      correlationId,
      readiness: { ready: true, message: "Payload validado; nenhum pedido foi enviado ao UltraFV3." },
      payload: sanitizeErpOrderPayload(preview.payloadSent),
      next: {
        numPedido: preview.numPedido,
        salesmen: "salesmenDiagnostics" in preview ? preview.salesmenDiagnostics : null,
      },
      simulated: true,
    });
  } catch (error: any) {
    const statusCandidate = Number(error?.status || 502);
    const status = statusCandidate >= 400 && statusCandidate < 600 ? statusCandidate : 502;
    const message = sanitizeErpOrderErrorMessage(typeof error?.message === "string" && error.message.trim() ? error.message : "Falha ao preparar prévia do pedido ERP.");
    logApiEvent(status >= 500 ? "ERROR" : "WARN", "[erp order debug] preview failed", { opportunityId, correlationId, httpStatus: status, error: message });
    return res.status(status).json({
      correlationId,
      readiness: { ready: false, message },
      payload: null,
      next: { numPedido: null, salesmen: error?.diagnostics || null },
      status: "erro",
      message,
      ...(error?.ultraFv3Failure ? { ultraFv3: error.ultraFv3Failure } : {}),
    });
  }
});

router.get("/erp/ultrafv3/order-readiness/:opportunityId", authorize("diretor", "gerente"), async (req, res) => {
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: req.params.opportunityId },
    select: {
      id: true,
      stage: true,
      ownerSellerId: true,
      clientId: true,
      ownerSeller: {
        select: {
          id: true,
          name: true,
          erpCode: true,
          erpOperatorCode: true,
          erpLoginUsername: true,
          erpLoginPasswordEncrypted: true,
        }
      },
      client: {
        select: {
          id: true,
          name: true,
          code: true,
        }
      },
      _count: { select: { items: true } },
    }
  });

  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada." });

  const sellerErpCodePresent = Boolean(opportunity.ownerSeller?.erpCode?.trim());
  const sellerOperatorPresent = Boolean(opportunity.ownerSeller?.erpOperatorCode?.trim());
  const sellerLoginConfigured = Boolean(opportunity.ownerSeller?.erpLoginUsername?.trim() && opportunity.ownerSeller?.erpLoginPasswordEncrypted);
  const clientErpCodePresent = Boolean(opportunity.client?.code?.trim());
  const itemsCount = opportunity._count.items;
  const missing = [
    !sellerErpCodePresent ? "ownerSeller.erpCode" : null,
    !sellerOperatorPresent ? "ownerSeller.erpOperatorCode" : null,
    !sellerLoginConfigured ? "ownerSeller.erpLogin" : null,
    !clientErpCodePresent ? "client.code" : null,
    itemsCount <= 0 ? "items" : null,
  ].filter((item): item is string => Boolean(item));

  return res.json({
    opportunityId: opportunity.id,
    canGenerate: missing.length === 0,
    missing,
    stage: opportunity.stage,
    ownerSellerId: opportunity.ownerSellerId,
    clientId: opportunity.clientId,
    ownerSeller: {
      id: opportunity.ownerSeller.id,
      name: opportunity.ownerSeller.name,
      erpCodePresent: sellerErpCodePresent,
      erpOperatorCodePresent: sellerOperatorPresent,
      erpLoginConfigured: sellerLoginConfigured,
    },
    client: {
      id: opportunity.client.id,
      name: opportunity.client.name,
      erpCodePresent: clientErpCodePresent,
    },
    items: {
      count: itemsCount,
    },
  });
});

router.post("/users/:id/erp-login/test", authorize("diretor", "gerente"), async (req, res) => {
  const correlationId = randomUUID();
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, erpLoginUsername: true, erpLoginPasswordEncrypted: true },
  });
  if (!user) return res.status(404).json({ success: false, message: "Usuário não encontrado." });
  if (!user.erpLoginUsername?.trim() || !user.erpLoginPasswordEncrypted) {
    return res.status(400).json({ success: false, message: "Login FV3 do usuário não configurado." });
  }

  try {
    const password = decryptErpCredential(user.erpLoginPasswordEncrypted);
    const result = await ultraFv3Client.testLogin({ username: user.erpLoginUsername, password });
    const tokenSalesman = normalizeOptionalString(result.tokenPayload?.salesman);
    const tokenOperator = normalizeOptionalString(result.tokenPayload?.operator);
    const tokenBranch = normalizeOptionalString(result.tokenPayload?.branch);
    const tokenPartner = normalizeOptionalString(result.tokenPayload?.partner);
    const persisted = await prisma.user.update({
      where: { id: user.id },
      data: {
        erpCode: tokenSalesman ? { set: tokenSalesman } : undefined,
        erpOperatorCode: tokenOperator ? { set: tokenOperator } : undefined,
        region: tokenBranch || tokenPartner ? { set: `${tokenBranch || ""}${tokenBranch && tokenPartner ? " / " : ""}${tokenPartner || ""}`.trim() } : undefined,
        erpLoginLastTestStatus: tokenOperator ? "success" : "success_missing_operator",
        erpLoginLastTestAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        role: true,
        erpCode: true,
        erpOperatorCode: true,
        region: true,
        erpLoginUsername: true,
        erpLoginPasswordEncrypted: true,
        erpLoginLastTestStatus: true,
        erpLoginLastTestAt: true,
      }
    });
    return res.status(200).json({
      success: true,
      status: 200,
      message: tokenOperator
        ? "Login FV3 validado. OPERADOR persistido no vendedor."
        : "Login FV3 validado, mas o token não retornou OPERADOR; revise o usuário no UltraFV3.",
      maskedDocument: result.maskedDocument,
      tokenPayload: result.tokenPayload,
      persistedLink: {
        ...persisted,
        erpLoginConfigured: Boolean(persisted.erpLoginUsername?.trim() && persisted.erpLoginPasswordEncrypted),
        erpLoginPasswordEncrypted: undefined,
      },
      correlationId,
    });
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502;
    const details = error instanceof Error ? error.message : String(error);
    const diagnostics = (error as { diagnostics?: { message?: string; ultraResponse?: unknown; correlationId?: string } }).diagnostics;
    const apiCorrelationId = diagnostics?.correlationId || correlationId;
    const maskedLogin = user.erpLoginUsername.replace(/\D/g, "").replace(/^(\d{3})\d+(\d{2})$/, "$1***$2");
    logApiEvent("WARN", "[ultrafv3 user auth] login test failed", {
      correlationId: apiCorrelationId,
      sellerId: user.id,
      sellerName: user.name,
      authMode: "seller",
      maskedLogin,
      status,
      details,
      ultraMessage: diagnostics?.message ?? null,
      ultraResponse: diagnostics?.ultraResponse ?? null,
    });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        erpLoginLastTestStatus: `failed:${status}`,
        erpLoginLastTestAt: new Date(),
      },
    });
    return res.status(status).json({
      success: false,
      status,
      message: diagnostics?.message || "Falha ao testar login UltraFV3 do usuário.",
      maskedDocument: maskedLogin,
      tokenPayload: null,
      correlationId: apiCorrelationId,
    });
  }
});

router.get("/settings/weekly-visit-minimum", authorize("diretor", "gerente"), async (_req, res) => {
  const weeklyVisitGoal = await getWeeklyVisitGoal();
  return res.json({ minimumWeeklyVisits: weeklyVisitGoal });
});

router.put(
  "/settings/weekly-visit-minimum",
  authorize("diretor"),
  validateBody(weeklyVisitMinimumSchema),
  async (req, res) => {
    try {
      const config = await prisma.appConfig.upsert({
        where: { key: WEEKLY_VISIT_GOAL_KEY },
        update: { value: String(req.body.minimumWeeklyVisits) },
        create: { key: WEEKLY_VISIT_GOAL_KEY, value: String(req.body.minimumWeeklyVisits) },
        select: { value: true }
      });

      const parsedValue = parseWeeklyVisitGoal(config.value);
      weeklyVisitGoalCache.value = parsedValue;
      weeklyVisitGoalCache.expiresAt = Date.now() + APP_CONFIG_CACHE_TTL_MS;
      return res.json({ minimumWeeklyVisits: parsedValue });
    } catch (error) {
      console.error("[appConfig] Falha ao atualizar weeklyVisitGoal.", error);
      return res.status(200).json({ minimumWeeklyVisits: DEFAULT_WEEKLY_VISIT_GOAL });
    }
  }
);




router.get("/ai/commercial-insights", authorize("diretor", "gerente"), async (req, res) => {
  const refresh = req.query.refresh === "true" || req.query.refresh === "1";
  if (refresh) invalidateCommercialInsightsCache();
  const insights = await getCommercialInsights({ refresh });
  return res.json(insights);
});

router.post("/commercial-automations/run", authorize("diretor", "gerente"), async (_req, res) => {
  const result = await runCommercialAutomations("manual");
  return res.status(result.skipped ? 200 : 202).json(result);
});

router.get("/commercial-automations/history", authorize("diretor", "gerente"), async (_req, res) => {
  return res.json(getCommercialAutomationsStatus());
});

router.get("/settings/commercial-automations", authorize("diretor", "gerente"), async (_req, res) => {
  const config = await prisma.appConfig.upsert({
    where: { key: COMMERCIAL_AUTOMATIONS_CONFIG_KEY },
    update: {},
    create: { key: COMMERCIAL_AUTOMATIONS_CONFIG_KEY, value: JSON.stringify(DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG) },
    select: { value: true }
  });

  return res.json(parseCommercialAutomationsConfig(config.value));
});

router.put(
  "/settings/commercial-automations",
  authorize("diretor"),
  validateBody(commercialAutomationsConfigSchema),
  async (req, res) => {
    const normalizedConfig = commercialAutomationsConfigSchema.parse(req.body);
    const config = await prisma.appConfig.upsert({
      where: { key: COMMERCIAL_AUTOMATIONS_CONFIG_KEY },
      update: { value: JSON.stringify(normalizedConfig) },
      create: { key: COMMERCIAL_AUTOMATIONS_CONFIG_KEY, value: JSON.stringify(normalizedConfig) },
      select: { value: true }
    });

    return res.json(parseCommercialAutomationsConfig(config.value));
  }
);


router.get("/knowledge-documents", authorize("diretor", "gerente"), async (req, res) => {
  await ensureInitialKnowledgeDocuments();
  const documents = await searchKnowledgeDocuments({
    query: req.query.q as string | undefined,
    tag: req.query.tag as string | undefined,
    category: req.query.category as string | undefined,
    includeInactive: req.query.includeInactive === "true",
    limit: Number(req.query.limit || 50)
  });
  return res.json(documents);
});

router.post(
  "/knowledge-documents",
  authorize("diretor", "gerente"),
  validateBody(knowledgeDocumentCreateSchema),
  async (req, res) => {
    const input = knowledgeDocumentCreateSchema.parse(req.body);
    const document = await prisma.knowledgeDocument.create({
      data: {
        ...input,
        sourceName: input.sourceName || null,
        summary: input.summary || null,
        tags: input.tags.map((tag) => tag.toLowerCase()),
        createdById: req.user?.id
      }
    });
    return res.status(201).json(document);
  }
);

router.put(
  "/knowledge-documents/:id",
  authorize("diretor", "gerente"),
  validateBody(knowledgeDocumentUpdateSchema),
  async (req, res) => {
    const input = knowledgeDocumentUpdateSchema.parse(req.body);
    const document = await prisma.knowledgeDocument.update({
      where: { id: req.params.id },
      data: {
        ...input,
        ...(input.sourceName !== undefined ? { sourceName: input.sourceName || null } : {}),
        ...(input.summary !== undefined ? { summary: input.summary || null } : {}),
        ...(input.tags !== undefined ? { tags: input.tags.map((tag) => tag.toLowerCase()) } : {})
      }
    });
    return res.json(document);
  }
);

router.patch("/knowledge-documents/:id/archive", authorize("diretor", "gerente"), async (req, res) => {
  const isActive = req.body?.isActive === true;
  const document = await prisma.knowledgeDocument.update({ where: { id: req.params.id }, data: { isActive } });
  return res.json(document);
});

router.get("/knowledge-documents/ai-context", authorize("diretor", "gerente"), async (req, res) => {
  const result = await getKnowledgeContextForAi(String(req.query.q || ""));
  return res.json({ context: result.context, documents: result.documents, elapsedMs: result.elapsedMs, maxChars: 2400 });
});

router.get("/objectives", authorize("diretor", "gerente"), async (req, res) => {
  const parsedPeriod = parseObjectivePeriod(req.query.month as string | undefined, req.query.year as string | undefined);

  if (!parsedPeriod) {
    return res.status(400).json({ message: "Mês/ano inválidos" });
  }

  const goals = await prisma.goal.findMany({
    where: { month: parsedPeriod.monthKey },
    orderBy: { createdAt: "desc" }
  });

  return res.json(
    goals.map((goal) => ({
      id: goal.id,
      userId: goal.sellerId,
      month: parsedPeriod.month,
      year: parsedPeriod.year,
      amount: goal.targetValue,
      createdAt: goal.createdAt
    }))
  );
});

router.put("/objectives/:userId", authorize("diretor", "gerente"), validateBody(objectiveUpsertSchema), async (req, res) => {
  const { month, year, amount } = req.body;
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const seller = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, role: true } });

  if (!seller || seller.role !== "vendedor") {
    return res.status(404).json({ message: "Vendedor não encontrado" });
  }

  if (amount === 0) {
    await prisma.goal.deleteMany({
      where: {
        sellerId: req.params.userId,
        month: monthKey
      }
    });

    return res.json({
      userId: req.params.userId,
      month,
      year,
      amount: null,
      removed: true
    });
  }

  const goal = await prisma.goal.upsert({
    where: {
      sellerId_month: {
        sellerId: req.params.userId,
        month: monthKey
      }
    },
    update: {
      targetValue: amount
    },
    create: {
      sellerId: req.params.userId,
      month: monthKey,
      targetValue: amount
    }
  });

  return res.json({
    id: goal.id,
    userId: goal.sellerId,
    month,
    year,
    amount: goal.targetValue,
    createdAt: goal.createdAt,
    removed: false
  });
});

router.delete("/objectives/:userId", authorize("diretor", "gerente"), async (req, res) => {
  const parsedPeriod = parseObjectivePeriod(req.query.month as string | undefined, req.query.year as string | undefined);

  if (!parsedPeriod) {
    return res.status(400).json({ message: "Mês/ano inválidos" });
  }

  const seller = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, role: true } });

  if (!seller || seller.role !== "vendedor") {
    return res.status(404).json({ message: "Vendedor não encontrado" });
  }

  await prisma.goal.deleteMany({
    where: {
      sellerId: req.params.userId,
      month: parsedPeriod.monthKey
    }
  });

  return res.status(204).send();
});

router.get("/goals", async (req, res) => {
  const sellerId = req.user!.role === "vendedor" ? req.user!.id : (req.query.sellerId as string | undefined);
  res.json(await prisma.goal.findMany({ where: sellerId ? { sellerId } : {}, include: { seller: { select: { name: true, email: true } } }, orderBy: [{ month: "desc" }] }));
});
router.get("/activity-kpis", async (req, res) => {
  const month = req.query.month as string | undefined;
  const sellerIdQuery = req.query.sellerId as string | undefined;

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ message: "month deve estar no formato YYYY-MM" });
  }

  const sellerId = req.user!.role === "vendedor" ? req.user!.id : sellerIdQuery;
  const { start, end } = getMonthRangeFromKey(month);

  const [activityKpis, monthActivityCounts, visitCountsBySeller] = await Promise.all([
    prisma.activityKPI.findMany({
      where: {
        month,
        ...(sellerId ? { sellerId } : {})
      },
      include: {
        seller: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: [{ sellerId: "asc" }, { type: "asc" }]
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId", "type"],
      where: {
        ...(sellerId ? { ownerSellerId: sellerId } : sellerWhere(req)),
        done: true,
        ...resolveExecutionActivityDateFilter(start, end)
      },
      _count: { _all: true }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...(sellerId ? { ownerSellerId: sellerId } : sellerWhere(req)),
        done: true,
        type: { in: [...VISIT_TYPES] },
        date: { gte: start, lte: end }
      },
      _count: { _all: true }
    })
  ]);

  const logicalCountBySellerAndType = new Map(
    monthActivityCounts.map((countEntry) => [`${countEntry.ownerSellerId}:${countEntry.type}`, countEntry._count._all])
  );
  const visitLogicalCountBySeller = new Map(visitCountsBySeller.map((countEntry) => [countEntry.ownerSellerId, countEntry._count._all]));

  return res.json(
    activityKpis.map((activityKpi) => ({
      ...activityKpi,
      logicalCount: VISIT_TYPES.includes(activityKpi.type as (typeof VISIT_TYPES)[number])
        ? (visitLogicalCountBySeller.get(activityKpi.sellerId) ?? 0)
        : (logicalCountBySellerAndType.get(`${activityKpi.sellerId}:${activityKpi.type}`) ?? 0)
    }))
  );
});

router.put("/activity-kpis/:sellerId", authorize("diretor", "gerente"), validateBody(activityKpiUpsertSchema), async (req, res) => {
  const seller = await prisma.user.findUnique({ where: { id: req.params.sellerId }, select: { id: true, role: true } });

  if (!seller || seller.role !== "vendedor") {
    return res.status(404).json({ message: "Vendedor não encontrado" });
  }

  const activityKpi = await prisma.activityKPI.upsert({
    where: {
      sellerId_month_type: {
        sellerId: req.params.sellerId,
        month: req.body.month,
        type: req.body.type
      }
    },
    update: {
      targetValue: req.body.targetValue
    },
    create: {
      sellerId: req.params.sellerId,
      month: req.body.month,
      type: req.body.type,
      targetValue: req.body.targetValue
    },
    include: {
      seller: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  return res.json(activityKpi);
});

router.post("/goals", authorize("diretor", "gerente"), validateBody(goalSchema), async (req, res) => res.status(201).json(await prisma.goal.create({ data: req.body })));
router.put("/goals/:id", authorize("diretor", "gerente"), validateBody(goalSchema.partial()), async (req, res) => res.json(await prisma.goal.update({ where: { id: req.params.id }, data: req.body })));
router.delete("/goals/:id", authorize("diretor", "gerente"), async (req, res) => { await prisma.goal.delete({ where: { id: req.params.id } }); res.status(204).send(); });



const TERRITORY_ALLOWED_STATES = ["PR", "SC", "MS"] as const;
type TerritoryAllowedState = (typeof TERRITORY_ALLOWED_STATES)[number];
type OfficialTerritoryCity = { city: string; state: TerritoryAllowedState; ibgeCode: string | null };

const TERRITORY_GEOJSON_STATES: Record<TerritoryAllowedState, string> = {
  PR: "https://cdn.jsdelivr.net/gh/tbrugz/geodata-br@master/geojson/geojs-41-mun.json",
  SC: "https://cdn.jsdelivr.net/gh/tbrugz/geodata-br@master/geojson/geojs-42-mun.json",
  MS: "https://cdn.jsdelivr.net/gh/tbrugz/geodata-br@master/geojson/geojs-50-mun.json"
};

const FALLBACK_OFFICIAL_TERRITORY_CITIES: OfficialTerritoryCity[] = [
  { city: "Cascavel", state: "PR", ibgeCode: "4104808" },
  { city: "Toledo", state: "PR", ibgeCode: "4127700" },
  { city: "Santa Helena", state: "PR", ibgeCode: "4123501" },
  { city: "Mundo Novo", state: "MS", ibgeCode: "5005681" },
  { city: "Eldorado", state: "MS", ibgeCode: "5003751" },
  { city: "Ponta Porã", state: "MS", ibgeCode: "5006606" },
  { city: "Joinville", state: "SC", ibgeCode: "4209102" },
  { city: "Florianópolis", state: "SC", ibgeCode: "4205407" },
  { city: "Campo Grande", state: "MS", ibgeCode: "5002704" }
];

const territoryOfficialCitiesCache = new Map<TerritoryAllowedState, OfficialTerritoryCity[]>();

const isTerritoryAllowedState = (state: string): state is TerritoryAllowedState => TERRITORY_ALLOWED_STATES.includes(normalizeState(state) as TerritoryAllowedState);

const getOfficialFeatureCityName = (properties: Record<string, unknown>) => {
  const candidate = properties.name ?? properties.nome ?? properties.NM_MUN ?? properties.NM_MUNICIP ?? properties.description ?? properties.municipio ?? properties.MUNICIPIO;
  return String(candidate ?? "").replace(/\s+/g, " ").trim();
};

const getOfficialFeatureIbgeCode = (properties: Record<string, unknown>) => {
  const candidate = properties.id ?? properties.codigo_ibge ?? properties.CD_MUN ?? properties.CD_GEOCMU ?? properties.geocodigo;
  return candidate === undefined || candidate === null ? null : String(candidate);
};

const fetchOfficialTerritoryCitiesByState = async (state: TerritoryAllowedState) => {
  const cached = territoryOfficialCitiesCache.get(state);
  if (cached) return cached;

  try {
    const response = await fetch(TERRITORY_GEOJSON_STATES[state]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const geoJson = await response.json() as { features?: Array<{ properties?: Record<string, unknown> }> };
    const cities = (geoJson.features ?? [])
      .map((feature) => ({
        city: getOfficialFeatureCityName(feature.properties ?? {}),
        state,
        ibgeCode: getOfficialFeatureIbgeCode(feature.properties ?? {})
      }))
      .filter((city): city is OfficialTerritoryCity => Boolean(city.city))
      .sort((a, b) => a.city.localeCompare(b.city, "pt-BR"));

    if (cities.length > 0) {
      territoryOfficialCitiesCache.set(state, cities);
      return cities;
    }
  } catch {
    // Mantém fallback local seguro para preview/dev quando a rede do GeoJSON não estiver disponível.
  }

  const fallbackCities = FALLBACK_OFFICIAL_TERRITORY_CITIES.filter((city) => city.state === state);
  territoryOfficialCitiesCache.set(state, fallbackCities);
  return fallbackCities;
};

const listOfficialTerritoryCities = async (state?: string) => {
  const states = state ? [normalizeState(state)] : [...TERRITORY_ALLOWED_STATES];
  const validStates = states.filter(isTerritoryAllowedState);
  const cityGroups = await Promise.all(validStates.map((uf) => fetchOfficialTerritoryCitiesByState(uf)));
  return cityGroups.flat().sort((a, b) => a.state.localeCompare(b.state) || a.city.localeCompare(b.city, "pt-BR"));
};

const findOfficialTerritoryCity = async (state: string, city: string, ibgeCode?: string | null) => {
  const normalizedState = normalizeState(state);
  if (!isTerritoryAllowedState(normalizedState)) return null;
  const officialCities = await fetchOfficialTerritoryCitiesByState(normalizedState);
  const normalizedIbgeCode = ibgeCode?.trim();
  if (normalizedIbgeCode) {
    const officialByIbge = officialCities.find((officialCity) => officialCity.ibgeCode === normalizedIbgeCode);
    if (officialByIbge) return officialByIbge;
  }

  const normalizedCityKey = normalizeTerritoryCityKey(city);
  return officialCities.find((officialCity) => normalizeTerritoryCityKey(officialCity.city) === normalizedCityKey) ?? null;
};

const territoryCityInputSchema = z.object({
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(2).max(2).transform((value) => normalizeState(value)).refine(isTerritoryAllowedState, { message: "UF inválida para território comercial." }),
  ibgeCode: z.string().trim().max(32).optional().nullable()
});

const territoryCitySaveSchema = z.object({
  cities: z.array(territoryCityInputSchema).max(500)
});

const territoryBulkCitySchema = z.object({
  sellerId: z.string().trim().min(1),
  text: z.string().min(1).max(20_000)
});

const TERRITORY_KML_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const TERRITORY_KML_IMPORT_ALLOWED_EXTENSIONS = [".kml", ".kmz"] as const;

type TerritoryKmlImportItemStatus = "to_add" | "already_seller" | "conflict" | "not_found" | "duplicate_file";
type TerritoryKmlImportItem = {
  sourceName: string;
  city: string | null;
  state: TerritoryAllowedState | null;
  ibgeCode: string | null;
  status: TerritoryKmlImportItemStatus;
  message: string;
  sellerName?: string;
};

const territoryKmlConfirmSchema = z.object({
  sellerId: z.string().trim().min(1),
  cities: z.array(territoryCityInputSchema).max(500)
});

const decodeXmlEntities = (value: string) => value
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '\"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&");

const stripXmlTags = (value: string) => decodeXmlEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

const extractPlacemarkNamesFromKml = (kml: string) => {
  const names: string[] = [];
  const placemarkRegex = /<(?:\w+:)?Placemark\b[\s\S]*?<\/(?:\w+:)?Placemark>/gi;
  let placemarkMatch: RegExpExecArray | null;
  while ((placemarkMatch = placemarkRegex.exec(kml)) !== null) {
    const placemarkXml = placemarkMatch[0];
    const nameMatch = placemarkXml.match(/<(?:\w+:)?name\b[^>]*>([\s\S]*?)<\/(?:\w+:)?name>/i);
    if (!nameMatch) continue;
    const name = stripXmlTags(nameMatch[1]);
    if (name) names.push(name);
  }
  return names;
};

const inflateZipData = (method: number, compressed: Buffer) => {
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) return inflateRawSync(compressed, { finishFlush: 2 });
  return null;
};

const readZipLocalFile = (buffer: Buffer, offset: number, centralDirectorySizes?: { compressedSize: number; uncompressedSize: number; method: number }) => {
  if (buffer.readUInt32LE(offset) !== 0x04034b50) return null;
  const method = centralDirectorySizes?.method ?? buffer.readUInt16LE(offset + 8);
  const compressedSize = centralDirectorySizes?.compressedSize ?? buffer.readUInt32LE(offset + 18);
  const uncompressedSize = centralDirectorySizes?.uncompressedSize ?? buffer.readUInt32LE(offset + 22);
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const dataStart = nameStart + fileNameLength + extraLength;
  const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
  if (dataStart + compressedSize > buffer.length || uncompressedSize > TERRITORY_KML_IMPORT_MAX_BYTES) return null;
  const data = inflateZipData(method, buffer.subarray(dataStart, dataStart + compressedSize));
  if (!data) return null;
  return { name, data, nextOffset: dataStart + compressedSize };
};

const findZipEndOfCentralDirectory = (buffer: Buffer) => {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
};

const extractFirstKmlFromKmzCentralDirectory = (buffer: Buffer) => {
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) return null;
  const entries = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < entries && centralOffset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
    const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
    const nameStart = centralOffset + 46;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    if (name.toLowerCase().endsWith(".kml") && !name.endsWith("/")) {
      const entry = readZipLocalFile(buffer, localHeaderOffset, { compressedSize, uncompressedSize, method });
      return entry?.data.toString("utf8") ?? null;
    }
    centralOffset = nameStart + fileNameLength + extraLength + commentLength;
  }

  return null;
};

const extractFirstKmlFromKmz = (buffer: Buffer) => {
  const centralDirectoryKml = extractFirstKmlFromKmzCentralDirectory(buffer);
  if (centralDirectoryKml) return centralDirectoryKml;

  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const entry = readZipLocalFile(buffer, offset);
    if (!entry) {
      offset += 1;
      continue;
    }
    if (entry.name.toLowerCase().endsWith(".kml") && !entry.name.endsWith("/")) return entry.data.toString("utf8");
    offset = entry.nextOffset;
  }
  return null;
};

const getKmlTextFromImportFile = (fileName: string, fileBuffer: Buffer) => {
  const normalizedName = fileName.toLowerCase();
  if (normalizedName.endsWith(".kml")) return fileBuffer.toString("utf8");
  if (normalizedName.endsWith(".kmz")) return extractFirstKmlFromKmz(fileBuffer);
  return null;
};

const parseMultipartFormData = (req: Request) => {
  const contentType = req.headers["content-type"] ?? "";
  const boundaryMatch = String(contentType).match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!boundaryMatch) return null;
  const boundary = `--${boundaryMatch[1] ?? boundaryMatch[2]}`;
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("binary") : "";
  const fields = new Map<string, string>();
  let file: { fileName: string; buffer: Buffer } | null = null;

  for (const part of rawBody.split(boundary)) {
    if (!part || part === "--\r\n" || part === "--") continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const rawHeaders = part.slice(0, headerEnd);
    let content = part.slice(headerEnd + 4);
    if (content.endsWith("\r\n")) content = content.slice(0, -2);
    if (content.endsWith("--")) content = content.slice(0, -2);
    const nameMatch = rawHeaders.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const fileNameMatch = rawHeaders.match(/filename="([^"]*)"/i);
    if (fileNameMatch) {
      file = { fileName: fileNameMatch[1], buffer: Buffer.from(content, "binary") };
    } else {
      fields.set(fieldName, Buffer.from(content, "binary").toString("utf8").trim());
    }
  }

  return { fields, file };
};

const resolveOfficialCityFromPlacemarkName = async (name: string) => {
  const matches: OfficialTerritoryCity[] = [];
  for (const state of TERRITORY_ALLOWED_STATES) {
    const city = await findOfficialTerritoryCity(state, name);
    if (city) matches.push(city);
  }
  return matches.length === 1 ? matches[0] : null;
};

const buildTerritoryKmlImportPreview = async (sellerId: string, placemarkNames: string[]) => {
  const existingCities = await prisma.sellerTerritoryCity.findMany({
    select: { sellerId: true, city: true, state: true, ibgeCode: true, seller: { select: { id: true, name: true } } }
  });
  const existingByKey = new Map(existingCities.map((city) => [getTerritoryCityStableKey(city), city]));
  const seenInFile = new Set<string>();
  const items: TerritoryKmlImportItem[] = [];

  for (const sourceName of placemarkNames) {
    const officialCity = await resolveOfficialCityFromPlacemarkName(sourceName);
    if (!officialCity) {
      items.push({ sourceName, city: null, state: null, ibgeCode: null, status: "not_found", message: `Cidade não encontrada no catálogo oficial: ${sourceName}.` });
      continue;
    }

    const key = getTerritoryCityStableKey(officialCity);
    if (seenInFile.has(key)) {
      items.push({ sourceName, city: officialCity.city, state: officialCity.state, ibgeCode: officialCity.ibgeCode, status: "duplicate_file", message: "Cidade duplicada no arquivo de importação." });
      continue;
    }
    seenInFile.add(key);

    const existing = existingByKey.get(key);
    if (existing?.sellerId === sellerId) {
      items.push({ sourceName, city: officialCity.city, state: officialCity.state, ibgeCode: officialCity.ibgeCode, status: "already_seller", message: "Esta cidade já está vinculada a este vendedor." });
      continue;
    }
    if (existing && existing.sellerId !== sellerId) {
      items.push({ sourceName, city: officialCity.city, state: officialCity.state, ibgeCode: officialCity.ibgeCode, status: "conflict", sellerName: existing.seller.name, message: `Esta cidade já está vinculada ao vendedor ${existing.seller.name}.` });
      continue;
    }

    items.push({ sourceName, city: officialCity.city, state: officialCity.state, ibgeCode: officialCity.ibgeCode, status: "to_add", message: "Cidade válida para importação." });
  }

  const summary = {
    totalRead: placemarkNames.length,
    valid: items.filter((item) => item.status !== "not_found").length,
    alreadySeller: items.filter((item) => item.status === "already_seller").length,
    linkedToOtherSeller: items.filter((item) => item.status === "conflict").length,
    notFound: items.filter((item) => item.status === "not_found").length,
    duplicateInFile: items.filter((item) => item.status === "duplicate_file").length,
    toAdd: items.filter((item) => item.status === "to_add").length
  };

  return { summary, items, citiesToAdd: items.filter((item) => item.status === "to_add").map((item) => ({ city: item.city!, state: item.state!, ibgeCode: item.ibgeCode })) };
};

const OPEN_TERRITORY_OPPORTUNITY_STAGES = [OpportunityStage.prospeccao, OpportunityStage.negociacao, OpportunityStage.proposta] as const;

const toTerritoryCityResponse = (city: { id: string; sellerId: string; city: string; state: string; ibgeCode: string | null }) => ({
  id: city.id,
  sellerId: city.sellerId,
  city: city.city,
  state: normalizeState(city.state),
  ibgeCode: city.ibgeCode
});

const normalizeTerritoryCityName = (city: string) => city.replace(/\s+/g, " ").trim();
const getTerritoryCityNormalizedKey = (state: string, city: string) => `${normalizeState(state)}::${normalizeTerritoryCityKey(city)}`;
const getTerritoryCityStableKey = (city: { state: string; city: string; ibgeCode?: string | null }) => {
  const normalizedState = normalizeState(city.state);
  const normalizedIbgeCode = city.ibgeCode?.trim();
  return normalizedIbgeCode ? `${normalizedState}::IBGE::${normalizedIbgeCode}` : getTerritoryCityNormalizedKey(city.state, city.city);
};

const parseBulkTerritoryCities = (text: string) => text
  .split(/\r?\n|;/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [city = "", state = ""] = line.split("/").map((part) => part.trim());
    return { city, state };
  });

const getTerritoryActor = async (req: Request) => {
  if (!req.user?.id) return null;
  return prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, role: true, region: true }
  });
};

const isNationalTerritoryRegion = (region?: string | null) => normalizeText(region).toLowerCase() === "nacional";

const getTerritorySellerWhereForActor = (actor: { id: string; role: Role; region: string | null }) => {
  if (actor.role === "vendedor") return { id: actor.id, role: "vendedor" as const, isActive: true };
  if (actor.role === "gerente" && actor.region?.trim() && !isNationalTerritoryRegion(actor.region)) {
    return { role: "vendedor" as const, isActive: true, region: actor.region };
  }
  return { role: "vendedor" as const, isActive: true };
};

const assertTerritorySellerAccess = async (req: Request, sellerId: string, mode: "read" | "edit") => {
  const actor = await getTerritoryActor(req);
  if (!actor) return { allowed: false as const, status: 401, message: "Não autenticado" };
  if (mode === "edit" && actor.role === "vendedor") {
    return { allowed: false as const, status: 403, message: "Vendedores podem apenas visualizar o próprio território." };
  }

  const seller = await prisma.user.findUnique({
    where: { id: sellerId },
    select: { id: true, name: true, role: true, region: true, isActive: true }
  });

  if (!seller || seller.role !== "vendedor" || !seller.isActive) {
    return { allowed: false as const, status: 404, message: "Vendedor não encontrado." };
  }

  if (actor.role === "vendedor" && seller.id !== actor.id) {
    return { allowed: false as const, status: 403, message: "Vendedores podem visualizar apenas o próprio território." };
  }

  if (actor.role === "gerente" && actor.region?.trim() && !isNationalTerritoryRegion(actor.region) && seller.region !== actor.region) {
    return { allowed: false as const, status: 403, message: "Gerente pode editar apenas vendedores da própria equipe/região." };
  }

  return { allowed: true as const, actor, seller, canEdit: actor.role === "diretor" || actor.role === "gerente" };
};

const validateOfficialTerritoryCities = async (cities: Array<{ city: string; state: string; ibgeCode?: string | null }>) => {
  const seen = new Set<string>();
  const officialCities: OfficialTerritoryCity[] = [];
  const errors: string[] = [];

  for (const inputCity of cities) {
    const normalizedState = normalizeState(inputCity.state);
    if (!isTerritoryAllowedState(normalizedState)) {
      errors.push(`UF inválida: ${inputCity.state || "-"}`);
      continue;
    }

    const officialCity = await findOfficialTerritoryCity(normalizedState, inputCity.city, inputCity.ibgeCode);
    if (!officialCity) {
      errors.push(`Cidade não encontrada: ${normalizeTerritoryCityName(inputCity.city)}/${normalizedState}`);
      continue;
    }

    const key = getTerritoryCityStableKey(officialCity);
    if (seen.has(key)) {
      errors.push("Esta cidade já está vinculada a este vendedor.");
      continue;
    }

    seen.add(key);
    officialCities.push({
      city: officialCity.city,
      state: officialCity.state,
      ibgeCode: officialCity.ibgeCode ?? inputCity.ibgeCode?.trim() ?? null
    });
  }

  return { cities: officialCities, errors };
};

const findExistingTerritoryCityByNormalizedKey = async (sellerId: string, state: string, city: string, ibgeCode?: string | null) => {
  const normalizedKey = getTerritoryCityNormalizedKey(state, city);
  const normalizedIbgeCode = ibgeCode?.trim();
  const sameStateCities = await prisma.sellerTerritoryCity.findMany({
    where: { sellerId, state: normalizeState(state) },
    select: { id: true, sellerId: true, city: true, state: true, ibgeCode: true }
  });
  if (normalizedIbgeCode) {
    const existingByIbge = sameStateCities.find((item) => item.ibgeCode === normalizedIbgeCode);
    if (existingByIbge) return existingByIbge;
  }
  return sameStateCities.find((item) => getTerritoryCityNormalizedKey(item.state, item.city) === normalizedKey) ?? null;
};

const findTerritoryCityLinkedToOtherSeller = async (sellerId: string, state: string, city: string, ibgeCode?: string | null) => {
  const normalizedKey = getTerritoryCityNormalizedKey(state, city);
  const normalizedIbgeCode = ibgeCode?.trim();
  const sameStateCities = await prisma.sellerTerritoryCity.findMany({
    where: { state: normalizeState(state), sellerId: { not: sellerId } },
    select: { id: true, city: true, state: true, ibgeCode: true, seller: { select: { id: true, name: true } } }
  });
  if (normalizedIbgeCode) {
    const conflictByIbge = sameStateCities.find((item) => item.ibgeCode === normalizedIbgeCode);
    if (conflictByIbge) return conflictByIbge;
  }
  return sameStateCities.find((item) => getTerritoryCityNormalizedKey(item.state, item.city) === normalizedKey) ?? null;
};

const findTerritoryCityConflict = async (sellerId: string, cities: OfficialTerritoryCity[]) => {
  for (const city of cities) {
    const conflict = await findTerritoryCityLinkedToOtherSeller(sellerId, city.state, city.city, city.ibgeCode);
    if (conflict) return conflict;
  }
  return null;
};

const getTerritoryCityConflictMessage = (sellerName: string) => `Esta cidade já está vinculada ao vendedor ${sellerName}. Remova do território atual antes de transferir.`;

router.get("/territories/sellers", async (req, res) => {
  const actor = await getTerritoryActor(req);
  if (!actor) return res.status(401).json({ message: "Não autenticado" });

  const users = await prisma.user.findMany({
    where: getTerritorySellerWhereForActor(actor),
    select: { id: true, name: true, role: true, isActive: true },
    orderBy: { name: "asc" }
  });
  return res.json(users);
});

router.get("/territories/config/sellers", authorize("diretor", "gerente"), async (req, res) => {
  const actor = await getTerritoryActor(req);
  if (!actor) return res.status(401).json({ message: "Não autenticado" });

  const users = await prisma.user.findMany({
    where: getTerritorySellerWhereForActor(actor),
    select: { id: true, name: true, role: true, region: true, isActive: true },
    orderBy: { name: "asc" }
  });
  return res.json(users.map((seller) => ({
    ...seller,
    canEdit: actor.role === "diretor" || actor.role === "gerente"
  })));
});

router.get("/territories/config/official-cities", authorize("diretor", "gerente"), async (req, res) => {
  const state = typeof req.query.uf === "string" ? req.query.uf : undefined;
  const officialCities = await listOfficialTerritoryCities(state);
  return res.json(officialCities);
});

router.get("/territories/config/city-links", authorize("diretor", "gerente"), async (req, res) => {
  const actor = await getTerritoryActor(req);
  if (!actor) return res.status(401).json({ message: "Não autenticado" });

  const sellerWhereForActor = getTerritorySellerWhereForActor(actor);
  const cities = await prisma.sellerTerritoryCity.findMany({
    where: { seller: sellerWhereForActor },
    select: {
      id: true,
      sellerId: true,
      city: true,
      state: true,
      ibgeCode: true,
      seller: { select: { id: true, name: true } }
    },
    orderBy: [{ state: "asc" }, { city: "asc" }]
  });

  return res.json(cities.map((city) => ({ ...toTerritoryCityResponse(city), sellerName: city.seller.name })));
});

router.post("/territories/config/import-kml-preview", authorize("diretor", "gerente"), express.raw({ type: ["multipart/form-data", "application/vnd.google-earth.kmz", "application/vnd.google-earth.kml+xml", "application/octet-stream", "text/xml", "application/xml"], limit: TERRITORY_KML_IMPORT_MAX_BYTES }), async (req, res) => {
  const parsed = parseMultipartFormData(req);
  const sellerId = parsed?.fields.get("sellerId") ?? (typeof req.query.sellerId === "string" ? req.query.sellerId : "");
  const uploadedFile = parsed?.file;

  if (!sellerId) return res.status(400).json({ message: "Informe um vendedor para importar territórios." });
  const access = await assertTerritorySellerAccess(req, sellerId, "edit");
  if (!access.allowed) return res.status(access.status).json({ message: access.message });
  if (!uploadedFile) return res.status(400).json({ message: "Envie um arquivo .kml ou .kmz." });
  if (uploadedFile.buffer.length > TERRITORY_KML_IMPORT_MAX_BYTES) return res.status(413).json({ message: "Arquivo excede o limite de 8 MB." });

  const extension = uploadedFile.fileName.toLowerCase().slice(uploadedFile.fileName.lastIndexOf("."));
  if (!TERRITORY_KML_IMPORT_ALLOWED_EXTENSIONS.includes(extension as (typeof TERRITORY_KML_IMPORT_ALLOWED_EXTENSIONS)[number])) {
    return res.status(400).json({ message: "Formato inválido. Envie um arquivo .kml ou .kmz." });
  }

  const kmlText = getKmlTextFromImportFile(uploadedFile.fileName, uploadedFile.buffer);
  if (!kmlText) return res.status(400).json({ message: "Não foi possível localizar um arquivo .kml válido para processar." });

  const placemarkNames = extractPlacemarkNamesFromKml(kmlText);
  const preview = await buildTerritoryKmlImportPreview(sellerId, placemarkNames);
  return res.json({ fileName: uploadedFile.fileName, sellerId, ...preview });
});

router.post("/territories/config/import-kml-confirm", authorize("diretor", "gerente"), validateBody(territoryKmlConfirmSchema), async (req, res) => {
  const { sellerId } = req.body;
  const access = await assertTerritorySellerAccess(req, sellerId, "edit");
  if (!access.allowed) return res.status(access.status).json({ message: access.message });

  const officialValidation = await validateOfficialTerritoryCities(req.body.cities);
  if (officialValidation.errors.length > 0) return res.status(400).json({ message: officialValidation.errors[0], errors: officialValidation.errors });

  const existingCities = await prisma.sellerTerritoryCity.findMany({ where: { sellerId }, select: { state: true, city: true, ibgeCode: true } });
  const existingKeys = new Set(existingCities.map((city) => getTerritoryCityStableKey(city)));
  const citiesToCreate: OfficialTerritoryCity[] = [];

  for (const city of officialValidation.cities) {
    const key = getTerritoryCityStableKey(city);
    if (existingKeys.has(key)) continue;
    const conflict = await findTerritoryCityLinkedToOtherSeller(sellerId, city.state, city.city, city.ibgeCode);
    if (conflict) return res.status(409).json({ message: getTerritoryCityConflictMessage(conflict.seller.name) });
    existingKeys.add(key);
    citiesToCreate.push(city);
  }

  if (citiesToCreate.length > 0) {
    await prisma.sellerTerritoryCity.createMany({
      data: citiesToCreate.map((city) => ({ sellerId, ...city })),
      skipDuplicates: true
    });
  }

  const savedCities = await prisma.sellerTerritoryCity.findMany({
    where: { sellerId },
    orderBy: [{ state: "asc" }, { city: "asc" }]
  });

  return res.status(201).json({ created: citiesToCreate.length, cities: savedCities.map(toTerritoryCityResponse) });
});

router.get("/territories/config/cities", authorize("diretor", "gerente"), async (req, res) => {
  const requestedSellerId = typeof req.query.sellerId === "string" ? req.query.sellerId : undefined;
  const sellerId = req.user?.role === "vendedor" ? req.user.id : requestedSellerId;
  const search = typeof req.query.q === "string" ? req.query.q : "";
  const uf = typeof req.query.uf === "string" ? normalizeState(req.query.uf) : "";

  if (!sellerId) return res.status(400).json({ message: "Informe um vendedor para consultar territórios." });
  const access = await assertTerritorySellerAccess(req, sellerId, "read");
  if (!access.allowed) return res.status(access.status).json({ message: access.message });

  const cities = await prisma.sellerTerritoryCity.findMany({
    where: {
      sellerId,
      ...(uf ? { state: uf } : {}),
      ...(search.trim() ? { city: { contains: search.trim(), mode: "insensitive" } } : {})
    },
    orderBy: [{ state: "asc" }, { city: "asc" }]
  });

  return res.json(cities.map(toTerritoryCityResponse));
});

router.post("/territories/config/cities", authorize("diretor", "gerente"), validateBody(territoryCityInputSchema.extend({ sellerId: z.string().trim().min(1) })), async (req, res) => {
  const { sellerId, city, state } = req.body;
  const access = await assertTerritorySellerAccess(req, sellerId, "edit");
  if (!access.allowed) return res.status(access.status).json({ message: access.message });

  const officialValidation = await validateOfficialTerritoryCities([{ city, state, ibgeCode: req.body.ibgeCode }]);
  if (officialValidation.errors.length > 0 || officialValidation.cities.length === 0) {
    return res.status(400).json({ message: officialValidation.errors[0] ?? "Cidade oficial inválida." });
  }

  const [officialCity] = officialValidation.cities;
  const existing = await findExistingTerritoryCityByNormalizedKey(sellerId, officialCity.state, officialCity.city, officialCity.ibgeCode);
  if (existing) return res.status(409).json({ message: "Esta cidade já está vinculada a este vendedor." });

  const conflict = await findTerritoryCityLinkedToOtherSeller(sellerId, officialCity.state, officialCity.city, officialCity.ibgeCode);
  if (conflict) return res.status(409).json({ message: getTerritoryCityConflictMessage(conflict.seller.name) });

  const saved = await prisma.sellerTerritoryCity.create({ data: { sellerId, ...officialCity } });
  return res.status(201).json(toTerritoryCityResponse(saved));
});

router.post("/territories/config/cities/bulk", authorize("diretor", "gerente"), validateBody(territoryBulkCitySchema), async (req, res) => {
  const { sellerId, text } = req.body;
  const access = await assertTerritorySellerAccess(req, sellerId, "edit");
  if (!access.allowed) return res.status(access.status).json({ message: access.message });

  const parsed = parseBulkTerritoryCities(text);
  const schemaErrors = parsed
    .filter((city) => !territoryCityInputSchema.safeParse(city).success)
    .map((city) => `Cidade não encontrada: ${normalizeTerritoryCityName(city.city)}/${normalizeState(city.state)}`);
  const validShapeCities = parsed
    .map((city) => territoryCityInputSchema.safeParse(city))
    .filter((result): result is z.SafeParseSuccess<z.infer<typeof territoryCityInputSchema>> => result.success)
    .map((result) => result.data);
  const officialValidation = await validateOfficialTerritoryCities(validShapeCities);
  const errors = [...schemaErrors, ...officialValidation.errors];

  const existingCities = await prisma.sellerTerritoryCity.findMany({ where: { sellerId }, select: { state: true, city: true, ibgeCode: true } });
  const existingKeys = new Set(existingCities.map((city) => getTerritoryCityStableKey(city)));
  const citiesToCreate: OfficialTerritoryCity[] = [];

  for (const city of officialValidation.cities) {
    const key = getTerritoryCityStableKey(city);
    if (existingKeys.has(key)) {
      errors.push("Esta cidade já está vinculada a este vendedor.");
      continue;
    }

    const conflict = await findTerritoryCityLinkedToOtherSeller(sellerId, city.state, city.city, city.ibgeCode);
    if (conflict) {
      errors.push(getTerritoryCityConflictMessage(conflict.seller.name));
      continue;
    }

    existingKeys.add(key);
    citiesToCreate.push(city);
  }

  if (citiesToCreate.length > 0) {
    await prisma.sellerTerritoryCity.createMany({
      data: citiesToCreate.map((city) => ({ sellerId, ...city })),
      skipDuplicates: true
    });
  }

  const savedCities = await prisma.sellerTerritoryCity.findMany({
    where: { sellerId },
    orderBy: [{ state: "asc" }, { city: "asc" }]
  });

  return res.status(201).json({ created: citiesToCreate.length, errors, cities: savedCities.map(toTerritoryCityResponse) });
});

router.put("/territories/config/sellers/:sellerId/cities", authorize("diretor", "gerente"), validateBody(territoryCitySaveSchema), async (req, res) => {
  const { sellerId } = req.params;
  const access = await assertTerritorySellerAccess(req, sellerId, "edit");
  if (!access.allowed) return res.status(access.status).json({ message: access.message });

  const officialValidation = await validateOfficialTerritoryCities(req.body.cities);
  if (officialValidation.errors.length > 0) return res.status(400).json({ message: officialValidation.errors[0], errors: officialValidation.errors });

  const conflict = await findTerritoryCityConflict(sellerId, officialValidation.cities);
  if (conflict) return res.status(409).json({ message: getTerritoryCityConflictMessage(conflict.seller.name) });

  await prisma.$transaction(async (tx) => {
    await tx.sellerTerritoryCity.deleteMany({ where: { sellerId } });
    if (officialValidation.cities.length > 0) {
      await tx.sellerTerritoryCity.createMany({
        data: officialValidation.cities.map((city) => ({ sellerId, ...city })),
        skipDuplicates: true
      });
    }
  });

  const savedCities = await prisma.sellerTerritoryCity.findMany({
    where: { sellerId },
    orderBy: [{ state: "asc" }, { city: "asc" }]
  });
  return res.json(savedCities.map(toTerritoryCityResponse));
});

router.put("/territories/config/cities/:id", authorize("diretor", "gerente"), validateBody(territoryCityInputSchema), async (req, res) => {
  const current = await prisma.sellerTerritoryCity.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ message: "Cidade do território não encontrada." });
  const access = await assertTerritorySellerAccess(req, current.sellerId, "edit");
  if (!access.allowed) return res.status(access.status).json({ message: access.message });

  const { city, state } = req.body;
  const officialValidation = await validateOfficialTerritoryCities([{ city, state, ibgeCode: req.body.ibgeCode }]);
  if (officialValidation.errors.length > 0 || officialValidation.cities.length === 0) {
    return res.status(400).json({ message: officialValidation.errors[0] ?? "Cidade oficial inválida." });
  }

  const [officialCity] = officialValidation.cities;
  const existing = await findExistingTerritoryCityByNormalizedKey(current.sellerId, officialCity.state, officialCity.city, officialCity.ibgeCode);
  if (existing && existing.id !== current.id) return res.status(409).json({ message: "Esta cidade já está vinculada a este vendedor." });

  const conflict = await findTerritoryCityLinkedToOtherSeller(current.sellerId, officialCity.state, officialCity.city, officialCity.ibgeCode);
  if (conflict) return res.status(409).json({ message: getTerritoryCityConflictMessage(conflict.seller.name) });

  const updated = await prisma.sellerTerritoryCity.update({
    where: { id: req.params.id },
    data: officialCity
  });
  return res.json(toTerritoryCityResponse(updated));
});

router.delete("/territories/config/cities/:id", authorize("diretor", "gerente"), async (req, res) => {
  const current = await prisma.sellerTerritoryCity.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ message: "Cidade do território não encontrada." });
  const access = await assertTerritorySellerAccess(req, current.sellerId, "edit");
  if (!access.allowed) return res.status(access.status).json({ message: access.message });

  await prisma.sellerTerritoryCity.delete({ where: { id: req.params.id } });
  return res.status(204).send();
});

router.get("/territories/coverage", async (req, res) => {
  const { rawMonth, start, end } = parseTerritoryMonth(req.query.month);
  const requestedSellerId = typeof req.query.sellerId === "string" ? req.query.sellerId : undefined;
  const sellerId = req.user?.role === "vendedor" ? req.user.id : requestedSellerId;

  if (!sellerId) return res.status(400).json({ message: "Informe um vendedor para consultar territórios." });

  const access = await assertTerritorySellerAccess(req, sellerId, "read");
  if (!access.allowed) return res.status(access.status).json({ message: access.message });
  const seller = access.seller;

  const territoryCities = await prisma.sellerTerritoryCity.findMany({
    where: { sellerId },
    orderBy: [{ state: "asc" }, { city: "asc" }]
  });

  const [erpOrders, openOpportunities] = await Promise.all([
    prisma.erpOrderSync.findMany({
      where: {
        sellerId,
        status: ErpOrderSyncStatus.sent,
        OR: [
          { sentAt: { gte: start, lt: end } },
          { sentAt: null, createdAt: { gte: start, lt: end } }
        ]
      },
      select: {
        id: true,
        createdAt: true,
        opportunity: {
          select: {
            id: true,
            title: true,
            value: true,
            client: { select: { city: true, state: true } }
          }
        }
      }
    }),
    prisma.opportunity.findMany({
      where: {
        ownerSellerId: sellerId,
        stage: { in: [...OPEN_TERRITORY_OPPORTUNITY_STAGES] },
        proposalDate: { gte: start, lt: end }
      },
      select: {
        id: true,
        value: true,
        stage: true,
        client: { select: { city: true, state: true } }
      }
    })
  ]);

  const ordersByCity = new Map<string, { orderCount: number; soldValue: number }>();
  for (const order of erpOrders) {
    const client = order.opportunity.client;
    const key = getTerritoryCityNormalizedKey(client.state, client.city);
    const current = ordersByCity.get(key) ?? { orderCount: 0, soldValue: 0 };
    current.orderCount += 1;
    current.soldValue += Number(order.opportunity.value || 0);
    ordersByCity.set(key, current);
  }

  const opportunitiesByCity = new Map<string, { openOpportunityCount: number }>();
  for (const opportunity of openOpportunities) {
    const client = opportunity.client;
    const key = getTerritoryCityNormalizedKey(client.state, client.city);
    const current = opportunitiesByCity.get(key) ?? { openOpportunityCount: 0 };
    current.openOpportunityCount += 1;
    opportunitiesByCity.set(key, current);
  }

  const cities = territoryCities.map((territoryCity) => {
    const normalizedKey = getTerritoryCityNormalizedKey(territoryCity.state, territoryCity.city);
    const orderMetrics = ordersByCity.get(normalizedKey) ?? { orderCount: 0, soldValue: 0 };
    const opportunityMetrics = opportunitiesByCity.get(normalizedKey) ?? { openOpportunityCount: 0 };
    const status = orderMetrics.orderCount > 0
      ? "positive"
      : opportunityMetrics.openOpportunityCount > 0
        ? "opportunity"
        : "no_sale";

    return {
      id: territoryCity.id,
      city: territoryCity.city,
      state: normalizeState(territoryCity.state),
      ibgeCode: territoryCity.ibgeCode,
      status,
      statusLabel: status === "positive" ? "Cidade positivada" : status === "opportunity" ? "Oportunidade aberta" : "Sem venda no mês",
      orderCount: orderMetrics.orderCount,
      soldValue: orderMetrics.soldValue,
      openOpportunityCount: opportunityMetrics.openOpportunityCount
    };
  });

  const positiveCities = cities.filter((city) => city.status === "positive").length;
  const opportunityCities = cities.filter((city) => city.status === "opportunity").length;
  const noSaleCities = cities.filter((city) => city.status === "no_sale").length;
  const totalCities = cities.length;
  const soldValue = cities.reduce((sum, city) => sum + city.soldValue, 0);

  return res.json({
    month: rawMonth,
    seller,
    rules: {
      positive: "Verde quando existe pedido ERP com status sent no mês para cliente da cidade; usa sentAt e fallback createdAt quando sentAt está vazio.",
      opportunity: "Amarelo quando existe oportunidade aberta no mês em prospecção, negociação ou proposta e nenhum pedido ERP enviado na cidade.",
      noSale: "Vermelho quando a cidade pertence ao território, sem pedido ERP e sem oportunidade aberta.",
      outOfTerritory: "Cinza reservado para cidades fora do território no mapa real."
    },
    summary: {
      totalCities,
      positiveCities,
      opportunityCities,
      noSaleCities,
      coveragePercent: totalCities > 0 ? (positiveCities / totalCities) * 100 : 0,
      soldValue
    },
    cities,
    outOfTerritoryPreview: [
      { city: "Fora do território", state: "PR", status: "out_of_territory", statusLabel: "Fora do território", orderCount: 0, soldValue: 0, openOpportunityCount: 0 }
    ]
  });
});

const userListSelect = { id: true, name: true, email: true, role: true, region: true, erpCode: true, erpOperatorCode: true, erpRawPayload: true, erpLoginUsername: true, erpLoginPasswordEncrypted: true, erpLoginLastTestStatus: true, erpLoginLastTestAt: true, isActive: true, createdAt: true } as const;

const sanitizeUserForList = (user: Prisma.UserGetPayload<{ select: typeof userListSelect }>) => {
  const { erpLoginPasswordEncrypted, ...safeUser } = user;
  return {
    ...safeUser,
    erpLoginConfigured: Boolean(user.erpLoginUsername?.trim() && erpLoginPasswordEncrypted),
  };
};

const getUserBlockingLinks = async (id: string) => {
  const [clients, opportunities, activities, agenda, contacts, timeline, goals, kpis, sales, orders, changeLogs, territories, syncRuns] = await Promise.all([
    prisma.client.count({ where: { ownerSellerId: id, isArchived: false } }),
    prisma.opportunity.count({ where: { ownerSellerId: id } }),
    prisma.activity.count({ where: { ownerSellerId: id } }),
    prisma.agendaEvent.count({ where: { sellerId: id } }),
    prisma.contact.count({ where: { ownerSellerId: id } }),
    prisma.timelineEvent.count({ where: { ownerSellerId: id } }),
    prisma.goal.count({ where: { sellerId: id, targetValue: { gt: 0 } } }),
    prisma.activityKPI.count({ where: { sellerId: id } }),
    prisma.sale.count({ where: { sellerId: id } }),
    prisma.erpOrderSync.count({ where: { sellerId: id } }),
    prisma.opportunityChangeLog.count({ where: { actorId: id } }),
    prisma.sellerTerritoryCity.count({ where: { sellerId: id } }),
    prisma.erpSyncRun.count({ where: { sellerId: id } }),
  ]);

  return { clients, opportunities, activities, agenda, contacts, timeline, goals, kpis, sales, orders, changeLogs, territories, syncRuns };
};

const getUserBlockingReasons = (links: Awaited<ReturnType<typeof getUserBlockingLinks>>) => [
  links.clients ? `clientes ativos (${links.clients})` : null,
  links.opportunities ? `oportunidades (${links.opportunities})` : null,
  links.activities ? `atividades (${links.activities})` : null,
  links.timeline ? `timeline (${links.timeline})` : null,
  links.agenda ? `agenda (${links.agenda})` : null,
  links.goals ? `metas/objetivos (${links.goals})` : null,
  links.kpis ? `KPI (${links.kpis})` : null,
  links.orders ? `pedidos (${links.orders})` : null,
  links.sales ? `vendas (${links.sales})` : null,
  links.contacts ? `contatos (${links.contacts})` : null,
  links.changeLogs ? `histórico de alterações de oportunidades (${links.changeLogs})` : null,
  links.territories ? `territórios comerciais (${links.territories})` : null,
  links.syncRuns ? `histórico de sincronização ERP (${links.syncRuns})` : null,
].filter(Boolean) as string[];

router.get("/users", authorize("diretor", "gerente"), async (req, res) => {
  const status = String(req.query.status || req.query.active || "active").toLowerCase();
  const where = status === "all" || status === "todos"
    ? {}
    : status === "inactive" || status === "inativos" || status === "false"
      ? { isActive: false }
      : { isActive: true };
  const users = await prisma.user.findMany({ where, select: userListSelect, orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  const safeUsers = users.map(sanitizeUserForList);
  const includeLinks = String(req.query.includeLinks || "").toLowerCase() === "true";
  if (includeLinks || status === "all" || status === "todos" || status === "inactive" || status === "inativos") {
    const links = await Promise.all(safeUsers.map(async (user) => ({ id: user.id, reasons: getUserBlockingReasons(await getUserBlockingLinks(user.id)) })));
    const byId = new Map(links.map((item) => [item.id, item.reasons]));
    return res.json(safeUsers.map((user) => ({ ...user, hasBlockingLinks: (byId.get(user.id)?.length ?? 0) > 0, blockingReasons: byId.get(user.id) ?? [] })));
  }
  return res.json(safeUsers);
});

router.get("/users/:id/erp-diagnostics", authorize("diretor", "gerente"), async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, name: true, email: true, role: true, erpCode: true, erpOperatorCode: true, erpRawPayload: true,
      erpLoginUsername: true, erpLoginPasswordEncrypted: true, erpLoginLastTestStatus: true, erpLoginLastTestAt: true,
      createdAt: true, isActive: true,
    },
  });
  if (!user) return res.status(404).json({ message: "Usuário não encontrado." });

  const normalizedCode = normalizeErpDiagCode(user.erpCode);
  const [salesmenCache, duplicateUsers] = await Promise.all([
    prisma.appConfig.findUnique({ where: { key: "erp.ultrafv3.salesmen" }, select: { value: true, updatedAt: true } }),
    normalizedCode
      ? prisma.user.findMany({
          where: { erpCode: { not: null } },
          select: { id: true, name: true, email: true, role: true, erpCode: true, erpOperatorCode: true, erpLoginUsername: true },
        })
      : Promise.resolve([]),
  ]);
  const salesmenRows = parseSalesmenCacheRows(salesmenCache?.value);
  const matchedRows = salesmenRows
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) => row as Record<string, unknown>)
    .filter((row) => normalizeErpDiagCode(pickDiagText(row, SALESMAN_DIAG_CODE_KEYS)) === normalizedCode);
  const primarySalesman = matchedRows[0] ?? null;
  const salesmenOperator = primarySalesman ? pickDiagText(primarySalesman, SALESMAN_DIAG_OPERATOR_KEYS) : "";
  const salesmenNumPedido = primarySalesman ? pickDiagText(primarySalesman, SALESMAN_DIAG_NUM_PEDIDO_KEYS) : "";
  const crmOperator = user.erpOperatorCode?.trim() || "";
  const resolvedOperator = salesmenOperator || crmOperator;
  const resolvedNumPedido = salesmenNumPedido || "";
  const duplicateUserMatches = duplicateUsers
    .filter((candidate) => candidate.id !== user.id && normalizeErpDiagCode(candidate.erpCode) === normalizedCode)
    .map((candidate) => ({
      id: candidate.id, name: candidate.name, email: candidate.email, role: candidate.role, erpCode: candidate.erpCode, erpOperatorCode: candidate.erpOperatorCode,
      erpLoginType: getMaskedLoginType(candidate.erpLoginUsername),
    }));
  const rawPayload = user.erpRawPayload && typeof user.erpRawPayload === "object" ? user.erpRawPayload as Record<string, unknown> : {};
  const rawLoginType = getMaskedLoginType(pickDiagText(rawPayload, SALESMAN_DIAG_LOGIN_KEYS));
  const erpLoginType = getMaskedLoginType(user.erpLoginUsername);
  const oldPessoaTypeConflictDetected = erpLoginType === "cpf" && rawLoginType === "cnpj";
  const alerts = [
    !user.erpCode ? "Usuário sem CODVENDEDOR CRM." : null,
    !crmOperator ? "Usuário sem OPERADOR CRM persistido." : null,
    !user.erpLoginUsername ? "Login FV3 ausente." : null,
    !user.erpLoginPasswordEncrypted ? "Senha ERP não configurada." : null,
    !primarySalesman ? "Vendedor não encontrado no cache /salesmen." : null,
    primarySalesman && !salesmenOperator ? "UltraFV3 não retornou OPERADOR para este vendedor; pedidos usarão o operador CRM quando válido." : null,
    duplicateUserMatches.length ? "Há outro usuário com o mesmo CODVENDEDOR." : null,
    oldPessoaTypeConflictDetected ? "Possível resíduo PJ/CNPJ no payload sincronizado enquanto o login atual parece CPF." : null,
  ].filter(Boolean);

  logApiEvent("INFO", "[erp seller diagnostics] generated", {
    userId: user.id, sellerName: user.name, sellerErpCode: user.erpCode, erpLoginType, crmOperator: crmOperator || null,
    salesmenOperator: salesmenOperator || null, salesmenNumPedido: salesmenNumPedido || null, resolvedOperator: resolvedOperator || null,
    resolvedNumPedido: resolvedNumPedido || null, matchedBy: primarySalesman ? "erpCode" : null, oldPessoaTypeConflictDetected,
  });

  return res.json({
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role, isActive: user.isActive, erpSellerCode: user.erpCode,
      erpOperatorCode: user.erpOperatorCode, erpLoginConfigured: Boolean(user.erpLoginUsername?.trim()), erpPasswordConfigured: Boolean(user.erpLoginPasswordEncrypted),
      erpLoginType, erpLoginLastTestStatus: user.erpLoginLastTestStatus, erpLoginLastTestAt: user.erpLoginLastTestAt, createdAt: user.createdAt,
    },
    salesmen: {
      cacheUpdatedAt: salesmenCache?.updatedAt ?? null, matchedCount: matchedRows.length, resultFound: Boolean(primarySalesman),
      operator: salesmenOperator || null, numPedido: salesmenNumPedido || null, raw: primarySalesman ? sanitizeErpRawPayload(primarySalesman) : null,
    },
    resolution: { crmOperator: crmOperator || null, salesmenOperator: salesmenOperator || null, salesmenNumPedido: salesmenNumPedido || null, resolvedOperator: resolvedOperator || null, resolvedNumPedido: resolvedNumPedido || null, matchedBy: primarySalesman ? "erpCode" : null },
    duplicates: { users: duplicateUserMatches, salesmenCount: matchedRows.length },
    oldPessoaTypeConflictDetected,
    alerts,
  });
});


router.get("/erp/ultrafv3/seller-diagnostics", authorize("diretor", "gerente"), async (req, res) => {
  const correlationId = randomUUID();
  const sellerCode = String(req.query.sellerCode || req.query.erpCode || "7057").trim();
  const operatorCode = String(req.query.operatorCode || req.query.operador || "45").trim();
  const search = String(req.query.search || "Jeferson Luiz Carlota").trim();
  const cpf = String(req.query.cpf || "").trim();
  const cnpj = String(req.query.cnpj || "").trim();
  const loginFV3 = String(req.query.loginFV3 || "").trim();
  const email = String(req.query.email || "").trim();
  const oldCnpj = String(req.query.oldCnpj || "").trim();
  const normalizedCpf = normalizeCnpj(cpf);
  const normalizedCnpj = normalizeCnpj(cnpj || oldCnpj);
  const textNeedles = [sellerCode, operatorCode, search, cpf, cnpj, oldCnpj, loginFV3, email]
    .map((value) => value.trim())
    .filter(Boolean);
  const normalizedNeedles = Array.from(new Set([
    ...textNeedles.map((value) => normalizeErpDiagCode(value)).filter(Boolean),
    normalizedCpf,
    normalizedCnpj,
  ].filter(Boolean)));
  const containsNeedle = (value: unknown): boolean => {
    if (value == null) return false;
    if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(containsNeedle);
    const text = String(value);
    const normalized = normalizeErpDiagCode(text);
    return normalizedNeedles.some((needle) => normalized.includes(needle) || text.toLowerCase().includes(needle.toLowerCase()));
  };
  const safeRows = (rows: unknown[], limit = 10) => rows.slice(0, limit).map((row) => sanitizeErpOrderPayload(row));

  logApiEvent("INFO", "[erp seller definitive diagnostics] request started", {
    correlationId,
    sellerCode,
    operatorCode,
    search,
    hasCpf: Boolean(cpf),
    hasCnpj: Boolean(cnpj || oldCnpj),
    hasLoginFV3: Boolean(loginFV3),
    hasEmail: Boolean(email),
  });

  const users = await prisma.user.findMany({
    where: {
      OR: [
        sellerCode ? { erpCode: sellerCode } : undefined,
        operatorCode ? { erpOperatorCode: operatorCode } : undefined,
        search ? { name: { contains: search, mode: "insensitive" } } : undefined,
        email ? { email: { contains: email, mode: "insensitive" } } : undefined,
        loginFV3 ? { erpLoginUsername: loginFV3 } : undefined,
        cpf ? { erpLoginUsername: cpf } : undefined,
        cnpj ? { erpLoginUsername: cnpj } : undefined,
        oldCnpj ? { erpLoginUsername: oldCnpj } : undefined,
      ].filter(Boolean) as Prisma.UserWhereInput[],
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      erpCode: true,
      erpOperatorCode: true,
      erpRawPayload: true,
      erpLoginUsername: true,
      erpLoginPasswordEncrypted: true,
      erpLoginLastTestStatus: true,
      erpLoginLastTestAt: true,
      createdAt: true,
      _count: { select: { clients: true, opportunities: true, erpOrderSyncs: true } },
    },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  const targetUser = users.find((user) => normalizeErpDiagCode(user.erpCode) === normalizeErpDiagCode(sellerCode)) ?? users[0] ?? null;

  const [salesmenCache, partnersCache, syncRuns, orderSyncs, clientsByTarget, documentClients] = await Promise.all([
    prisma.appConfig.findUnique({ where: { key: "erp.ultrafv3.salesmen" }, select: { value: true, updatedAt: true } }),
    prisma.appConfig.findUnique({ where: { key: "erp.ultrafv3.partners" }, select: { value: true, updatedAt: true } }),
    prisma.erpSyncRun.findMany({
      where: { OR: [
        targetUser ? { sellerId: targetUser.id } : undefined,
        sellerCode ? { sellerName: { contains: search || sellerCode, mode: "insensitive" } } : undefined,
        { scope: "partners", authMode: "seller" },
      ].filter(Boolean) as Prisma.ErpSyncRunWhereInput[] },
      orderBy: [{ startedAt: "desc" }],
      take: 25,
    }),
    prisma.erpOrderSync.findMany({
      where: targetUser ? { sellerId: targetUser.id } : {},
      orderBy: [{ createdAt: "desc" }],
      take: 10,
      select: { id: true, opportunityId: true, sellerId: true, pedidoIdImportacao: true, numPedido: true, erpOrderNumber: true, status: true, orderStatus: true, payloadSent: true, erpResponse: true, syncErrors: true, createdAt: true, updatedAt: true },
    }),
    targetUser ? prisma.client.findMany({
      where: { ownerSellerId: targetUser.id, isArchived: false },
      orderBy: [{ erpUpdatedAt: "desc" }, { createdAt: "desc" }],
      take: 20,
      select: { id: true, code: true, name: true, fantasyName: true, clientType: true, cnpj: true, cnpjNormalized: true, ownerSellerId: true, erpUpdatedAt: true, createdAt: true },
    }) : Promise.resolve([]),
    (normalizedCpf || normalizedCnpj) ? prisma.client.findMany({
      where: {
        isArchived: false,
        OR: [
          normalizedCpf ? { cnpjNormalized: normalizedCpf } : undefined,
          normalizedCnpj ? { cnpjNormalized: normalizedCnpj } : undefined,
        ].filter(Boolean) as Prisma.ClientWhereInput[]
      },
      orderBy: [{ erpUpdatedAt: "desc" }, { createdAt: "desc" }],
      take: 20,
      select: { id: true, code: true, name: true, fantasyName: true, clientType: true, cnpj: true, cnpjNormalized: true, ownerSellerId: true, erpUpdatedAt: true, createdAt: true },
    }) : Promise.resolve([]),
  ]);

  const salesmenRows = parseSalesmenCacheRows(salesmenCache?.value);
  const partnersRows = parseSalesmenCacheRows(partnersCache?.value);
  const salesmenMatches = salesmenRows.filter(containsNeedle);
  const partnerMatches = partnersRows.filter(containsNeedle);
  const primarySalesman = salesmenMatches.find((row) => row && typeof row === "object" && normalizeErpDiagCode(pickDiagText(row as Record<string, unknown>, SALESMAN_DIAG_CODE_KEYS)) === normalizeErpDiagCode(sellerCode)) as Record<string, unknown> | undefined;
  const salesmenOperator = primarySalesman ? pickDiagText(primarySalesman, SALESMAN_DIAG_OPERATOR_KEYS) : "";
  const salesmenNumPedido = primarySalesman ? pickDiagText(primarySalesman, SALESMAN_DIAG_NUM_PEDIDO_KEYS) : "";
  const crmOperator = targetUser?.erpOperatorCode?.trim() || "";

  let liveUltraFv3: Record<string, unknown> = { available: false, reason: "Usuário alvo sem Login FV3/Senha FV3 configurados." };
  if (targetUser?.erpLoginUsername?.trim() && targetUser.erpLoginPasswordEncrypted) {
    const credentials = { username: targetUser.erpLoginUsername.trim(), password: decryptErpCredential(targetUser.erpLoginPasswordEncrypted) };
    try {
      const auth = await ultraFv3Client.authenticateWithCredentials(credentials);
      const [partnersResult, salesmenResult] = await Promise.allSettled([
        ultraFv3Client.requestWithCredentials<unknown>("/partners", credentials, { correlationId, timeoutMs: ULTRAFV3_REQUEST_TIMEOUT_MS }),
        ultraFv3Client.requestWithCredentials<unknown>("/salesmen", credentials, { correlationId, timeoutMs: ULTRAFV3_REQUEST_TIMEOUT_MS }),
      ]);
      const livePartnersRows = partnersResult.status === "fulfilled" ? toDiagArray(partnersResult.value) : [];
      const liveSalesmenRows = salesmenResult.status === "fulfilled" ? toDiagArray(salesmenResult.value) : [];
      liveUltraFv3 = {
        available: true,
        auth: { tokenPayload: auth.tokenPayload, tokenExpiresAt: auth.tokenExpiresAt },
        partners: {
          ok: partnersResult.status === "fulfilled",
          count: livePartnersRows.length,
          error: partnersResult.status === "rejected" ? sanitizeErpOrderErrorMessage(partnersResult.reason?.message || String(partnersResult.reason)) : null,
          matches: safeRows(livePartnersRows.filter(containsNeedle), 10),
          receivedPayloadSummary: partnersResult.status === "fulfilled" ? { type: Array.isArray(partnersResult.value) ? "array" : typeof partnersResult.value, rootKeys: partnersResult.value && typeof partnersResult.value === "object" && !Array.isArray(partnersResult.value) ? Object.keys(partnersResult.value as Record<string, unknown>).slice(0, 20) : [] } : null,
        },
        salesmen: {
          ok: salesmenResult.status === "fulfilled",
          count: liveSalesmenRows.length,
          error: salesmenResult.status === "rejected" ? sanitizeErpOrderErrorMessage(salesmenResult.reason?.message || String(salesmenResult.reason)) : null,
          matches: safeRows(liveSalesmenRows.filter(containsNeedle), 10),
          receivedPayloadSummary: salesmenResult.status === "fulfilled" ? { type: Array.isArray(salesmenResult.value) ? "array" : typeof salesmenResult.value, rootKeys: salesmenResult.value && typeof salesmenResult.value === "object" && !Array.isArray(salesmenResult.value) ? Object.keys(salesmenResult.value as Record<string, unknown>).slice(0, 20) : [] } : null,
        },
      };
    } catch (error) {
      liveUltraFv3 = {
        available: false,
        error: sanitizeErpOrderErrorMessage(error instanceof Error ? error.message : String(error)),
        diagnostics: sanitizeErpOrderPayload((error as { diagnostics?: unknown })?.diagnostics ?? null),
      };
    }
  }

  const sanitizedUsers = users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    erpCode: user.erpCode,
    erpOperatorCode: user.erpOperatorCode,
    erpLoginConfigured: Boolean(user.erpLoginUsername?.trim()),
    erpLoginType: getMaskedLoginType(user.erpLoginUsername),
    erpPasswordConfigured: Boolean(user.erpLoginPasswordEncrypted),
    erpLoginLastTestStatus: user.erpLoginLastTestStatus,
    erpLoginLastTestAt: user.erpLoginLastTestAt,
    createdAt: user.createdAt,
    rawLoginType: user.erpRawPayload && typeof user.erpRawPayload === "object" ? getMaskedLoginType(pickDiagText(user.erpRawPayload as Record<string, unknown>, SALESMAN_DIAG_LOGIN_KEYS)) : "ausente",
    counts: user._count,
  }));
  const duplicateUsers = sanitizedUsers.filter((user) => user.id !== targetUser?.id && (
    normalizeErpDiagCode(user.erpCode) === normalizeErpDiagCode(sellerCode) ||
    normalizeErpDiagCode(user.erpOperatorCode) === normalizeErpDiagCode(operatorCode) ||
    (email && user.email.toLowerCase() === email.toLowerCase())
  ));
  const alerts = [
    !targetUser ? "Nenhum usuário CRM localizado para os filtros informados." : null,
    targetUser && normalizeErpDiagCode(targetUser.erpCode) !== normalizeErpDiagCode(sellerCode) ? "Usuário alvo não possui CODVENDEDOR esperado." : null,
    targetUser && crmOperator && operatorCode && normalizeErpDiagCode(crmOperator) !== normalizeErpDiagCode(operatorCode) ? "OPERADOR CRM diverge do OPERADOR informado." : null,
    primarySalesman && salesmenOperator && operatorCode && normalizeErpDiagCode(salesmenOperator) !== normalizeErpDiagCode(operatorCode) ? "OPERADOR do cache /salesmen diverge do OPERADOR informado." : null,
    duplicateUsers.length ? "Há duplicidade de usuário CRM por CODVENDEDOR/OPERADOR/e-mail." : null,
    salesmenMatches.length > 1 ? "Há múltiplos registros no cache /salesmen para os identificadores pesquisados." : null,
    partnerMatches.length > 1 ? "Há múltiplos registros no cache /partners para os identificadores pesquisados." : null,
    sanitizedUsers.some((user) => user.erpLoginType === "cpf" && user.rawLoginType === "cnpj") ? "Possível resíduo PJ/CNPJ em erpRawPayload com login FV3 atual CPF." : null,
  ].filter(Boolean);

  return res.status(200).json({
    correlationId,
    investigatedAt: new Date().toISOString(),
    filters: { sellerCode, operatorCode, search, hasCpf: Boolean(cpf), hasCnpj: Boolean(cnpj || oldCnpj), hasLoginFV3: Boolean(loginFV3), hasEmail: Boolean(email) },
    crm: {
      targetUserId: targetUser?.id ?? null,
      users: sanitizedUsers,
      duplicates: { users: duplicateUsers },
      clientsBySeller: clientsByTarget,
      clientsByDocument: documentClients,
      orderSyncs: orderSyncs.map((sync) => ({ ...sync, payloadSent: sanitizeErpOrderPayload(sync.payloadSent), erpResponse: sanitizeErpOrderPayload(sync.erpResponse), syncErrors: sanitizeErpOrderPayload(sync.syncErrors) })),
      syncRuns: syncRuns.map((run) => ({ id: run.id, scope: run.scope, status: run.status, sellerId: run.sellerId, sellerName: run.sellerName, authMode: run.authMode, correlationId: run.correlationId, startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: run.durationMs, syncedCount: run.syncedCount, metrics: run.metrics, errorMessage: run.errorMessage, errors: sanitizeErpOrderPayload(run.errors) })),
    },
    cache: {
      salesmen: { updatedAt: salesmenCache?.updatedAt ?? null, totalRows: salesmenRows.length, matchesCount: salesmenMatches.length, matches: safeRows(salesmenMatches, 10) },
      partners: { updatedAt: partnersCache?.updatedAt ?? null, totalRows: partnersRows.length, matchesCount: partnerMatches.length, matches: safeRows(partnerMatches, 10) },
      tokens: { exposed: false, note: "Tokens UltraFV3 ficam apenas no cache em memória por credencial e nunca são retornados por diagnóstico." },
    },
    flow: {
      individualPartnersSync: { path: "Login FV3 do vendedor -> POST /auth/login -> GET /partners", identifierUsed: targetUser?.erpLoginUsername ? "erpLoginUsername do usuário CRM (valor mascarado na UI)" : null, authMode: "seller", endpoint: "/partners" },
      allSellersSync: { path: "POST /erp/ultrafv3/sync/partners/all-sellers -> usuários ativos com Login FV3 -> syncPartnersByUser(user.id) -> GET /partners", lastRunsReturned: syncRuns.length },
      orderErp: { path: "Oportunidade -> ownerSeller -> autenticação FV3 do vendedor -> GET /salesmen para OPERADOR -> sequência CRM global NUM_PEDIDO -> POST /orders", sellerId: targetUser?.id ?? null, sellerErpCode: targetUser?.erpCode ?? null, erpOperatorCode: targetUser?.erpOperatorCode ?? null, loginFV3Type: targetUser ? getMaskedLoginType(targetUser.erpLoginUsername) : null, cpf: normalizedCpf ? "informado" : null, cnpj: normalizedCnpj ? "informado" : null, resolvedOperator: salesmenOperator || crmOperator || null, resolvedNumPedido: salesmenNumPedido || null },
    },
    ultraFv3: liveUltraFv3,
    divergences: alerts,
  });
});

router.post("/users", authorize("diretor", "gerente"), validateBody(userCreateSchema), async (req, res) => {
  const { name, email, password, role, region, erpCode, erpOperatorCode, erpLoginUsername, erpLoginPassword } = req.body;
  if (req.user!.role === "gerente" && role === "diretor") {
    return res.status(403).json({ success: false, message: "Gerentes não podem criar usuários diretores." });
  }
  const erpOption = await resolveErpSalesmanOption(erpCode);
  const passwordHash = await hashPassword(password);
  if (typeof erpLoginPassword === "string" && erpLoginPassword.trim() && !isErpCredentialEncryptionConfigured()) {
    return res.status(400).json({ success: false, message: "Configure ERP_CREDENTIAL_ENCRYPTION_KEY antes de salvar senha FV3." });
  }
  const erpLoginPasswordEncrypted = typeof erpLoginPassword === "string" && erpLoginPassword.trim()
    ? encryptErpCredential(erpLoginPassword)
    : null;
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role, region, erpCode: erpOption?.code ?? erpCode ?? null, erpOperatorCode: erpOperatorCode ?? erpOption?.erpOperatorCode ?? null, erpRawPayload: erpOption?.raw ? sanitizeErpRawPayload(erpOption.raw) as Prisma.InputJsonValue : undefined, erpLoginUsername: erpLoginUsername ?? null, erpLoginPasswordEncrypted },
    select: userListSelect
  });
  return res.status(201).json({ success: true, message: "Usuário criado com sucesso.", data: sanitizeUserForList(user) });
});
router.put("/users/:id", authorize("diretor", "gerente"), validateBody(userUpdateSchema), async (req, res) => {
  const { id } = req.params;
  const { name, email, password, role, region, erpCode, erpOperatorCode, erpLoginUsername, erpLoginPassword } = req.body;

  if (req.user!.id === id && role !== "diretor") {
    return res.status(400).json({ success: false, message: "Você não pode remover seu próprio papel de diretor." });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, erpCode: true, erpOperatorCode: true } });
    if (!user) return res.status(404).json({ success: false, message: "Usuário não encontrado." });
    if (req.user!.role === "gerente" && (user.role === "diretor" || role === "diretor")) {
      return res.status(403).json({ success: false, message: "Gerentes não podem criar ou editar perfis diretores." });
    }

    const hasCrmPasswordChange = typeof password === "string" && password.trim().length > 0;
    const hasErpPasswordChange = typeof erpLoginPassword === "string" && erpLoginPassword.trim().length > 0;

    logApiEvent("INFO", "[users:update] start", buildUserUpdateLogMeta({
      targetUserId: id,
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      role,
      erpCode,
      erpOperatorCode,
      erpLoginUsername,
      hasCrmPasswordChange,
      hasErpPasswordChange
    }));

    if (hasErpPasswordChange && !isErpCredentialEncryptionConfigured()) {
      logApiEvent("WARN", "[users:update] ERP credential encryption key missing", { targetUserId: id, actorUserId: req.user!.id });
      return res.status(400).json({ success: false, message: "Configure ERP_CREDENTIAL_ENCRYPTION_KEY antes de salvar senha FV3." });
    }

    const erpOption = await resolveErpSalesmanOption(erpCode);
    const resolvedErpCode = erpCode ? erpOption?.code ?? erpCode : null;
    const shouldPreserveExistingOperator = Boolean(
      resolvedErpCode &&
      user.erpCode === resolvedErpCode &&
      user.erpOperatorCode?.trim() &&
      !erpOption?.erpOperatorCode &&
      !erpOperatorCode
    );
    const resolvedErpOperatorCode = resolvedErpCode
      ? erpOperatorCode ?? erpOption?.erpOperatorCode ?? (shouldPreserveExistingOperator ? user.erpOperatorCode : null)
      : null;
    const data: Record<string, unknown> = {
      name,
      email,
      role,
      region,
      erpCode: resolvedErpCode,
      erpOperatorCode: resolvedErpOperatorCode,
      erpRawPayload: resolvedErpCode && erpOption?.raw ? sanitizeErpRawPayload(erpOption.raw) as Prisma.InputJsonValue : Prisma.JsonNull,
      erpLoginUsername: erpLoginUsername ?? null
    };

    if (hasCrmPasswordChange) {
      data.passwordHash = await hashPassword(password);
    }

    if (hasErpPasswordChange) {
      data.erpLoginPasswordEncrypted = encryptErpCredential(erpLoginPassword);
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: userListSelect
    });

    logApiEvent("INFO", "[users:update] success", { targetUserId: id, actorUserId: req.user!.id, erpCode: updated.erpCode, erpOperatorCode: updated.erpOperatorCode, erpLoginConfigured: Boolean(updated.erpLoginUsername?.trim() && updated.erpLoginPasswordEncrypted) });

    return res.json({ success: true, message: "Usuário atualizado com sucesso.", data: sanitizeUserForList(updated) });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(409).json({ success: false, message: "Já existe outro usuário com este e-mail corporativo." });
    }

    const message = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[users:update] failed", { targetUserId: id, actorUserId: req.user?.id, error: message });
    return res.status(500).json({ success: false, message: "Não foi possível atualizar o usuário.", details: message });
  }
});
router.patch("/users/:id/region", authorize("diretor", "gerente"), async (req, res) => res.json(await prisma.user.update({ where: { id: req.params.id }, data: { region: req.body.region } })));
router.patch("/users/:id/active", authorize("diretor", "gerente"), validateBody(userActivationSchema), async (req, res) => {
  if (req.user!.id === req.params.id && !req.body.isActive) {
    return res.status(400).json({ message: "Você não pode desativar seu próprio usuário" });
  }

  const targetUser = await prisma.user.findUnique({ where: { id: req.params.id }, select: { role: true } });
  if (!targetUser) return res.status(404).json({ message: "Usuário não encontrado." });
  if (req.user!.role === "gerente" && targetUser.role === "diretor") {
    return res.status(403).json({ message: "Gerentes não podem alterar o status de diretores." });
  }

  const updatedUser = await prisma.user.update({
    where: { id: req.params.id },
    data: { isActive: req.body.isActive },
    select: { id: true, name: true, role: true, isActive: true }
  });

  return res.json(updatedUser);
});
router.patch("/users/:id/role", authorize("diretor"), validateBody(userRoleUpdateSchema), async (req, res) => {
  if (req.user!.id === req.params.id && req.body.role !== "diretor") {
    return res.status(400).json({ message: "Você não pode remover seu próprio papel de diretor" });
  }

  const updatedUser = await prisma.user.update({
    where: { id: req.params.id },
    data: { role: req.body.role },
    select: { id: true, name: true, role: true, isActive: true }
  });

  return res.json(updatedUser);
});
router.get("/users/:id/delete-diagnostics", authorize("diretor", "gerente"), async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, email: true, role: true, isActive: true, erpCode: true, erpOperatorCode: true }
  });
  if (!user) return res.status(404).json({ success: false, message: "Usuário não encontrado." });

  const links = await getUserBlockingLinks(user.id);
  const blockingReasons = getUserBlockingReasons(links);

  return res.json({
    success: true,
    user,
    canDelete: blockingReasons.length === 0,
    recommendation: blockingReasons.length === 0 ? "delete" : "deactivate",
    message: blockingReasons.length === 0
      ? "Usuário sem vínculos relevantes. A exclusão física pode ser realizada."
      : `Usuário possui vínculo(s) em: ${blockingReasons.join(", ")}. Recomenda-se desativar para preservar o histórico comercial.`,
    links,
    blockingReasons
  });
});

router.post("/users/:id/reset-password", authorize("diretor"), validateBody(userResetPasswordSchema), async (req, res) => {
  const temporaryPasswordLength = req.body.temporaryPasswordLength ?? 12;
  const temporaryPassword = randomBytes(temporaryPasswordLength).toString("base64url").slice(0, temporaryPasswordLength);
  const passwordHash = await hashPassword(temporaryPassword);

  const updatedUser = await prisma.user.update({
    where: { id: req.params.id },
    data: { passwordHash },
    select: { id: true, name: true, email: true }
  });

  return res.json({
    message: "Senha resetada com sucesso",
    user: updatedUser,
    temporaryPassword
  });
});
router.delete("/users/:id", authorize("diretor"), async (req, res) => {
  const { id } = req.params;

  if (req.user!.id === id) {
    return res.status(400).json({ success: false, message: "Você não pode excluir seu próprio usuário." });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "Usuário não encontrado." });
    }

    if (user.role === "diretor") {
      const directorsCount = await prisma.user.count({ where: { role: "diretor", isActive: true } });
      if (directorsCount <= 1) {
        return res.status(400).json({ success: false, message: "Não é possível excluir o último diretor ativo." });
      }
    }

    if (user.role === "gerente") {
      const managersCount = await prisma.user.count({ where: { role: "gerente", isActive: true } });
      if (managersCount <= 1) {
        return res.status(400).json({ success: false, message: "Não é possível excluir o último gerente ativo." });
      }
    }

    await prisma.goal.deleteMany({ where: { sellerId: id, targetValue: { lte: 0 } } });

    const blockingReasons = getUserBlockingReasons(await getUserBlockingLinks(id));
    if (blockingReasons.length > 0) {
      return res.status(409).json({
        success: false,
        message: `Não é possível excluir este usuário porque há vínculo(s) em: ${blockingReasons.join(", ")}. Desative o usuário para preservar o histórico comercial.`,
        blockingReasons
      });
    }

    await prisma.user.delete({ where: { id } });
    return res.json({ success: true, message: "Usuário excluído com sucesso." });
  } catch (error: any) {
    if (error?.code === "P2003") {
      return res.status(409).json({ success: false, message: "Não é possível excluir este usuário porque existem vínculos em outros registros. Desative o usuário para preservar o histórico comercial." });
    }

    console.error("[users:delete]", error);
    return res.status(500).json({ success: false, message: error?.message ? `Não foi possível excluir o usuário: ${error.message}` : "Não foi possível excluir o usuário." });
  }
});


const listCulturesHandler = async (req: express.Request, res: express.Response) => {
  const parsedQuery = cultureQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ message: parsedQuery.error.issues[0]?.message || "Parâmetros inválidos." });
  }

  const { active, search, tags, category, page = 1, pageSize = 20 } = parsedQuery.data;
  const where: Prisma.CultureCatalogWhereInput = {
    ...(active ? { isActive: active === "true" } : {}),
    ...(category ? { category: { equals: category, mode: "insensitive" } } : {}),
    ...(search
      ? {
          OR: [
            { label: { contains: search, mode: "insensitive" } },
            { slug: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(tags
      ? {
          tags: {
            hasSome: tags.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.cultureCatalog.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { label: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.cultureCatalog.count({ where }),
  ]);

  return res.status(200).json({ data: items, total, page, pageSize });
};

router.get("/cultures", listCulturesHandler);
router.get("/technical/cultures", listCulturesHandler);
router.get("/technical-cultures", async (_req, res) => {
  try {
    const dbCultures = await prisma.cultureCatalog.findMany({
      where: { isActive: true },
      orderBy: [{ label: "asc" }],
      select: {
        slug: true,
        label: true,
        category: true,
        defaultKgHaMin: true,
        defaultKgHaMax: true,
        pmsDefault: true,
        populationTargetDefault: true,
        rowSpacingCmDefault: true,
        germinationDefault: true,
        purityDefault: true,
        notes: true,
      },
    });

    if (!dbCultures.length) {
      return res.status(200).json({ items: TECHNICAL_CULTURES_STATIC_SEED, source: "seed" });
    }

    return res.status(200).json({ items: dbCultures.map(serializeTechnicalCultureCatalogItem), source: "db" });
  } catch (error) {
    console.error("[technical-cultures] Falha ao carregar do banco. Usando catálogo static.", error);
    return res.status(200).json({ items: TECHNICAL_CULTURES_STATIC_SEED, source: "static" });
  }
});

router.post("/cultures", authorize("diretor", "gerente"), validateBody(cultureCatalogSchema), async (req, res, next) => {
  try {
    const payload = normalizeCulturePayload(req.body);
    const created = await prisma.cultureCatalog.create({ data: payload });
    res.status(201).json(created);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return res.status(409).json({ message: "Slug já cadastrado." });
    }
    next(error);
  }
});

router.put("/cultures/:id", authorize("diretor", "gerente"), validateBody(cultureCatalogSchema), async (req, res, next) => {
  try {
    const payload = normalizeCulturePayload(req.body);
    const updated = await prisma.cultureCatalog.update({ where: { id: req.params.id }, data: payload });
    res.status(200).json(updated);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return res.status(409).json({ message: "Slug já cadastrado." });
    }
    if ((error as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Cultura não encontrada." });
    }
    next(error);
  }
});

router.delete("/cultures/:id", authorize("diretor", "gerente"), async (req, res, next) => {
  try {
    const updated = await prisma.cultureCatalog.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.status(200).json(updated);
  } catch (error) {
    if ((error as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Cultura não encontrada." });
    }
    next(error);
  }
});


router.post("/technical/cultures", authorize("diretor", "gerente"), validateBody(cultureCatalogSchema), async (req, res, next) => {
  try {
    const payload = normalizeCulturePayload(req.body);
    const created = await prisma.cultureCatalog.create({ data: payload });
    res.status(201).json(created);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return res.status(409).json({ message: "Slug já cadastrado." });
    }
    next(error);
  }
});

router.put("/technical/cultures/:id", authorize("diretor", "gerente"), validateBody(cultureCatalogSchema), async (req, res, next) => {
  try {
    const payload = normalizeCulturePayload(req.body);
    const updated = await prisma.cultureCatalog.update({ where: { id: req.params.id }, data: payload });
    res.status(200).json(updated);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return res.status(409).json({ message: "Slug já cadastrado." });
    }
    if ((error as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Cultura não encontrada." });
    }
    next(error);
  }
});

router.delete("/technical/cultures/:id", authorize("diretor", "gerente"), async (req, res, next) => {
  try {
    const updated = await prisma.cultureCatalog.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.status(200).json(updated);
  } catch (error) {
    if ((error as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Cultura não encontrada." });
    }
    next(error);
  }
});

export default router;
