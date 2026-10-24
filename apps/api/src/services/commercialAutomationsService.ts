import { AgendaEventType, EventType, OpportunityStage, Prisma, type PrismaClient } from "@prisma/client";
import {
  commercialAutomationsConfigSchema,
  type CommercialAutomationsConfig,
  type CommercialAutomationsSimulation,
  type InactiveClientWorkflowSkips
} from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { listPortfolioSegment } from "./clientPortfolioStatus.js";

export const COMMERCIAL_AUTOMATIONS_CONFIG_KEY = "commercialAutomations.config";
export const COMMERCIAL_AUTOMATIONS_HISTORY_KEY = "commercialAutomations.history";
export const WORKFLOW_INACTIVE_CLIENT_ORIGIN = "workflow_cliente_sem_compra";

// daysWithoutPurchase, allowedOptions e customDaysEnabled ficam só por compatibilidade com a configuração salva:
// a elegibilidade agora é a regra oficial da carteira (inativo recente).
export const DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG: CommercialAutomationsConfig = {
  inactiveClientWorkflow: {
    enabled: false,
    daysWithoutPurchase: 90,
    allowedOptions: [30, 60, 90],
    customDaysEnabled: true,
    returnDeadlineBusinessDays: 2,
    initialOpportunityStage: "prospeccao",
    dailyLimitPerSeller: 5,
    createOpportunity: true,
    createActivity: true,
    createTimelineEvent: true
  }
};

type CommercialAutomationRunStatus = {
  running: boolean;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastResult: CommercialAutomationRunResult | null;
  lastError: string | null;
};

// Execução registrada no histórico persistente (AppConfig), sem dados de clientes.
export type CommercialAutomationRunResult = {
  at: string;
  trigger: "manual" | "scheduler";
  skipped: boolean;
  reason?: string;
  configIssues?: string[];
  dayKey: string;
  inactiveRecentClients: number;
  eligibleClients: number;
  createdOpportunities: number;
  // Compromissos de Ligação na Agenda. Execuções antigas do histórico têm createdActivities (atividade pendente).
  createdAgendaEvents: number;
  createdTimelineEvents: number;
  skippedByReason: InactiveClientWorkflowSkips;
  // Inativos recentes em cobrança, fora da automação (execuções antigas do histórico não têm o campo).
  inCollection: number;
};

const OPEN_OPPORTUNITY_STAGES = [OpportunityStage.prospeccao, OpportunityStage.negociacao, OpportunityStage.proposta] as const;
const RECENT_AUTOMATION_DAYS = 90;
const HISTORY_LIMIT = 100;
const DAY_MS = 86_400_000;
const BRAZIL_UTC_OFFSET_MS = 3 * 3_600_000;
const CALL_START_HOUR = 9;
const CALL_DURATION_MINUTES = 30;

const status: CommercialAutomationRunStatus = {
  running: false,
  lastRunAt: null,
  lastFinishedAt: null,
  lastResult: null,
  lastError: null
};

export const getCommercialAutomationsStatus = () => ({ ...status });

export const parseCommercialAutomationsConfig = (value: string | null | undefined): CommercialAutomationsConfig => {
  if (!value) return DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG;

  try {
    const parsed = JSON.parse(value);
    return {
      ...DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG,
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      inactiveClientWorkflow: {
        ...DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG.inactiveClientWorkflow,
        ...(parsed?.inactiveClientWorkflow && typeof parsed.inactiveClientWorkflow === "object" ? parsed.inactiveClientWorkflow : {})
      }
    };
  } catch (error) {
    logApiEvent("ERROR", "[commercial automations] failed to parse config", { error: error instanceof Error ? error.message : String(error) });
    return DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG;
  }
};

export const loadCommercialAutomationsConfig = async (client: PrismaClient | Prisma.TransactionClient = prisma) => {
  const config = await client.appConfig.upsert({
    where: { key: COMMERCIAL_AUTOMATIONS_CONFIG_KEY },
    update: {},
    create: { key: COMMERCIAL_AUTOMATIONS_CONFIG_KEY, value: JSON.stringify(DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG) },
    select: { value: true }
  });

  return parseCommercialAutomationsConfig(config.value);
};

// Dia de Brasília (YYYY-MM-DD) e o instante em que ele começa; Brasília está em UTC-3 fixo.
const brazilDayKeyOf = (instant: Date) => new Date(instant.getTime() - BRAZIL_UTC_OFFSET_MS).toISOString().slice(0, 10);
const brazilDayStart = (dayKey: string) => new Date(Date.parse(`${dayKey}T00:00:00.000Z`) + BRAZIL_UTC_OFFSET_MS);

// Soma dias úteis (seg a sex) a um dia YYYY-MM-DD.
const addBusinessDays = (dayKey: string, businessDays: number) => {
  const result = new Date(`${dayKey}T00:00:00.000Z`);
  let added = 0;
  while (added < businessDays) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return result.toISOString().slice(0, 10);
};

const parseDateValue = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

const readFinancialProfileRecord = (value: Prisma.JsonValue | null) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const resolvePurchaseDate = (client: { lastPurchaseDate: Date | null; financialProfile: Prisma.JsonValue | null }) => {
  if (client.lastPurchaseDate) return client.lastPurchaseDate;
  return parseDateValue(readFinancialProfileRecord(client.financialProfile).DATA_ULTFATURA);
};

export const validateCommercialAutomationsConfig = (config: CommercialAutomationsConfig) => {
  const parsed = commercialAutomationsConfigSchema.safeParse(config);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

const emptySkips = (): InactiveClientWorkflowSkips => ({ inactiveSeller: 0, openOpportunity: 0, recentAutomation: 0, dailyLimit: 0 });

type PlannedClient = { id: string; name: string; ownerSellerId: string; lastPurchase: Date };
type InactiveClientWorkflowPlan = {
  dayKey: string;
  inactiveRecentClients: number;
  eligibleClients: number;
  inCollection: number;
  toCreate: PlannedClient[];
  skipped: InactiveClientWorkflowSkips;
};

// Quem a automação atende hoje: inativo recente pela regra oficial da carteira (sem arquivados), fora de cobrança, com vendedor
// responsável ativo, sem oportunidade aberta e sem oportunidade da automação nos últimos 90 dias (mesmo encerrada).
// O teto diário por vendedor conta o que a automação já criou no dia de Brasília; a fila segue a compra mais
// recente primeiro e o excedente fica para os próximos dias.
const planInactiveClientWorkflow = async (dailyLimitPerSeller: number, now: Date): Promise<InactiveClientWorkflowPlan> => {
  const dayKey = brazilDayKeyOf(now);
  const plan: InactiveClientWorkflowPlan = { dayKey, inactiveRecentClients: 0, eligibleClients: 0, inCollection: 0, toCreate: [], skipped: emptySkips() };
  const inactiveRecent = (await listPortfolioSegment("semComprar", {}, now, { keepCollection: true })).filter((entry) => entry.status === "inativoRecente");
  plan.inactiveRecentClients = inactiveRecent.length;
  const segment = inactiveRecent.filter((entry) => !entry.inCollection);
  plan.inCollection = inactiveRecent.length - segment.length;
  if (!segment.length) return plan;

  const ids = segment.map((entry) => entry.id);
  const [clients, openOpportunities, recentAutomationOpportunities, createdToday] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, ownerSellerId: true, ownerSeller: { select: { isActive: true } } } }),
    prisma.opportunity.findMany({ where: { clientId: { in: ids }, stage: { in: [...OPEN_OPPORTUNITY_STAGES] } }, select: { clientId: true } }),
    prisma.opportunity.findMany({
      where: { clientId: { in: ids }, notes: { contains: WORKFLOW_INACTIVE_CLIENT_ORIGIN }, createdAt: { gte: new Date(now.getTime() - RECENT_AUTOMATION_DAYS * DAY_MS) } },
      select: { clientId: true }
    }),
    prisma.opportunity.findMany({ where: { notes: { contains: WORKFLOW_INACTIVE_CLIENT_ORIGIN }, createdAt: { gte: brazilDayStart(dayKey) } }, select: { ownerSellerId: true } })
  ]);
  const clientById = new Map(clients.map((client) => [client.id, client]));
  const withOpenOpportunity = new Set(openOpportunities.map((row) => row.clientId));
  const withRecentAutomation = new Set(recentAutomationOpportunities.map((row) => row.clientId));
  const usedBySeller = new Map<string, number>();
  for (const row of createdToday) usedBySeller.set(row.ownerSellerId, (usedBySeller.get(row.ownerSellerId) ?? 0) + 1);

  for (const entry of segment) {
    const client = clientById.get(entry.id);
    if (!client || !client.ownerSeller?.isActive) { plan.skipped.inactiveSeller += 1; continue; }
    if (withOpenOpportunity.has(client.id)) { plan.skipped.openOpportunity += 1; continue; }
    if (withRecentAutomation.has(client.id)) { plan.skipped.recentAutomation += 1; continue; }
    plan.eligibleClients += 1;
    const used = usedBySeller.get(client.ownerSellerId) ?? 0;
    if (used >= dailyLimitPerSeller) { plan.skipped.dailyLimit += 1; continue; }
    usedBySeller.set(client.ownerSellerId, used + 1);
    plan.toCreate.push({ id: client.id, name: client.name, ownerSellerId: client.ownerSellerId, lastPurchase: entry.lastPurchase!.date });
  }
  return plan;
};

// Somente leitura: nada é gravado, nem o histórico.
export const simulateCommercialAutomations = async (now = new Date()): Promise<CommercialAutomationsSimulation> => {
  const stored = await prisma.appConfig.findUnique({ where: { key: COMMERCIAL_AUTOMATIONS_CONFIG_KEY }, select: { value: true } });
  const config = parseCommercialAutomationsConfig(stored?.value);
  const workflow = config.inactiveClientWorkflow;
  const configIssues = validateCommercialAutomationsConfig(config);
  const dailyLimitPerSeller = workflow.dailyLimitPerSeller;
  const plan = await planInactiveClientWorkflow(dailyLimitPerSeller, now);
  return {
    enabled: workflow.enabled,
    configIssues,
    dayKey: plan.dayKey,
    dailyLimitPerSeller,
    inactiveRecentClients: plan.inactiveRecentClients,
    eligibleClients: plan.eligibleClients,
    wouldCreate: plan.toCreate.length,
    skipped: plan.skipped,
    inCollection: plan.inCollection
  };
};

const parseHistory = (value: string | null | undefined): CommercialAutomationRunResult[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const loadCommercialAutomationsHistory = async () => {
  const row = await prisma.appConfig.findUnique({ where: { key: COMMERCIAL_AUTOMATIONS_HISTORY_KEY }, select: { value: true } });
  return parseHistory(row?.value);
};

// Mais recente primeiro, até HISTORY_LIMIT execuções.
const appendHistory = async (entry: CommercialAutomationRunResult) => {
  const history = [entry, ...(await loadCommercialAutomationsHistory())].slice(0, HISTORY_LIMIT);
  const value = JSON.stringify(history);
  await prisma.appConfig.upsert({ where: { key: COMMERCIAL_AUTOMATIONS_HISTORY_KEY }, update: { value }, create: { key: COMMERCIAL_AUTOMATIONS_HISTORY_KEY, value } });
};

export const runCommercialAutomations = async (trigger: "manual" | "scheduler" = "manual", now = new Date()): Promise<CommercialAutomationRunResult> => {
  const result: CommercialAutomationRunResult = {
    at: now.toISOString(), trigger, skipped: false, dayKey: brazilDayKeyOf(now), inactiveRecentClients: 0, eligibleClients: 0,
    createdOpportunities: 0, createdAgendaEvents: 0, createdTimelineEvents: 0, skippedByReason: emptySkips(), inCollection: 0
  };
  if (status.running) return { ...result, skipped: true, reason: "already_running" };

  status.running = true;
  status.lastRunAt = now.toISOString();
  status.lastError = null;

  try {
    const config = await loadCommercialAutomationsConfig();
    const workflow = config.inactiveClientWorkflow;
    const configIssues = validateCommercialAutomationsConfig(config);
    if (!workflow.enabled || !workflow.createOpportunity || configIssues.length) {
      result.skipped = true;
      result.reason = !workflow.enabled ? "workflow_disabled" : configIssues.length ? "invalid_config" : "opportunity_creation_disabled";
      if (configIssues.length) result.configIssues = configIssues;
      await appendHistory(result);
      return result;
    }

    const plan = await planInactiveClientWorkflow(workflow.dailyLimitPerSeller, now);
    result.inactiveRecentClients = plan.inactiveRecentClients;
    result.eligibleClients = plan.eligibleClients;
    result.skippedByReason = plan.skipped;
    result.inCollection = plan.inCollection;

    const today = new Date(`${plan.dayKey}T00:00:00.000Z`);
    const dueDayKey = addBusinessDays(plan.dayKey, workflow.returnDeadlineBusinessDays);
    const followUpDate = new Date(`${dueDayKey}T00:00:00.000Z`);
    // A ligação entra na Agenda às 9h de Brasília do dia útil do prazo, com 30 minutos.
    const callStart = new Date(brazilDayStart(dueDayKey).getTime() + CALL_START_HOUR * 3_600_000);
    const callEnd = new Date(callStart.getTime() + CALL_DURATION_MINUTES * 60_000);

    for (const client of plan.toCreate) {
      await prisma.$transaction(async (tx) => {
        const opportunity = await tx.opportunity.create({
          data: {
            title: `Reativação – ${client.name}`,
            // Valor 0: não infla o pipeline até o vendedor qualificar.
            value: 0,
            stage: workflow.initialOpportunityStage,
            proposalDate: today,
            followUpDate,
            expectedCloseDate: followUpDate,
            clientId: client.id,
            ownerSellerId: client.ownerSellerId,
            probability: 30,
            notes: `${WORKFLOW_INACTIVE_CLIENT_ORIGIN}\nInativo recente pela regra oficial da carteira. Última compra: ${brazilDayKeyOf(client.lastPurchase)}.`
          }
        });
        result.createdOpportunities += 1;

        // createActivity é a chave salva na configuração; agora cria o compromisso de Ligação (planejamento), não atividade.
        if (workflow.createActivity) {
          await tx.agendaEvent.create({ data: { type: AgendaEventType.ligacao, title: `Ligação de reativação – ${client.name}`, notes: `Contato automático: ${WORKFLOW_INACTIVE_CLIENT_ORIGIN}. Contato de reativação com cliente inativo recente.`, startDateTime: callStart, endDateTime: callEnd, clientId: client.id, opportunityId: opportunity.id, sellerId: client.ownerSellerId } });
          result.createdAgendaEvents += 1;
        }

        if (workflow.createTimelineEvent) {
          await tx.timelineEvent.create({ data: { type: EventType.status, description: `Automação comercial criou oportunidade de reativação (${WORKFLOW_INACTIVE_CLIENT_ORIGIN}).`, clientId: client.id, opportunityId: opportunity.id, ownerSellerId: client.ownerSellerId } });
          result.createdTimelineEvents += 1;
        }
      });
    }

    await appendHistory(result);
    logApiEvent("INFO", "[commercial automations] run finished", { ...result });
    return result;
  } catch (error) {
    status.lastError = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[commercial automations] run failed", { trigger, error: status.lastError });
    throw error;
  } finally {
    status.running = false;
    status.lastFinishedAt = new Date().toISOString();
    status.lastResult = result;
  }
};
