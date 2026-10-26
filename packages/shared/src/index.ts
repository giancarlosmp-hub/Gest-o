import { z } from "zod";

export * from "./portfolioStatus.js";
export * from "./abcCurve.js";
export * from "./rankingSellers.js";
export * from "./clientCollection.js";
export * from "./agendaDiscipline.js";
export * from "./agendaNotDoneReasons.js";
export * from "./proposalNoResponse.js";

/** The browser-facing route. Reverse proxies may forward it with or without
 * `/api`; the API registers both forms, but callers must only use this value. */
export const PLATFORM_HEALTH_API_PATH = "/platform-health" as const;
export const PLATFORM_HEALTH_CONTRACT_VERSION = "3.0" as const;

const nullableMetricSchema = z.number().finite().nonnegative().nullable();
const dataStateSchema = z.enum(["available", "empty", "partial"]);
const safeRunSchema = z.object({
  runKind: z.enum(["parent", "stage"]),
  scope: z.string(),
  trigger: z.enum(["manual", "scheduler"]),
  status: z.enum(["running", "success", "error", "skipped"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: nullableMetricSchema,
  syncedCount: nullableMetricSchema,
}).strict();

/** Strict at the security boundary and permissive only for named metric maps,
 * whose keys evolve independently as ERP instrumentation is added. */
export const platformHealthSnapshotSchema = z.object({
  contractVersion: z.literal(PLATFORM_HEALTH_CONTRACT_VERSION),
  dataState: dataStateSchema,
  generatedAt: z.string().datetime(),
  cacheTtlSeconds: z.number().int().positive(),
  periodDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  cacheHit: z.boolean(),
  overview: z.object({
    dataState: dataStateSchema,
    lastSync: safeRunSchema.nullable(),
    lastManualSync: safeRunSchema.nullable(),
    lastAutomaticSync: safeRunSchema.nullable(),
    lastAutomaticSuccess: safeRunSchema.nullable(),
    averageDurationMs: nullableMetricSchema,
    metrics: z.record(nullableMetricSchema),
  }).strict(),
  quality: z.object({ dataState: dataStateSchema }).catchall(nullableMetricSchema),
  integration: z.object({
    dataState: dataStateSchema,
    connected: z.boolean().nullable(),
    latencyMs: nullableMetricSchema,
    averageDurationMs: nullableMetricSchema,
    successRate: z.number().min(0).max(1).nullable(),
    errorRate: z.number().min(0).max(1).nullable(),
    retries: nullableMetricSchema,
    recentRuns: z.array(safeRunSchema),
    scheduler: z.object({ initialized: z.boolean(), enabled: z.boolean(), enabledByEnv: z.boolean(), nextRunAt: z.string().datetime().nullable(), status: z.string(), lastRunAt: z.string().datetime().nullable(), lastSuccessAt: z.string().datetime().nullable() }).strict(),
    reachability: z.object({ dataState: z.enum(["available", "empty"]), status: z.enum(["available", "unavailable", "unknown"]), reason: z.enum(["ok", "auth", "timeout", "connect", "5xx"]).nullable(), endpointClass: z.literal("ultrafv3_read_only"), durationMs: nullableMetricSchema, checkedAt: z.string().datetime().nullable() }).strict(),
    automaticEvidence: z.object({ schedulerState: z.enum(["not_initialized", "disabled", "enabled"]), automaticRunState: z.string(), automaticProven: z.boolean(), lock: z.object({ state: z.enum(["active", "expired_recoverable", "free"]), lock: z.object({ scope: z.string(), lockedUntil: z.string().datetime(), updatedAt: z.string().datetime() }).strict().nullable() }).strict() }).strict(),
    lock: z.object({ state: z.enum(["active", "expired_recoverable", "free"]), lock: z.object({ scope: z.string(), lockedUntil: z.string().datetime(), updatedAt: z.string().datetime() }).strict().nullable() }).strict(),
  }).strict(),
  trends: z.object({ clientCodeChanges: z.array(z.object({ date: z.string(), value: z.number().nonnegative() }).strict()), syncDuration: z.array(z.object({ date: z.string(), value: z.number().nonnegative() }).strict()) }).strict(),
  alerts: z.array(z.object({ id: z.string(), severity: z.enum(["healthy", "warning", "critical"]), title: z.string(), detail: z.string(), metric: z.string(), value: z.number() }).strict()),
  notifications: z.object({ providers: z.array(z.string()), status: z.literal("not_instrumented") }).strict(),
}).strict();
export type PlatformHealthSnapshot = z.infer<typeof platformHealthSnapshotSchema>;

const INVALID_ROLE_MESSAGE = "Papel inválido. Use diretor, gerente ou vendedor.";
const roleValues = ["diretor", "gerente", "vendedor"] as const;

export const RoleEnum = z.enum(roleValues);
export const roleSchema = z
  .string()
  .refine((value): value is Role => roleValues.includes(value as Role), { message: INVALID_ROLE_MESSAGE });
export type Role = z.infer<typeof RoleEnum>;

export const OpportunityStageEnum = z.enum([
  "prospeccao",
  "negociacao",
  "proposta",
  "ganho",
  "perdido"
]);

export const ActivityTypeEnum = z.enum(["ligacao", "whatsapp", "visita", "reuniao", "followup", "proposta_enviada", "proposta_negociacao", "fechamento", "envio_proposta", "visita_tecnica", "cliente_novo", "follow_up", "reuniao_online", "reuniao_presencial"]);
export const EventTypeEnum = z.enum(["comentario", "mudanca_etapa", "status"]);
// followup é legado: só aparece em compromissos antigos e não é aceito em compromisso novo.
export const AgendaEventTypeEnum = z.enum(["ligacao", "whatsapp", "visita", "reuniao_online", "reuniao_presencial", "proposta", "fechamento", "roteiro_visita", "followup"]);
export type AgendaEventType = z.infer<typeof AgendaEventTypeEnum>;

// Catálogo único de compromissos (Agenda) e de próximo passo. roteiro_visita é o roteiro de várias visitas.
export const AgendaCatalogTypeEnum = z.enum(["ligacao", "whatsapp", "visita", "reuniao_online", "reuniao_presencial", "proposta", "fechamento"]);
export type AgendaCatalogType = z.infer<typeof AgendaCatalogTypeEnum>;
export const AgendaEventCreateTypeEnum = z.enum([...AgendaCatalogTypeEnum.options, "roteiro_visita"]);

// Opções de criação; o rótulo de tipos legados fica em AGENDA_EVENT_TYPE_LABELS.
export const AGENDA_EVENT_TYPE_OPTIONS = [
  { id: "CALL", value: "ligacao", label: "Ligação" },
  { id: "WHATSAPP", value: "whatsapp", label: "WhatsApp" },
  { id: "VISIT", value: "visita", label: "Visita" },
  { id: "ONLINE_MEETING", value: "reuniao_online", label: "Reunião online" },
  { id: "IN_PERSON_MEETING", value: "reuniao_presencial", label: "Reunião presencial" },
  { id: "PROPOSAL", value: "proposta", label: "Proposta" },
  { id: "CLOSING", value: "fechamento", label: "Fechamento" },
  { id: "VISIT_ROUTE", value: "roteiro_visita", label: "Roteiro de visita" }
] as const;

export const AGENDA_EVENT_TYPE_LABELS: Record<AgendaEventType, string> = {
  ...(Object.fromEntries(AGENDA_EVENT_TYPE_OPTIONS.map((option) => [option.value, option.label])) as Record<Exclude<AgendaEventType, "followup">, string>),
  followup: "Follow-up"
};

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

export const ClientTypeEnum = z.enum(["PJ", "PF"]);

export const clientSchema = z.object({
  name: z.string().min(2),
  fantasyName: z.string().min(2).optional(),
  code: z.string().min(1).optional(),
  city: z.string().min(2),
  state: z.string().min(2),
  region: z.string().min(2),
  potentialHa: z.number().nonnegative().optional(),
  farmSizeHa: z.number().nonnegative().optional(),
  clientType: ClientTypeEnum.optional(),
  cnpj: z.string().optional(),
  segment: z.string().min(2).optional(),
  ownerSellerId: z.string().optional()
});


export const companySchema = z.object({
  name: z.string().min(2),
  cnpj: z.string().optional(),
  segment: z.string().min(2).optional(),
  ownerSellerId: z.string().optional()
});

export const contactSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(8),
  email: z.string().email(),
  clientId: z.string(),
  ownerSellerId: z.string().optional()
});

export const clientContactSchema = z.object({
  name: z.string().min(2),
  role: z.string().min(2).optional(),
  department: z.string().min(2).optional(),
  phone: z.string().min(8),
  email: z.string().email(),
  isPrimary: z.boolean().optional(),
  notes: z.string().max(2000).optional()
});

export const opportunitySchema = z.object({
  title: z.string().min(2),
  value: z.number().nonnegative(),
  stage: OpportunityStageEnum,
  crop: z.string().min(2).optional(),
  season: z.string().min(2).optional(),
  areaHa: z.number().nonnegative().optional(),
  productOffered: z.string().min(2).optional(),
  plantingForecastDate: z.string().optional(),
  expectedTicketPerHa: z.number().nonnegative().optional(),
  proposalEntryDate: z.string().optional(),
  expectedReturnDate: z.string().optional(),
  proposalDate: z.string(),
  followUpDate: z.string(),
  expectedCloseDate: z.string(),
  lastContactAt: z.string().optional(),
  probability: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(2000).optional(),
  priceTableCode: z.string().trim().min(1).max(60).optional(),
  clientId: z.string(),
  ownerSellerId: z.string().optional()
});

export const activitySchema = z.object({
  type: ActivityTypeEnum,
  notes: z.string().min(2).optional(),
  description: z.string().min(2).optional(),
  result: z.string().min(1).optional(),
  dueDate: z.string().optional(),
  date: z.string().optional(),
  duration: z.number().int().nonnegative().optional(),
  city: z.string().min(2).optional(),
  crop: z.string().min(2).optional(),
  areaEstimated: z.number().nonnegative().optional(),
  product: z.string().min(2).optional(),
  done: z.boolean().optional(),
  opportunityId: z.string().optional(),
  clientId: z.string().optional(),
  agendaEventId: z.string().optional(),
  checkInAt: z.string().optional(),
  checkInLat: z.number().finite().optional(),
  checkInLng: z.number().finite().optional(),
  checkInAccuracy: z.number().nonnegative().optional(),
  ownerId: z.string().optional(),
  ownerSellerId: z.string().optional(),
  // Próximo passo vira compromisso na Agenda, com cliente e oportunidade da atividade.
  nextStep: z
    .object({
      type: AgendaCatalogTypeEnum,
      startsAt: z.string(),
      endsAt: z.string().optional(),
      title: z.string().trim().min(2).max(200).optional(),
      notes: z.string().max(2000).optional()
    })
    .optional(),
  noNextStepReason: z.string().trim().min(2).max(500).optional()
});

export const timelineEventSchema = z.object({
  type: EventTypeEnum.default("comentario"),
  description: z.string().min(2),
  clientId: z.string().optional(),
  opportunityId: z.string().optional(),
  ownerSellerId: z.string().optional()
});

export const eventSchema = z.object({
  type: z.literal("comentario").default("comentario"),
  description: z.string().min(2),
  opportunityId: z.string(),
  ownerSellerId: z.string().optional()
});

export const goalSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  targetValue: z.number().positive(),
  sellerId: z.string()
});

export const objectiveUpsertSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  amount: z.number().nonnegative()
});


export const activityKpiUpsertSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  type: z.string().min(1),
  targetValue: z.number().int().nonnegative()
});


export const userActivationSchema = z.object({
  isActive: z.boolean()
});

export const userRoleUpdateSchema = z.object({
  role: roleSchema
});


const optionalErpLinkCodeSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional().nullable()
);

const optionalErpLoginUsernameSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(3).max(80).optional().nullable()
);

const optionalErpLoginPasswordSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(256).optional().nullable()
);

export const userCreateSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  role: roleSchema,
  region: z.string().min(2).optional(),
  erpCode: optionalErpLinkCodeSchema,
  erpOperatorCode: optionalErpLinkCodeSchema,
  erpRawPayload: z.unknown().optional().nullable(),
  erpLoginUsername: optionalErpLoginUsernameSchema,
  erpLoginPassword: optionalErpLoginPasswordSchema
});

export const userUpdateSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6).optional(),
  role: roleSchema,
  region: z.string().min(2).optional(),
  erpCode: optionalErpLinkCodeSchema,
  erpOperatorCode: optionalErpLinkCodeSchema,
  erpRawPayload: z.unknown().optional().nullable(),
  erpLoginUsername: optionalErpLoginUsernameSchema,
  erpLoginPassword: optionalErpLoginPasswordSchema
});

export const userResetPasswordSchema = z.object({
  temporaryPasswordLength: z.number().int().min(8).max(32).optional()
});

export const weeklyVisitMinimumSchema = z.object({
  minimumWeeklyVisits: z.number().int().min(1).max(200)
});

// Raio (km em linha reta) do agrupamento de visitas do planejamento semanal.
export const planningVisitRadiusSchema = z.object({
  radiusKm: z.number().int().min(10).max(300)
});


// Etapas abertas do funil em que a automação pode criar a oportunidade de reativação.
export const INACTIVE_CLIENT_WORKFLOW_STAGES = ["prospeccao", "negociacao", "proposta"] as const;

export const inactiveClientWorkflowConfigSchema = z.object({
  enabled: z.boolean(),
  daysWithoutPurchase: z.number().int().positive(),
  allowedOptions: z.array(z.number().int().positive()).min(1),
  customDaysEnabled: z.boolean(),
  returnDeadlineBusinessDays: z.number().int().min(1, "Prazo de retorno deve ser de 1 ou 2 dias úteis.").max(2, "Prazo de retorno deve ser de 1 ou 2 dias úteis."),
  initialOpportunityStage: z.enum(INACTIVE_CLIENT_WORKFLOW_STAGES, {
    errorMap: () => ({ message: "Etapa inicial inválida. Use prospeccao, negociacao ou proposta." })
  }),
  dailyLimitPerSeller: z.number().int().min(1, "Teto diário deve ser de 1 a 50 por vendedor.").max(50, "Teto diário deve ser de 1 a 50 por vendedor.").default(5),
  createOpportunity: z.boolean(),
  createActivity: z.boolean(),
  createTimelineEvent: z.boolean()
}).superRefine((value, ctx) => {
  if (!value.customDaysEnabled && !value.allowedOptions.includes(value.daysWithoutPurchase)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["daysWithoutPurchase"],
      message: "Selecione uma das opções permitidas ou habilite dias customizados."
    });
  }
});

export const commercialAutomationsConfigSchema = z.object({
  inactiveClientWorkflow: inactiveClientWorkflowConfigSchema
});


const cultureGoalRangeSchema = z.object({
  min: z.number().nonnegative(),
  max: z.number().nonnegative()
}).refine((value) => value.max >= value.min, { message: "Faixa por objetivo inválida." });

export const cultureCatalogSchema = z.object({
  slug: z.string().min(2, "Slug é obrigatório.").regex(/^[a-z0-9-]+$/, "Slug deve conter apenas letras minúsculas, números e hífen."),
  label: z.string().min(2, "Nome da cultura é obrigatório."),
  category: z.string().min(2, "Categoria é obrigatória.").default("Outras"),
  isActive: z.boolean().optional(),
  defaultKgHaMin: z.number().nonnegative().optional().nullable(),
  defaultKgHaMax: z.number().nonnegative().optional().nullable(),
  goalsJson: z.record(cultureGoalRangeSchema).default({}),
  notes: z.string().max(2000).optional().nullable(),
  pmsDefault: z.number().positive().optional().nullable(),
  germinationDefault: z.number().positive().max(100).optional().nullable(),
  purityDefault: z.number().positive().max(100).optional().nullable(),
  populationTargetDefault: z.number().positive().optional().nullable(),
  rowSpacingCmDefault: z.number().positive().optional().nullable(),
  tags: z.array(z.string().min(1)).max(20).optional().default([])
});

export const dashboardPerformanceSchema = z.object({
  sellerId: z.string(),
  seller: z.string(),
  sales: z.number(),
  revenue: z.number(),
  objective: z.number(),
  realizedPercent: z.number()
});

export const dashboardSummarySchema = z.object({
  totalRevenue: z.number(),
  totalSales: z.number(),
  newLeads: z.number(),
  conversionRate: z.number(),
  counts: z.object({
    open: z.number(),
    won: z.number(),
    lost: z.number()
  }),
  totals: z.object({
    openValue: z.number(),
    wonValue: z.number(),
    lostValue: z.number()
  }),
  objectiveTotal: z.number(),
  performance: z.array(dashboardPerformanceSchema),
  recentActivities: z.array(z.unknown())
});

export const dashboardSalesSeriesSchema = z.object({
  labels: z.array(z.string()),
  realizedDaily: z.array(z.number()),
  realizedAccumulated: z.array(z.number()),
  objectiveDaily: z.array(z.number()),
  objectiveAccumulated: z.array(z.number()),
  objectiveTotal: z.number(),
  realizedTotal: z.number()
});

export const dashboardPortfolioSchema = z.object({
  walletStatus: z.object({
    ativo: z.number(),
    inativoRecente: z.number(),
    exCliente: z.number(),
    prospect: z.number()
  }),
  abcCurve: z.object({
    A: z.object({ clients: z.number(), percentRevenue: z.number() }),
    B: z.object({ clients: z.number(), percentRevenue: z.number() }),
    C: z.object({ clients: z.number(), percentRevenue: z.number() })
  }),
  totalClients: z.number(),
  soldToday: z.number()
});

export const weeklyHighlightItemSchema = z.object({
  sellerId: z.string(),
  sellerName: z.string(),
  metricLabel: z.string(),
  metricValue: z.number(),
  medal: z.string(),
  avatarUrl: z.string().nullable().optional()
});

export const weeklyHighlightsSchema = z.object({
  bestResult: weeklyHighlightItemSchema.nullable(),
  bestEvolution: weeklyHighlightItemSchema.nullable(),
  bestExecutor: weeklyHighlightItemSchema.nullable(),
  bestConversion: weeklyHighlightItemSchema.nullable()
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ClientInput = z.infer<typeof clientSchema>;
export type CompanyInput = z.infer<typeof companySchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type ClientContactInput = z.infer<typeof clientContactSchema>;
export type OpportunityInput = z.infer<typeof opportunitySchema>;
export type ActivityInput = z.infer<typeof activitySchema>;
export type GoalInput = z.infer<typeof goalSchema>;
export type ObjectiveUpsertInput = z.infer<typeof objectiveUpsertSchema>;
export type ActivityKpiUpsertInput = z.infer<typeof activityKpiUpsertSchema>;
export type UserActivationInput = z.infer<typeof userActivationSchema>;
export type UserRoleUpdateInput = z.infer<typeof userRoleUpdateSchema>;
export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;
export type UserResetPasswordInput = z.infer<typeof userResetPasswordSchema>;
export type WeeklyVisitMinimumInput = z.infer<typeof weeklyVisitMinimumSchema>;
export type CommercialAutomationsConfig = z.infer<typeof commercialAutomationsConfigSchema>;
// Motivos pelos quais um inativo recente fica fora da automação no dia.
export type InactiveClientWorkflowSkips = { inactiveSeller: number; openOpportunity: number; recentAutomation: number; dailyLimit: number };
// Simulação somente leitura: o que a automação criaria hoje (dia de Brasília) com a configuração salva.
export type CommercialAutomationsSimulation = {
  enabled: boolean;
  configIssues: string[];
  dayKey: string;
  dailyLimitPerSeller: number;
  inactiveRecentClients: number;
  eligibleClients: number;
  wouldCreate: number;
  skipped: InactiveClientWorkflowSkips;
  // Inativos recentes em cobrança: ficam fora da automação, antes dos demais motivos (não entram em elegíveis).
  inCollection: number;
};
export type TimelineEventInput = z.infer<typeof timelineEventSchema>;
export type EventInput = z.infer<typeof eventSchema>;
export type CultureCatalogInput = z.infer<typeof cultureCatalogSchema>;
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
export type DashboardSalesSeries = z.infer<typeof dashboardSalesSeriesSchema>;
export type DashboardPortfolio = z.infer<typeof dashboardPortfolioSchema>;
export type WeeklyHighlightItem = z.infer<typeof weeklyHighlightItemSchema>;
export type WeeklyHighlights = z.infer<typeof weeklyHighlightsSchema>;

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  region?: string | null;
}

export type ErpOrderParameterValue = string | number | {
  code?: unknown;
  value?: unknown;
  label?: unknown;
  [key: string]: unknown;
};

const ERP_PARAMETER_CODE_KEYS = ["code", "codigo", "CODIGO", "value", "id", "ID", "FORMA", "CODCONDREC", "TABELA", "CODTABELA", "TABELA_PRECO", "CODFILIAL", "CODOPER", "label", "name"] as const;

export const normalizeErpParameterCode = (value: unknown): string => {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return trimmed.split("·", 1)[0]?.trim() || "";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";

  const record = value as Record<string, unknown>;
  for (const key of ERP_PARAMETER_CODE_KEYS) {
    const normalized = normalizeErpParameterCode(record[key]);
    if (normalized) return normalized;
  }
  return "";
};

export type ErpOrderAttemptForOpenError = {
  opportunityId: string;
  status: string;
  createdAt: Date | string;
  hasManualResolution: boolean;
};

/** Oportunidades com pedido ERP em erro em aberto: tentativa `error` sem resolução manual e sem
 * tentativa `sent` criada depois dela na mesma oportunidade. Conta oportunidades, não tentativas:
 * duas recusas do mesmo pedido são um pedido parado. Oportunidade com erro e nenhum `sent` conta
 * sempre, para não esconder pedido travado. Regra única para a Integração ERP, a Saúde e o
 * healthcheck. */
export const findOpenErpOrderErrorOpportunityIds = (attempts: readonly ErpOrderAttemptForOpenError[]): string[] => {
  const time = (value: Date | string) => new Date(value).getTime();
  const lastSentAt = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.status !== "sent") continue;
    lastSentAt.set(attempt.opportunityId, Math.max(lastSentAt.get(attempt.opportunityId) ?? -Infinity, time(attempt.createdAt)));
  }
  const open = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.status !== "error" || attempt.hasManualResolution) continue;
    if ((lastSentAt.get(attempt.opportunityId) ?? -Infinity) > time(attempt.createdAt)) continue;
    open.add(attempt.opportunityId);
  }
  return [...open];
};

/** Banner "Alerta operacional ERP" e status 207 do healthcheck: falha de sincronização de algum
 * escopo ou pedido com erro em aberto. O histórico de erros já superados não acende o alerta. */
export const hasErpOperationalAlert = (input: { scopeErrors: number; openErrorOrders: number }) =>
  input.scopeErrors > 0 || input.openErrorOrders > 0;

const erpOrderParameterValueSchema = z.custom<ErpOrderParameterValue>(
  (value) => Boolean(normalizeErpParameterCode(value)),
  { message: "Código ERP obrigatório." },
);

export const erpOrderGenerationSchema = z.object({
  paymentMethodCode: erpOrderParameterValueSchema,
  receivingConditionCode: erpOrderParameterValueSchema,
  priceTableCode: erpOrderParameterValueSchema,
  branchCode: erpOrderParameterValueSchema,
  operationCode: erpOrderParameterValueSchema,
  expectedDeliveryDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Data prevista de entrega obrigatória no formato YYYY-MM-DD."),
  erpOrderObservation: z.string().max(2000, "Observações do pedido ERP devem ter no máximo 2000 caracteres.").optional().default(""),
  simulateOnly: z.boolean().optional().default(false),
});

export type ErpOrderGenerationInput = z.infer<typeof erpOrderGenerationSchema>;

export type ErpOrderSyncReadinessStatus = "pending" | "sent" | "error";
export type ErpOrderSyncReadinessOrderStatus = "pendente" | "faturado" | "parcial" | "cancelado" | "entregue" | null | undefined;

export type ErpOrderReadinessInput = {
  stage?: string | null;
  itemCount?: number | null;
  clientErpCode?: string | null;
  sellerErpCode?: string | null;
  sellerOperatorCode?: string | null;
  sellerLoginFv3?: string | null;
  sellerPasswordConfigured?: boolean | null;
  paymentMethodCode?: string | null;
  receivingConditionCode?: string | null;
  priceTableCode?: string | null;
  branchCode?: string | null;
  operationCode?: string | null;
  requireOrderParameters?: boolean;
};

export type ErpOrderReadinessResult = {
  ready: boolean;
  reasons: string[];
  firstReason: string | null;
};

const hasTextValue = (value?: string | null) => Boolean(value?.trim());

// O código do cliente só chega pela sincronização de parceiros do ERP.
export const CLIENT_WITHOUT_ERP_CODE_ORDER_MESSAGE =
  "Cliente ainda sem código do ERP. Cadastre o cliente no ERP e aguarde a próxima sincronização (ou use Sincronizar clientes de todos vendedores).";

export const getErpOrderReadiness = (input: ErpOrderReadinessInput): ErpOrderReadinessResult => {
  const reasons = [
    input.stage !== "ganho" ? "Pedido ERP indisponível: oportunidade não está Ganha." : null,
    Number(input.itemCount || 0) < 1 ? "Pedido ERP indisponível: oportunidade sem itens. Inclua pelo menos 1 item antes de gerar o pedido ERP." : null,
    !hasTextValue(input.clientErpCode) ? CLIENT_WITHOUT_ERP_CODE_ORDER_MESSAGE : null,
    !hasTextValue(input.sellerErpCode) ? "Pedido ERP indisponível: vendedor sem CODVENDEDOR." : null,
    !hasTextValue(input.sellerOperatorCode) ? "Pedido ERP indisponível: vendedor sem OPERADOR. Teste o login FV3 do vendedor em Configurações > Usuários." : null,
    !hasTextValue(input.sellerLoginFv3) ? "Pedido ERP indisponível: vendedor sem Login FV3. Configure o Login FV3 em Configurações > Usuários." : null,
    input.sellerPasswordConfigured === false ? "Pedido ERP indisponível: vendedor sem Senha FV3. Configure a Senha FV3 em Configurações > Usuários." : null,
    input.requireOrderParameters && !hasTextValue(input.paymentMethodCode) ? "Pedido ERP indisponível: informe a forma de pagamento." : null,
    input.requireOrderParameters && !hasTextValue(input.receivingConditionCode) ? "Pedido ERP indisponível: informe a condição de recebimento." : null,
    input.requireOrderParameters && !hasTextValue(input.priceTableCode) ? "Pedido ERP indisponível: informe a tabela de preço." : null,
    input.requireOrderParameters && !hasTextValue(input.branchCode) ? "Pedido ERP indisponível: informe a filial." : null,
    input.requireOrderParameters && !hasTextValue(input.operationCode) ? "Pedido ERP indisponível: informe a operação." : null,
  ].filter(Boolean) as string[];

  return {
    ready: reasons.length === 0,
    reasons,
    firstReason: reasons[0] || null,
  };
};

export type ErpOrderSyncReadinessInput = {
  status?: ErpOrderSyncReadinessStatus | null;
  orderStatus?: ErpOrderSyncReadinessOrderStatus;
};

export const isSuccessfulErpOrderSync = (order: ErpOrderSyncReadinessInput) =>
  order.status === "sent" && order.orderStatus !== "cancelado";

/** Pedido válido = tentativa aceita pelo ERP (`sent`). Tentativa `error` (recusada) e `pending`
 * (sem confirmação; vira `sent` quando o ERP confirma) não contam em "Sincronizados" nem no ganho
 * efetivo. Na tela Pedidos, `pending` entra em Pedidos/Valor total como "Aguardando"; `error` nunca. */
export const VALID_ERP_ORDER_SYNC_STATUS = "sent" as const;
export const isValidErpOrder = (order: { status?: string | null }) => order.status === VALID_ERP_ORDER_SYNC_STATUS;

export const isErpOrderSyncResendable = (order: ErpOrderSyncReadinessInput) =>
  order.status === "error" || order.status === "pending" || order.orderStatus === "cancelado";

export const KnowledgeDocumentCategoryEnum = z.enum([
  "produto",
  "mix",
  "cultura",
  "argumento_comercial",
  "objeção",
  "manual_tecnico",
  "treinamento",
  "institucional",
  "outro"
]);

export const KnowledgeDocumentSourceTypeEnum = z.enum(["manual", "pdf", "texto", "upload", "interno", "outro"]);

const knowledgeDocumentTagsSchema = z.array(z.string().trim().min(1).max(60)).max(30).default([]);

export const knowledgeDocumentCreateSchema = z.object({
  title: z.string().trim().min(3).max(180),
  category: KnowledgeDocumentCategoryEnum.default("outro"),
  sourceType: KnowledgeDocumentSourceTypeEnum.default("manual"),
  sourceName: z.string().trim().max(180).optional().nullable(),
  content: z.string().trim().min(10).max(50000),
  summary: z.string().trim().max(2000).optional().nullable(),
  tags: knowledgeDocumentTagsSchema,
  isActive: z.boolean().optional().default(true)
});

export const knowledgeDocumentUpdateSchema = knowledgeDocumentCreateSchema.partial().extend({
  title: z.string().trim().min(3).max(180).optional(),
  content: z.string().trim().min(10).max(50000).optional()
});

export type KnowledgeDocumentCategory = z.infer<typeof KnowledgeDocumentCategoryEnum>;
export type KnowledgeDocumentSourceType = z.infer<typeof KnowledgeDocumentSourceTypeEnum>;
export type KnowledgeDocumentCreateInput = z.infer<typeof knowledgeDocumentCreateSchema>;
export type KnowledgeDocumentUpdateInput = z.infer<typeof knowledgeDocumentUpdateSchema>;
