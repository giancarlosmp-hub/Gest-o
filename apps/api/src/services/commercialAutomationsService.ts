import { ActivityType, EventType, OpportunityStage, Prisma, type PrismaClient } from "@prisma/client";
import type { CommercialAutomationsConfig } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";

export const COMMERCIAL_AUTOMATIONS_CONFIG_KEY = "commercialAutomations.config";
export const WORKFLOW_INACTIVE_CLIENT_ORIGIN = "workflow_cliente_sem_compra";

export const DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG: CommercialAutomationsConfig = {
  inactiveClientWorkflow: {
    enabled: false,
    daysWithoutPurchase: 90,
    allowedOptions: [30, 60, 90],
    customDaysEnabled: true,
    returnDeadlineBusinessDays: 3,
    initialOpportunityStage: "follow_up",
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

export type CommercialAutomationRunResult = {
  skipped: boolean;
  reason?: string;
  thresholdDays: number;
  scannedClients: number;
  eligibleClients: number;
  createdOpportunities: number;
  duplicatedOpenOpportunities: number;
  ignoredArchived: number;
  ignoredWithoutSeller: number;
  ignoredWithoutPurchaseDate: number;
  createdActivities: number;
  createdTimelineEvents: number;
};

const OPEN_OPPORTUNITY_STAGES = [OpportunityStage.prospeccao, OpportunityStage.negociacao, OpportunityStage.proposta] as const;

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

const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const addBusinessDays = (date: Date, businessDays: number) => {
  const result = startOfUtcDay(date);
  let added = 0;
  while (added < businessDays) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return result;
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

const resolvePurchaseDate = (client: { lastPurchaseDate: Date | null; financialProfile: Prisma.JsonValue | null }) => {
  if (client.lastPurchaseDate) return client.lastPurchaseDate;
  return parseDateValue(readFinancialProfileRecord(client.financialProfile).DATA_ULTFATURA);
};

const readNumber = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(",", "."));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const resolveOpportunityValue = (client: { lastPurchaseValue: number | null; financialProfile: Prisma.JsonValue | null }) => {
  const profile = readFinancialProfileRecord(client.financialProfile);
  return readNumber(client.lastPurchaseValue, profile.ticketMedio, profile.TICKET_MEDIO, profile.ticket_medio, profile.VLR_MEDIO_FATURA) ?? 0;
};

const resolveStage = (configuredStage: string) => {
  if ((Object.values(OpportunityStage) as string[]).includes(configuredStage)) return configuredStage as OpportunityStage;
  return OpportunityStage.prospeccao;
};

export const runCommercialAutomations = async (trigger: "manual" | "scheduler" = "manual", now = new Date()): Promise<CommercialAutomationRunResult> => {
  if (status.running) {
    return { skipped: true, reason: "already_running", thresholdDays: 0, scannedClients: 0, eligibleClients: 0, createdOpportunities: 0, duplicatedOpenOpportunities: 0, ignoredArchived: 0, ignoredWithoutSeller: 0, ignoredWithoutPurchaseDate: 0, createdActivities: 0, createdTimelineEvents: 0 };
  }

  status.running = true;
  status.lastRunAt = now.toISOString();
  status.lastError = null;
  const result: CommercialAutomationRunResult = { skipped: false, thresholdDays: 0, scannedClients: 0, eligibleClients: 0, createdOpportunities: 0, duplicatedOpenOpportunities: 0, ignoredArchived: 0, ignoredWithoutSeller: 0, ignoredWithoutPurchaseDate: 0, createdActivities: 0, createdTimelineEvents: 0 };

  try {
    const config = await loadCommercialAutomationsConfig();
    const workflow = config.inactiveClientWorkflow;
    result.thresholdDays = workflow.daysWithoutPurchase;
    if (!workflow.enabled || !workflow.createOpportunity) {
      result.skipped = true;
      result.reason = !workflow.enabled ? "workflow_disabled" : "opportunity_creation_disabled";
      return result;
    }

    const cutoff = startOfUtcDay(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - workflow.daysWithoutPurchase);
    const clients = await prisma.client.findMany({
      where: {
        OR: [{ lastPurchaseDate: { lte: cutoff } }, { lastPurchaseDate: null }]
      },
      select: { id: true, name: true, isArchived: true, ownerSellerId: true, lastPurchaseDate: true, lastPurchaseValue: true, financialProfile: true }
    });
    result.scannedClients = clients.length;

    const followUpDate = addBusinessDays(now, workflow.returnDeadlineBusinessDays || 3);
    const stage = resolveStage(workflow.initialOpportunityStage);

    for (const client of clients) {
      if (client.isArchived) { result.ignoredArchived += 1; continue; }
      if (!client.ownerSellerId) { result.ignoredWithoutSeller += 1; continue; }
      const purchaseDate = resolvePurchaseDate(client);
      if (!purchaseDate) { result.ignoredWithoutPurchaseDate += 1; continue; }
      const daysWithoutPurchase = Math.floor((startOfUtcDay(now).getTime() - startOfUtcDay(purchaseDate).getTime()) / 86_400_000);
      if (daysWithoutPurchase < workflow.daysWithoutPurchase) continue;
      result.eligibleClients += 1;

      const existing = await prisma.opportunity.findFirst({ where: { clientId: client.id, stage: { in: [...OPEN_OPPORTUNITY_STAGES] }, notes: { contains: WORKFLOW_INACTIVE_CLIENT_ORIGIN } }, select: { id: true } });
      if (existing) { result.duplicatedOpenOpportunities += 1; continue; }

      await prisma.$transaction(async (tx) => {
        const opportunity = await tx.opportunity.create({
          data: {
            title: `Reativação comercial — cliente sem compra há ${workflow.daysWithoutPurchase} dias`,
            value: resolveOpportunityValue(client),
            stage,
            proposalDate: now,
            followUpDate,
            expectedCloseDate: followUpDate,
            clientId: client.id,
            ownerSellerId: client.ownerSellerId,
            probability: 30,
            notes: `${WORKFLOW_INACTIVE_CLIENT_ORIGIN}\nCliente sem compra há ${daysWithoutPurchase} dias. Última compra: ${purchaseDate.toISOString().slice(0, 10)}.`
          }
        });
        result.createdOpportunities += 1;

        if (workflow.createActivity) {
          await tx.activity.create({ data: { type: ActivityType.follow_up, notes: `Follow-up automático: ${WORKFLOW_INACTIVE_CLIENT_ORIGIN}`, description: "Contato de reativação comercial para cliente sem compra.", dueDate: followUpDate, clientId: client.id, opportunityId: opportunity.id, ownerSellerId: client.ownerSellerId } });
          result.createdActivities += 1;
        }

        if (workflow.createTimelineEvent) {
          await tx.timelineEvent.create({ data: { type: EventType.status, description: `Automação comercial criou oportunidade de reativação (${WORKFLOW_INACTIVE_CLIENT_ORIGIN}).`, clientId: client.id, opportunityId: opportunity.id, ownerSellerId: client.ownerSellerId } });
          result.createdTimelineEvents += 1;
        }
      });
    }

    logApiEvent("INFO", "[commercial automations] run finished", { trigger, ...result });
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
