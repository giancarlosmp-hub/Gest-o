import { Router } from "express";
import { isVisibleInRanking, rankingSellerName, type AbcClass, type PortfolioStatus } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { appUsageRateLimit } from "../middlewares/rateLimit.js";
import { sellerWhere } from "../utils/access.js";
import { loadEffectiveWonContributions } from "../services/effectiveWins.js";
import { loadClientAbcCurve } from "../services/clientAbcCurve.js";
import { loadLastSentCrmOrderByClient, portfolioStatusOf } from "../services/clientPortfolioStatus.js";
import { brazilDayKeyOf, brazilDayRange, brazilTodayKey, calendarDayRange, monthDayBounds } from "../utils/dateRange.js";
import { closedOpportunityPeriodWhere } from "../utils/periodFilters.js";

const router = Router();
router.use(authMiddleware);
router.use(appUsageRateLimit);

// Mês em dias de Brasília, com o mesmo recorte dos filtros de período dos relatórios
// (closedOpportunityPeriodWhere), para "Faturamento no mês" e "Total ganho" não divergirem.
const resolveMonth = (raw: unknown) => {
  const month = typeof raw === "string" && raw ? raw : brazilTodayKey().slice(0, 7);
  return { month, period: monthDayBounds(month) };
};
const INVALID_MONTH = { message: "month deve estar no formato YYYY-MM" };

const isBusinessDay = (date: Date) => {
  const day = date.getDay();
  return day >= 1 && day <= 5;
};

const getBusinessDaysOfMonth = (year: number, monthN: number) => {
  const businessDays: number[] = [];
  const lastDay = new Date(year, monthN, 0).getDate();
  for (let day = 1; day <= lastDay; day += 1) {
    const current = new Date(year, monthN - 1, day);
    if (isBusinessDay(current)) businessDays.push(day);
  }
  return businessDays;
};

const getSellerSalesFilter = (req: any) => {
  if (req.user!.role === "vendedor") return { sellerId: req.user!.id };
  return req.query.sellerId ? { sellerId: req.query.sellerId as string } : {};
};

router.get("/summary", async (req, res) => {
  const { month, period } = resolveMonth(req.query.month);
  if (!period) return res.status(400).json(INVALID_MONTH);
  const whereSale = getSellerSalesFilter(req);
  const whereOwner = sellerWhere(req);
  const shouldLogDashboardDiagnostics = process.env.NODE_ENV !== "production";
  const wonWhere = {
    ...whereOwner,
    stage: "ganho" as const,
    ...closedOpportunityPeriodWhere(period.from, period.to)
  };
  const lostWhere = {
    ...whereOwner,
    stage: "perdido" as const,
    ...closedOpportunityPeriodWhere(period.from, period.to)
  };

  const [wonOpportunities, lostOpportunities, openOpportunities, newLeads, goals, users, recentActivities] = await Promise.all([
    prisma.opportunity.findMany({
      where: wonWhere,
      select: {
        id: true,
        title: true,
        stage: true,
        value: true,
        closedAt: true,
        expectedCloseDate: true,
        proposalDate: true,
        ownerSellerId: true,
        ownerSeller: { select: { name: true } },
        client: { select: { tenantId: true } }
      }
    }),
    prisma.opportunity.findMany({
      where: lostWhere,
      select: {
        id: true,
        title: true,
        stage: true,
        value: true,
        closedAt: true,
        expectedCloseDate: true,
        proposalDate: true,
        ownerSellerId: true,
        ownerSeller: { select: { name: true } }
      }
    }),
    prisma.opportunity.findMany({
      where: {
        ...whereOwner,
        stage: { notIn: ["ganho", "perdido"] },
        expectedCloseDate: calendarDayRange(period.from, period.to)!
      }
    }),
    prisma.client.count({ where: { ...whereOwner, isArchived: false, createdAt: brazilDayRange(period.from, period.to)! } }),
    prisma.goal.findMany({ where: { month, ...(req.user!.role === "vendedor" ? { sellerId: req.user!.id } : whereSale) } }),
    prisma.user.findMany({ where: req.user!.role === "vendedor" ? { id: req.user!.id } : { role: "vendedor", ...(whereSale.sellerId ? { id: whereSale.sellerId } : {}) } }),
    prisma.activity.findMany({ where: whereOwner, take: 8, orderBy: { createdAt: "desc" } })
  ]);

  const effectiveWinStates = await loadEffectiveWonContributions(wonOpportunities);
  const salesBySeller = wonOpportunities.reduce<Record<string, { revenue: number; sales: number }>>((acc, opportunity) => {
    if (!acc[opportunity.ownerSellerId]) acc[opportunity.ownerSellerId] = { revenue: 0, sales: 0 };
    const effective = effectiveWinStates.get(opportunity.id)!;
    acc[opportunity.ownerSellerId].revenue += effective.value;
    acc[opportunity.ownerSellerId].sales += effective.count;
    return acc;
  }, {});

  const effectiveWins = wonOpportunities.map((opportunity) => effectiveWinStates.get(opportunity.id)!);
  const totalRevenue = effectiveWins.reduce((acc, state) => acc + state.value, 0);
  const totalSales = effectiveWins.reduce((acc, opportunity) => acc + opportunity.count, 0);
  const lostSales = lostOpportunities.length;
  const conversionRate = totalSales + lostSales > 0
    ? (totalSales / (totalSales + lostSales)) * 100
    : 0;
  const counts = {
    open: openOpportunities.length,
    won: totalSales,
    lost: lostSales
  };
  const totals = {
    openValue: openOpportunities.reduce((acc, opportunity) => acc + opportunity.value, 0),
    wonValue: totalRevenue,
    lostValue: lostOpportunities.reduce((acc, opportunity) => acc + opportunity.value, 0)
  };
  const objectiveTotal = goals.reduce((acc, goal) => acc + goal.targetValue, 0);

  const performance = users
    .filter((user) => isVisibleInRanking(user.isActive, salesBySeller[user.id]?.revenue || 0))
    .map((user) => {
      const sellerSales = salesBySeller[user.id];
      const sellerObjective = goals.find((goal) => goal.sellerId === user.id)?.targetValue || 0;
      const revenue = sellerSales?.revenue || 0;
      const salesCount = sellerSales?.sales || 0;
      const denominator = sellerObjective || objectiveTotal || 0;
      return {
        sellerId: user.id,
        seller: rankingSellerName(user.name, user.isActive),
        sales: salesCount,
        revenue,
        objective: sellerObjective,
        realizedPercent: denominator > 0 ? (revenue / denominator) * 100 : 0
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  if (shouldLogDashboardDiagnostics) {
    const summarize = (opportunity: any) => ({
      id: opportunity.id,
      title: opportunity.title,
      stage: opportunity.stage,
      value: opportunity.value,
      closedAt: opportunity.closedAt?.toISOString() || null,
      expectedCloseDate: opportunity.expectedCloseDate?.toISOString() || null,
      proposalDate: opportunity.proposalDate?.toISOString() || null,
      sellerId: opportunity.ownerSellerId,
      sellerName: opportunity.ownerSeller?.name || null
    });
    console.info("[diag-dashboard][summary]", {
      endpoint: "/dashboard/summary",
      userId: req.user?.id,
      role: req.user?.role,
      month,
      wonWhere,
      lostWhere,
      wonCount: wonOpportunities.length,
      lostCount: lostOpportunities.length,
      wonTotalValue: totalRevenue,
      lostTotalValue: lostOpportunities.reduce((acc, opportunity) => acc + opportunity.value, 0),
      wonOpportunities: wonOpportunities.slice(0, 50).map(summarize),
      lostOpportunities: lostOpportunities.slice(0, 50).map(summarize)
    });
  }

  res.json({
    totalRevenue,
    totalSales,
    newLeads,
    conversionRate,
    counts,
    totals,
    objectiveTotal,
    performance,
    recentActivities
  });
});

router.get("/sales-series", async (req, res) => {
  const { month, period } = resolveMonth(req.query.month);
  if (!period) return res.status(400).json(INVALID_MONTH);
  const [year, monthN] = month.split("-").map(Number);
  const whereSale = getSellerSalesFilter(req);

  const whereOwner = sellerWhere(req);

  const [wonOpportunities, goals] = await Promise.all([
    prisma.opportunity.findMany({
      where: {
        ...whereOwner,
        stage: "ganho",
        ...closedOpportunityPeriodWhere(period.from, period.to)
      },
      orderBy: [{ closedAt: "asc" }, { expectedCloseDate: "asc" }],
      select: { id: true, client: { select: { tenantId: true } }, value: true, closedAt: true, expectedCloseDate: true }
    }),
    prisma.goal.findMany({ where: { month, ...(req.user!.role === "vendedor" ? { sellerId: req.user!.id } : whereSale) } })
  ]);

  const seriesEffectiveWins = await loadEffectiveWonContributions(wonOpportunities);
  const objectiveTotal = goals.reduce((acc, goal) => acc + goal.targetValue, 0);
  const businessDays = getBusinessDaysOfMonth(year, monthN);
  const objectiveByDay = new Map<number, number>();
  const objectivePerBusinessDay = businessDays.length > 0 ? objectiveTotal / businessDays.length : 0;
  for (const day of businessDays) {
    objectiveByDay.set(day, objectivePerBusinessDay);
  }

  const lastDay = new Date(year, monthN, 0).getDate();
  const realizedDaily: number[] = [];
  const objectiveDaily: number[] = [];
  const realizedAccumulated: number[] = [];
  const objectiveAccumulated: number[] = [];
  const labels: string[] = [];

  let realizedRunning = 0;
  let objectiveRunning = 0;

  for (let day = 1; day <= lastDay; day += 1) {
    labels.push(String(day));

    const realizedOfDay = wonOpportunities
      // Mesmo dia usado no filtro: closedAt no dia de Brasília, previsão pelo dia de calendário.
      .filter((opportunity) => Number((opportunity.closedAt ? brazilDayKeyOf(opportunity.closedAt) : opportunity.expectedCloseDate.toISOString()).slice(8, 10)) === day)
      .reduce((acc, opportunity) => acc + seriesEffectiveWins.get(opportunity.id)!.value, 0);
    const objectiveOfDay = objectiveByDay.get(day) || 0;

    realizedRunning += realizedOfDay;
    objectiveRunning += objectiveOfDay;

    realizedDaily.push(realizedOfDay);
    objectiveDaily.push(objectiveOfDay);
    realizedAccumulated.push(realizedRunning);
    objectiveAccumulated.push(objectiveRunning);
  }

  res.json({
    labels,
    realizedDaily,
    realizedAccumulated,
    objectiveDaily,
    objectiveAccumulated,
    objectiveTotal,
    realizedTotal: realizedRunning,
    // compatibilidade
    goalTotal: objectiveTotal,
    real: realizedAccumulated,
    target: objectiveAccumulated
  });
});

router.get("/portfolio", async (req, res) => {
  const { period } = resolveMonth(req.query.month);
  if (!period) return res.status(400).json(INVALID_MONTH);
  const whereOwner = sellerWhere(req);
  const today = brazilTodayKey();
  const portfolioClientWhere = { ...whereOwner, isArchived: false };

  // Curva ABC: 90 dias até o fim do mês escolhido, nunca depois de hoje (no mês atual bate com a lista de clientes).
  const abcEndDay = period.to < today ? period.to : today;

  const [clients, lastSentCrmOrderByClient, abcCurve, soldTodayData] = await Promise.all([
    prisma.client.findMany({ where: portfolioClientWhere, select: { id: true, name: true, lastPurchaseDate: true, financialProfile: true } }),
    loadLastSentCrmOrderByClient(portfolioClientWhere),
    loadClientAbcCurve(portfolioClientWhere, abcEndDay),
    prisma.opportunity.findMany({
      where: {
        ...whereOwner,
        stage: "ganho",
        ...closedOpportunityPeriodWhere(today, today)
      },
      select: { id: true, client: { select: { tenantId: true } }, value: true }
    })
  ]);

  const soldTodayStates = await loadEffectiveWonContributions(soldTodayData);

  // A carteira é a situação de hoje: a data de compra do ERP não tem histórico por mês.
  const now = new Date();
  const walletStatus: Record<PortfolioStatus, number> = { ativo: 0, inativoRecente: 0, exCliente: 0, prospect: 0 };
  for (const client of clients) {
    walletStatus[portfolioStatusOf(client, lastSentCrmOrderByClient, now)] += 1;
  }

  const abcClients: Record<AbcClass, number> = { A: 0, B: 0, C: 0 };
  for (const abcClass of abcCurve.classByClient.values()) abcClients[abcClass] += 1;
  const abcSegment = (abcClass: AbcClass) => ({
    clients: abcClients[abcClass],
    percentRevenue: abcCurve.totalRevenue > 0 ? (abcCurve.revenueByClass[abcClass] / abcCurve.totalRevenue) * 100 : 0
  });

  res.json({
    walletStatus,
    abcCurve: { A: abcSegment("A"), B: abcSegment("B"), C: abcSegment("C") },
    totalClients: clients.length,
    soldToday: soldTodayData.reduce((sum, opportunity) => sum + soldTodayStates.get(opportunity.id)!.value, 0)
  });
});

export default router;
