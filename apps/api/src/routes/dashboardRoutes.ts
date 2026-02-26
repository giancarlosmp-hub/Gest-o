import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { sellerWhere } from "../utils/access.js";

const router = Router();
router.use(authMiddleware);

const getMonthRange = (month: string) => {
  const [year, monthN] = month.split("-").map(Number);
  const start = new Date(year, monthN - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, monthN, 0, 23, 59, 59, 999);
  return { start, end };
};

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
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const { start, end } = getMonthRange(month);
  const whereSale = getSellerSalesFilter(req);
  const whereOwner = sellerWhere(req);

  const [sales, opportunities, newLeads, goals, users, recentActivities] = await Promise.all([
    prisma.sale.findMany({ where: { ...whereSale, date: { gte: start, lte: end } } }),
    prisma.opportunity.findMany({ where: { ...whereOwner, createdAt: { gte: start, lte: end } } }),
    prisma.client.count({ where: { ...whereOwner, createdAt: { gte: start, lte: end } } }),
    prisma.goal.findMany({ where: { month, ...(req.user!.role === "vendedor" ? { sellerId: req.user!.id } : whereSale) } }),
    prisma.user.findMany({ where: req.user!.role === "vendedor" ? { id: req.user!.id } : { role: "vendedor", ...(whereSale.sellerId ? { id: whereSale.sellerId } : {}) } }),
    prisma.activity.findMany({ where: whereOwner, take: 8, orderBy: { createdAt: "desc" } })
  ]);

  const salesBySeller = await prisma.sale.groupBy({
    by: ["sellerId"],
    where: { ...whereSale, date: { gte: start, lte: end } },
    _sum: { value: true },
    _count: { _all: true }
  });

  const totalRevenue = sales.reduce((acc, sale) => acc + sale.value, 0);
  const totalSales = sales.length;
  const wonCount = opportunities.filter((opportunity) => opportunity.stage === "ganho").length;
  const conversionRate = opportunities.length ? (wonCount / opportunities.length) * 100 : 0;
  const objectiveTotal = goals.reduce((acc, goal) => acc + goal.targetValue, 0);

  const performance = users
    .map((user) => {
      const sellerSales = salesBySeller.find((row) => row.sellerId === user.id);
      const sellerObjective = goals.find((goal) => goal.sellerId === user.id)?.targetValue || 0;
      const revenue = sellerSales?._sum.value || 0;
      const salesCount = sellerSales?._count._all || 0;
      const denominator = sellerObjective || objectiveTotal || 0;
      return {
        sellerId: user.id,
        seller: user.name,
        sales: salesCount,
        revenue,
        objective: sellerObjective,
        realizedPercent: denominator > 0 ? (revenue / denominator) * 100 : 0
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  res.json({
    totalRevenue,
    totalSales,
    newLeads,
    conversionRate,
    objectiveTotal,
    performance,
    recentActivities
  });
});

router.get("/sales-series", async (req, res) => {
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const [year, monthN] = month.split("-").map(Number);
  const { start, end } = getMonthRange(month);
  const whereSale = getSellerSalesFilter(req);

  const [sales, goals] = await Promise.all([
    prisma.sale.findMany({ where: { ...whereSale, date: { gte: start, lte: end } }, orderBy: { date: "asc" } }),
    prisma.goal.findMany({ where: { month, ...(req.user!.role === "vendedor" ? { sellerId: req.user!.id } : whereSale) } })
  ]);

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

    const realizedOfDay = sales
      .filter((sale) => sale.date.getDate() === day)
      .reduce((acc, sale) => acc + sale.value, 0);
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
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const { end } = getMonthRange(month);
  const whereOwner = sellerWhere(req);

  const windowStart = new Date(end);
  windowStart.setDate(end.getDate() - 89);

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const [clients, wonOpportunities, recentWonOpportunities, soldTodayData] = await Promise.all([
    prisma.client.findMany({ where: whereOwner, select: { id: true, name: true } }),
    prisma.opportunity.findMany({
      where: { ...whereOwner, stage: "ganho", proposalDate: { lte: end } },
      select: { clientId: true, value: true, proposalDate: true }
    }),
    prisma.opportunity.findMany({
      where: { ...whereOwner, stage: "ganho", proposalDate: { gte: windowStart, lte: end } },
      select: { clientId: true, value: true }
    }),
    prisma.sale.aggregate({
      where: {
        ...(req.user!.role === "vendedor" ? { sellerId: req.user!.id } : (req.query.sellerId ? { sellerId: req.query.sellerId as string } : {})),
        date: { gte: todayStart, lte: todayEnd }
      },
      _sum: { value: true }
    })
  ]);

  const lastSaleByClient = new Map<string, Date>();
  for (const opportunity of wonOpportunities) {
    const currentDate = lastSaleByClient.get(opportunity.clientId);
    if (!currentDate || opportunity.proposalDate > currentDate) {
      lastSaleByClient.set(opportunity.clientId, opportunity.proposalDate);
    }
  }

  const walletStatus = { active: 0, inactiveRecent: 0, inactiveOld: 0 };
  for (const client of clients) {
    const lastSaleDate = lastSaleByClient.get(client.id);
    if (!lastSaleDate) {
      walletStatus.inactiveOld += 1;
      continue;
    }

    const diffDays = Math.floor((end.getTime() - lastSaleDate.getTime()) / 86400000);
    if (diffDays <= 30) walletStatus.active += 1;
    else if (diffDays <= 90) walletStatus.inactiveRecent += 1;
    else walletStatus.inactiveOld += 1;
  }

  const revenueByClient = new Map<string, number>();
  for (const opportunity of recentWonOpportunities) {
    revenueByClient.set(opportunity.clientId, (revenueByClient.get(opportunity.clientId) || 0) + opportunity.value);
  }

  const sortedRevenue = [...revenueByClient.entries()].sort((a, b) => b[1] - a[1]);
  const totalRevenue = sortedRevenue.reduce((acc, [, value]) => acc + value, 0);
  const abcAccumulator = {
    A: { clients: 0, revenue: 0 },
    B: { clients: 0, revenue: 0 },
    C: { clients: 0, revenue: 0 }
  };

  const totalClientsWithRevenue = sortedRevenue.length;
  const limitA = Math.ceil(totalClientsWithRevenue * 0.2);
  const limitB = Math.ceil(totalClientsWithRevenue * 0.5);

  sortedRevenue.forEach(([, revenue], index) => {
    if (index < limitA) {
      abcAccumulator.A.clients += 1;
      abcAccumulator.A.revenue += revenue;
    } else if (index < limitB) {
      abcAccumulator.B.clients += 1;
      abcAccumulator.B.revenue += revenue;
    } else {
      abcAccumulator.C.clients += 1;
      abcAccumulator.C.revenue += revenue;
    }
  });

  const zeroRevenueClients = clients.length - sortedRevenue.length;
  if (zeroRevenueClients > 0) abcAccumulator.C.clients += zeroRevenueClients;

  res.json({
    walletStatus,
    abcCurve: {
      A: {
        clients: abcAccumulator.A.clients,
        percentRevenue: totalRevenue > 0 ? (abcAccumulator.A.revenue / totalRevenue) * 100 : 0
      },
      B: {
        clients: abcAccumulator.B.clients,
        percentRevenue: totalRevenue > 0 ? (abcAccumulator.B.revenue / totalRevenue) * 100 : 0
      },
      C: {
        clients: abcAccumulator.C.clients,
        percentRevenue: totalRevenue > 0 ? (abcAccumulator.C.revenue / totalRevenue) * 100 : 0
      }
    },
    totalClients: clients.length,
    soldToday: soldTodayData._sum.value || 0
  });
});

export default router;
