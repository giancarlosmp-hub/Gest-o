import { OpportunityStage, type Prisma } from "@prisma/client";
import { WHATSAPP_DAILY_SUMMARY_MAX_ITEMS_PER_SECTION, type WhatsAppDailySummarySections } from "@salesforce-pro/shared";
import { env } from "../../config/env.js";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { inactiveRecentAutomationOpportunityWhere } from "../commercialAutomationsService.js";
import { formatDailySummary, type DailySummaryData, type DailySummaryItem, type DailySummarySection } from "./dailySummaryFormat.js";

// WhatsApp Fase D: o que entra no resumo de um vendedor. Só oportunidades dele (ownerSellerId), de cliente
// não arquivado:
// - reativações abertas (automação de inativos recentes), as das últimas 24 h destacadas;
// - oportunidades lançadas nas últimas 24 h (sem as da automação, que já estão acima);
// - follow-ups vencidos e de hoje, em etapa aberta. O follow-up é gravado como o dia às 00:00 UTC; "hoje" é o
//   dia de Brasília.
// No máximo WHATSAPP_DAILY_SUMMARY_MAX_ITEMS_PER_SECTION itens por seção, mais o total.

const OPEN_STAGES = [OpportunityStage.prospeccao, OpportunityStage.negociacao, OpportunityStage.proposta];
const DAY_MS = 86_400_000;
const BRAZIL_UTC_OFFSET_MS = 3 * 3_600_000;

/** Dia de Brasília (AAAA-MM-DD); Brasília está em UTC-3 fixo. */
export const brazilDayKeyOf = (instant: Date) => new Date(instant.getTime() - BRAZIL_UTC_OFFSET_MS).toISOString().slice(0, 10);

const itemSelect = {
  createdAt: true,
  stage: true,
  followUpDate: true,
  client: { select: { name: true, city: true, state: true } }
} satisfies Prisma.OpportunitySelect;

type SummaryDb = Pick<typeof defaultPrisma, "opportunity">;

export async function loadDailySummaryData(
  seller: { id: string; name: string },
  sections: WhatsAppDailySummarySections,
  now: Date,
  db: SummaryDb = defaultPrisma
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
      isNew: row.createdAt.getTime() >= since.getTime()
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
  return data;
}

/** Texto do resumo do vendedor (link do CRM pelo FRONTEND_URL), ou null quando não há nada a enviar. */
export async function buildDailySummaryText(
  seller: { id: string; name: string },
  sections: WhatsAppDailySummarySections,
  now: Date,
  db: SummaryDb = defaultPrisma
): Promise<string | null> {
  const data = await loadDailySummaryData(seller, sections, now, db);
  return formatDailySummary(data, { crmUrl: env.frontendUrl || null });
}
