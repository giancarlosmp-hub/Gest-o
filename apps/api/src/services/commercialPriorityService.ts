import { WORKFLOW_INACTIVE_CLIENT_ORIGIN } from "./commercialAutomationsService.js";

export type CommercialPriorityLevel = "baixa" | "normal" | "alta" | "urgente";
export type CommercialPriorityColor = "green" | "blue" | "orange" | "red";

export type CommercialPriority = {
  score: number;
  level: CommercialPriorityLevel;
  color: CommercialPriorityColor;
  reasons: string[];
  nextAction: string;
};

type DateLike = Date | string | null | undefined;
type FinancialProfileLike = Record<string, unknown> | string | null | undefined;

type CommercialPriorityClientInput = {
  lastPurchaseDate?: DateLike;
  lastPurchaseValue?: number | string | null;
  ownerSellerId?: string | null;
  financialProfile?: FinancialProfileLike;
  openTitles?: unknown[] | number | null;
  overdueTitles?: unknown[] | number | null;
  openTitlesTotal?: number | string | null;
  overdueTitlesTotal?: number | string | null;
};

type CommercialPriorityOpportunityInput = {
  stage?: string | null;
  value?: number | string | null;
  followUpDate?: DateLike;
  lastContactAt?: DateLike;
  createdAt?: DateLike;
  automatic?: boolean | null;
  createdAutomatically?: boolean | null;
  source?: string | null;
  notes?: string | null;
};

type CommercialPriorityActivityInput = {
  date?: DateLike;
  dueDate?: DateLike;
  createdAt?: DateLike;
  completedAt?: DateLike;
  status?: string | null;
  done?: boolean | null;
};

type CommercialPriorityTimelineEventInput = {
  createdAt?: DateLike;
  description?: string | null;
};

type CommercialPriorityWorkflowInput = {
  inactiveClient?: boolean | null;
  clientWithoutPurchase?: boolean | null;
  automaticallyCreatedOpportunity?: boolean | null;
};

type CommercialPriorityAiInput = {
  suggestions?: unknown[] | number | null;
  hasContext?: boolean | null;
};

export type CommercialPriorityInput = {
  client?: CommercialPriorityClientInput | null;
  opportunity?: CommercialPriorityOpportunityInput | null;
  activities?: CommercialPriorityActivityInput[] | null;
  timelineEvents?: CommercialPriorityTimelineEventInput[] | null;
  workflow?: CommercialPriorityWorkflowInput | null;
  ai?: CommercialPriorityAiInput | null;
  now?: Date;
};

export const COMMERCIAL_PRIORITY_WEIGHTS = {
  overdueFollowUp: 30,
  overdueActivity: 20,
  inactiveClient90Days: 20,
  inactiveClient180Days: 30,
  highValueOpportunity: 20,
  mediumValueOpportunity: 10,
  advancedOpportunityStage: 15,
  staleOpportunityContact: 10,
  overdueFinancialTitles: 15,
  openFinancialTitles: 5,
  noOwnerSeller: 10,
  manyActivities: 5,
  aiSuggestion: 5,
  workflowInactiveClient: 15,
  workflowAutomaticOpportunity: 10
} as const;

export const COMMERCIAL_PRIORITY_THRESHOLDS = {
  mediumOpportunityValue: 15000,
  highOpportunityValue: 45000,
  inactiveClientDays: 90,
  veryInactiveClientDays: 180,
  staleContactDays: 14,
  manyActivitiesCount: 3
} as const;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const parseDate = (value: DateLike): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toNumber = (value: number | string | null | undefined) => {
  const numberValue = Number(String(value ?? "0").replace(",", "."));
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const countItems = (...values: Array<unknown[] | number | string | null | undefined>) => {
  for (const value of values) {
    if (Array.isArray(value)) return value.length;
    const numericValue = toNumber(typeof value === "string" || typeof value === "number" ? value : null);
    if (numericValue > 0) return numericValue;
  }
  return 0;
};

const daysBetween = (olderDate: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - olderDate.getTime()) / DAY_IN_MS));

const formatCurrency = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

const readFinancialProfile = (value: FinancialProfileLike) => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value : {};
};

const readFinancialDate = (profile: Record<string, unknown>) =>
  parseDate(profile.DATA_ULTFATURA as DateLike) ||
  parseDate(profile.lastPurchaseDate as DateLike) ||
  parseDate(profile.ultimaCompra as DateLike);

const isAdvancedStage = (stage?: string | null) => {
  const normalized = (stage || "").toLowerCase();
  return ["proposta", "negociacao", "negociação"].some((term) => normalized.includes(term));
};

const isIncompleteActivity = (activity: CommercialPriorityActivityInput) => {
  const status = (activity.status || "").toLowerCase();
  return !activity.done && !activity.completedAt && !["done", "completed", "concluida", "concluída", "finalizada"].includes(status);
};

const getLatestDate = (dates: Array<Date | null>) =>
  dates.filter((date): date is Date => Boolean(date)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

const resolveLevel = (score: number): Pick<CommercialPriority, "level" | "color"> => {
  if (score >= 76) return { level: "urgente", color: "red" };
  if (score >= 51) return { level: "alta", color: "orange" };
  if (score >= 26) return { level: "normal", color: "blue" };
  return { level: "baixa", color: "green" };
};

const resolveNextAction = (reasons: string[], level: CommercialPriorityLevel) => {
  if (reasons.some((reason) => /follow-up vencido|atividades? vencidas?/i.test(reason))) return "Ligar hoje";
  if (reasons.some((reason) => /título vencido/i.test(reason))) return "Validar pendência financeira antes do contato";
  if (reasons.some((reason) => /sem compra/i.test(reason))) return "Reativar cliente com oferta consultiva";
  if (level === "urgente" || level === "alta") return "Priorizar contato comercial hoje";
  return "Manter acompanhamento planejado";
};

export class CommercialPriorityService {
  calculate({ client, opportunity, activities, timelineEvents, workflow, ai, now = new Date() }: CommercialPriorityInput): CommercialPriority {
    const activityList = activities ?? [];
    const timelineEventList = timelineEvents ?? [];
    const financialProfile = readFinancialProfile(client?.financialProfile);
    const reasons: string[] = [];
    let score = 0;

    const addReason = (weight: number, reason: string) => {
      score += weight;
      reasons.push(reason);
    };

    const followUpDate = parseDate(opportunity?.followUpDate);
    if (followUpDate && followUpDate < now) addReason(COMMERCIAL_PRIORITY_WEIGHTS.overdueFollowUp, "Follow-up vencido");

    const lastPurchaseDate = parseDate(client?.lastPurchaseDate) || readFinancialDate(financialProfile);
    if (lastPurchaseDate) {
      const daysWithoutPurchase = daysBetween(lastPurchaseDate, now);
      if (daysWithoutPurchase >= COMMERCIAL_PRIORITY_THRESHOLDS.veryInactiveClientDays) addReason(COMMERCIAL_PRIORITY_WEIGHTS.inactiveClient180Days, `Cliente sem compra há ${daysWithoutPurchase} dias`);
      else if (daysWithoutPurchase >= COMMERCIAL_PRIORITY_THRESHOLDS.inactiveClientDays) addReason(COMMERCIAL_PRIORITY_WEIGHTS.inactiveClient90Days, `Cliente sem compra há ${daysWithoutPurchase} dias`);
    }

    const opportunityValue = toNumber(opportunity?.value);
    if (opportunityValue >= COMMERCIAL_PRIORITY_THRESHOLDS.highOpportunityValue) addReason(COMMERCIAL_PRIORITY_WEIGHTS.highValueOpportunity, `Oportunidade acima de ${formatCurrency(COMMERCIAL_PRIORITY_THRESHOLDS.highOpportunityValue)}`);
    else if (opportunityValue >= COMMERCIAL_PRIORITY_THRESHOLDS.mediumOpportunityValue) addReason(COMMERCIAL_PRIORITY_WEIGHTS.mediumValueOpportunity, `Oportunidade acima de ${formatCurrency(COMMERCIAL_PRIORITY_THRESHOLDS.mediumOpportunityValue)}`);

    if (isAdvancedStage(opportunity?.stage)) addReason(COMMERCIAL_PRIORITY_WEIGHTS.advancedOpportunityStage, `Oportunidade em estágio avançado (${opportunity?.stage})`);

    const latestActivityDate = getLatestDate(activityList.map((activity) => parseDate(activity.date) || parseDate(activity.createdAt)));
    const latestTimelineDate = getLatestDate(timelineEventList.map((event) => parseDate(event.createdAt)));
    const lastContactAt = getLatestDate([parseDate(opportunity?.lastContactAt), latestActivityDate, latestTimelineDate, parseDate(opportunity?.createdAt)]);
    if (lastContactAt && daysBetween(lastContactAt, now) >= COMMERCIAL_PRIORITY_THRESHOLDS.staleContactDays) addReason(COMMERCIAL_PRIORITY_WEIGHTS.staleOpportunityContact, `Sem contato na oportunidade há ${daysBetween(lastContactAt, now)} dias`);

    const overdueActivityCount = activityList.filter((activity) => {
      const dueDate = parseDate(activity.dueDate || activity.date);
      return dueDate && dueDate < now && isIncompleteActivity(activity);
    }).length;
    if (overdueActivityCount > 0) addReason(COMMERCIAL_PRIORITY_WEIGHTS.overdueActivity, overdueActivityCount === 1 ? "Atividade vencida" : `${overdueActivityCount} atividades vencidas`);

    if (activityList.length >= COMMERCIAL_PRIORITY_THRESHOLDS.manyActivitiesCount) addReason(COMMERCIAL_PRIORITY_WEIGHTS.manyActivities, `${activityList.length} atividades registradas`);

    const overdueTitlesCount = countItems(client?.overdueTitles, client?.overdueTitlesTotal, financialProfile.overdueTitlesTotal as number | string | null | undefined, financialProfile.overdueTitles as unknown[] | number | undefined);
    if (overdueTitlesCount > 0) addReason(COMMERCIAL_PRIORITY_WEIGHTS.overdueFinancialTitles, overdueTitlesCount === 1 ? "Cliente com título vencido" : `Cliente com ${overdueTitlesCount} títulos vencidos`);
    else if (countItems(client?.openTitles, client?.openTitlesTotal, financialProfile.openTitlesTotal as number | string | null | undefined, financialProfile.openTitles as unknown[] | number | undefined) > 0) addReason(COMMERCIAL_PRIORITY_WEIGHTS.openFinancialTitles, "Cliente com títulos em aberto");

    if (client && !client.ownerSellerId) addReason(COMMERCIAL_PRIORITY_WEIGHTS.noOwnerSeller, "Cliente sem vendedor responsável");
    if (workflow?.inactiveClient || workflow?.clientWithoutPurchase) addReason(COMMERCIAL_PRIORITY_WEIGHTS.workflowInactiveClient, "Workflow de cliente sem compra ativo");
    if (workflow?.automaticallyCreatedOpportunity || opportunity?.automatic || opportunity?.createdAutomatically || opportunity?.source === "automatic" || opportunity?.notes?.includes(WORKFLOW_INACTIVE_CLIENT_ORIGIN)) addReason(COMMERCIAL_PRIORITY_WEIGHTS.workflowAutomaticOpportunity, "Oportunidade criada automaticamente");
    if (countItems(ai?.suggestions) > 0 || ai?.hasContext) addReason(COMMERCIAL_PRIORITY_WEIGHTS.aiSuggestion, "Sugestão inteligente disponível");

    const normalizedScore = Math.min(100, Math.max(0, score));
    const levelAndColor = resolveLevel(normalizedScore);

    return {
      score: normalizedScore,
      ...levelAndColor,
      reasons,
      nextAction: resolveNextAction(reasons, levelAndColor.level)
    };
  }
}

export const commercialPriorityService = new CommercialPriorityService();

export const calculateCommercialPriority = (input: CommercialPriorityInput): CommercialPriority => commercialPriorityService.calculate(input);
