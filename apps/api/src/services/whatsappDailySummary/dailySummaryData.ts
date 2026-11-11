import { OpportunityStage, type Prisma } from "@prisma/client";
import {
  WHATSAPP_DAILY_SUMMARY_MAX_ITEMS_PER_SECTION,
  type WhatsAppDailySummaryConfig,
  type WhatsAppDailySummarySections,
  type WhatsAppDailySummaryTipsStatus
} from "@salesforce-pro/shared";
import { env } from "../../config/env.js";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { inactiveRecentAutomationOpportunityWhere, resolvePurchaseDate } from "../commercialAutomationsService.js";
import { formatDailySummary, type DailySummaryData, type DailySummaryItem, type DailySummarySection, type DailySummaryTipFacts } from "./dailySummaryFormat.js";
import { generateDailySummaryTips, type DailySummaryTipsContext } from "./dailySummaryTips.js";

// WhatsApp Fase D: o que entra no resumo de um vendedor. Só oportunidades dele (ownerSellerId), de cliente
// não arquivado:
// - reativações abertas (automação de inativos recentes), as das últimas 24 h destacadas;
// - oportunidades lançadas nas últimas 24 h (sem as da automação, que já estão acima);
// - follow-ups vencidos e de hoje, em etapa aberta. O follow-up é gravado como o dia às 00:00 UTC; "hoje" é o
//   dia de Brasília.
// No máximo WHATSAPP_DAILY_SUMMARY_MAX_ITEMS_PER_SECTION itens por seção, mais o total.
// Com as dicas do gerente comercial ligadas, cada item leva também os dados para a IA (tipFacts): valor, último
// contato, cultura, produtos (ofertado e itens), última compra do cliente e a última troca de etapa registrada.

const OPEN_STAGES = [OpportunityStage.prospeccao, OpportunityStage.negociacao, OpportunityStage.proposta];
const DAY_MS = 86_400_000;
const BRAZIL_UTC_OFFSET_MS = 3 * 3_600_000;

/** Dia de Brasília (AAAA-MM-DD); Brasília está em UTC-3 fixo. */
export const brazilDayKeyOf = (instant: Date) => new Date(instant.getTime() - BRAZIL_UTC_OFFSET_MS).toISOString().slice(0, 10);

const itemSelect = {
  id: true,
  createdAt: true,
  stage: true,
  followUpDate: true,
  value: true,
  lastContactAt: true,
  crop: true,
  productOffered: true,
  client: { select: { name: true, city: true, state: true, lastPurchaseDate: true, financialProfile: true } }
} satisfies Prisma.OpportunitySelect;

type SummaryDb = Pick<typeof defaultPrisma, "opportunity" | "opportunityItem" | "opportunityChangeLog">;

export type DailySummaryLoadOptions = { tipFacts?: boolean };

export async function loadDailySummaryData(
  seller: { id: string; name: string },
  sections: WhatsAppDailySummarySections,
  now: Date,
  db: SummaryDb = defaultPrisma,
  options: DailySummaryLoadOptions = {}
): Promise<DailySummaryData> {
  const dayKey = brazilDayKeyOf(now);
  const todayStart = new Date(`${dayKey}T00:00:00.000Z`);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const since = new Date(now.getTime() - DAY_MS);
  const base: Prisma.OpportunityWhereInput = { ownerSellerId: seller.id, client: { isArchived: false } };
  const open: Prisma.OpportunityWhereInput = { stage: { in: OPEN_STAGES } };

  const section = async (where: Prisma.OpportunityWhereInput[], orderBy: Prisma.OpportunityOrderByWithRelationInput[], withNew = false): Promise<DailySummarySection> => {
    const all = { AND: [base, ...where] };
    const [rows, total, newCount] = await Promise.all([
      db.opportunity.findMany({ where: all, orderBy, take: WHATSAPP_DAILY_SUMMARY_MAX_ITEMS_PER_SECTION, select: itemSelect }),
      db.opportunity.count({ where: all }),
      withNew ? db.opportunity.count({ where: { AND: [...all.AND, { createdAt: { gte: since } }] } }) : Promise.resolve(0)
    ]);
    const items: DailySummaryItem[] = rows.map((row) => ({
      clientName: row.client.name,
      city: row.client.city,
      state: row.client.state,
      stage: row.stage,
      followUpDate: row.followUpDate,
      isNew: row.createdAt.getTime() >= since.getTime(),
      ...(options.tipFacts
        ? {
            tipFacts: {
              opportunityId: row.id,
              value: row.value,
              lastContactAt: row.lastContactAt,
              stageSince: row.createdAt,
              crop: row.crop,
              products: row.productOffered ? [row.productOffered] : [],
              lastPurchaseDate: resolvePurchaseDate(row.client)
            }
          }
        : {})
    }));
    return { total, newCount, items };
  };

  const data: DailySummaryData = { sellerName: seller.name, dayKey, sections: {} };
  if (sections.reactivations) {
    data.sections.reactivations = await section([open, inactiveRecentAutomationOpportunityWhere], [{ createdAt: "desc" }], true);
  }
  if (sections.newOpportunities) {
    data.sections.newOpportunities = await section([{ createdAt: { gte: since } }, { NOT: inactiveRecentAutomationOpportunityWhere }], [{ createdAt: "desc" }]);
  }
  if (sections.overdueFollowUps) {
    data.sections.overdueFollowUps = await section([open, { followUpDate: { lt: todayStart } }], [{ followUpDate: "asc" }]);
  }
  if (sections.todayFollowUps) {
    data.sections.todayFollowUps = await section([open, { followUpDate: { gte: todayStart, lt: tomorrowStart } }], [{ followUpDate: "asc" }]);
  }
  if (options.tipFacts) await completeTipFacts(data, db);
  return data;
}

/** Produtos dos itens e última troca de etapa registrada das oportunidades listadas. */
async function completeTipFacts(data: DailySummaryData, db: SummaryDb) {
  const facts: DailySummaryTipFacts[] = [];
  for (const section of Object.values(data.sections)) for (const item of section?.items ?? []) if (item.tipFacts) facts.push(item.tipFacts);
  const ids = [...new Set(facts.map((fact) => fact.opportunityId))];
  if (!ids.length) return;
  const [lines, stageChanges] = await Promise.all([
    db.opportunityItem.findMany({ where: { opportunityId: { in: ids } }, orderBy: [{ lineNumber: "asc" }], select: { opportunityId: true, productNameSnapshot: true } }),
    db.opportunityChangeLog.findMany({ where: { opportunityId: { in: ids }, field: "stage" }, orderBy: [{ createdAt: "desc" }], select: { opportunityId: true, createdAt: true } })
  ]);
  const lastStageChange = new Map<string, Date>();
  for (const change of stageChanges) if (!lastStageChange.has(change.opportunityId)) lastStageChange.set(change.opportunityId, change.createdAt);
  for (const fact of facts) {
    fact.products.push(...lines.filter((line) => line.opportunityId === fact.opportunityId).map((line) => line.productNameSnapshot));
    fact.stageSince = lastStageChange.get(fact.opportunityId) ?? fact.stageSince;
  }
}

export type DailySummaryMessage = { text: string | null; tips: WhatsAppDailySummaryTipsStatus };

/**
 * Texto do resumo do vendedor (link do CRM pelo FRONTEND_URL), ou null quando não há nada a enviar. Com as dicas
 * ligadas e itens no resumo, pede as dicas à IA; sem dicas (qualquer motivo), o texto sai igual, sem o bloco.
 */
export async function buildDailySummaryMessage(
  seller: { id: string; name: string },
  config: WhatsAppDailySummaryConfig,
  now: Date,
  tips: DailySummaryTipsContext,
  deps: { db?: SummaryDb; generateTips?: typeof generateDailySummaryTips } = {}
): Promise<DailySummaryMessage> {
  const data = await loadDailySummaryData(seller, config.sections, now, deps.db ?? defaultPrisma, { tipFacts: config.managerTips });
  const crmUrl = env.frontendUrl || null;
  const text = formatDailySummary(data, { crmUrl });
  if (!config.managerTips) return { text, tips: "off" };
  if (text === null) return { text, tips: "no_summary" };
  const result = await (deps.generateTips ?? generateDailySummaryTips)(data, now, { ...tips, model: config.managerTipsModel });
  return { text: result.tips.length ? formatDailySummary(data, { crmUrl, managerTips: result.tips }) : text, tips: result.status };
}
