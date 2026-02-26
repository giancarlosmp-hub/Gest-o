import { formatDateBR } from "./formatters";

type SellerLite = {
  id: string;
};

type OpportunityLite = {
  value?: number;
  stage?: string;
  ownerSellerId?: string;
  expectedCloseDate?: string;
  proposalDate?: string;
};

type ActivityLite = {
  ownerSellerId?: string;
  createdAt?: string;
};

export type SellerCardMetrics = {
  monthlyRevenue: number;
  openOpportunities: number;
  openPipelineValue: number;
  lastActivityLabel: string;
  progressPercent: number;
  objectiveAmount: number;
  isRevenueEstimated: boolean;
};

const CLOSED_STAGES = new Set(["ganho", "perdido"]);
const WON_STAGE = "ganho";

export const getCurrentMonthKey = () => new Date().toISOString().slice(0, 7);

const belongsToMonth = (value: string | undefined, monthKey: string) => {
  if (!value) return false;
  return value.slice(0, 7) === monthKey;
};

const asDate = (value?: string) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export function buildSellerMetrics(
  users: SellerLite[],
  opportunities: OpportunityLite[],
  activities: ActivityLite[],
  objectivesBySeller: Record<string, number>,
  monthKey = getCurrentMonthKey()
): Record<string, SellerCardMetrics> {
  const result: Record<string, SellerCardMetrics> = {};

  for (const user of users) {
    const sellerOpportunities = opportunities.filter((item) => item.ownerSellerId === user.id);
    const openOpportunities = sellerOpportunities.filter((item) => !CLOSED_STAGES.has(item.stage || ""));
    const wonCurrentMonth = sellerOpportunities.filter(
      (item) => item.stage === WON_STAGE && (belongsToMonth(item.expectedCloseDate, monthKey) || belongsToMonth(item.proposalDate, monthKey))
    );

    const monthlyRevenue = wonCurrentMonth.reduce((sum, item) => sum + Number(item.value || 0), 0);
    const openPipelineValue = openOpportunities.reduce((sum, item) => sum + Number(item.value || 0), 0);

    const estimatedRevenue = monthlyRevenue > 0 ? monthlyRevenue : openPipelineValue * 0.25;
    const isRevenueEstimated = monthlyRevenue <= 0;

    const latestActivity = activities
      .filter((item) => item.ownerSellerId === user.id)
      .map((item) => asDate(item.createdAt))
      .filter((item): item is Date => Boolean(item))
      .sort((a, b) => b.getTime() - a.getTime())[0];

    const objectiveAmount = objectivesBySeller[user.id] ?? 0;
    const progressPercent = objectiveAmount > 0 ? (estimatedRevenue / objectiveAmount) * 100 : 0;

    result[user.id] = {
      monthlyRevenue: estimatedRevenue,
      openOpportunities: openOpportunities.length,
      openPipelineValue,
      lastActivityLabel: latestActivity ? formatDateBR(latestActivity) : "Sem atividades",
      progressPercent,
      objectiveAmount,
      isRevenueEstimated
    };
  }

  return result;
}
