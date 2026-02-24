import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { sellerWhere } from "../utils/access.js";

const router = Router();
router.use(authMiddleware);

router.get("/summary", async (req, res) => {
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const [year, monthN] = month.split("-").map(Number);
  const start = new Date(year, monthN - 1, 1);
  const end = new Date(year, monthN, 0, 23, 59, 59);
  const whereSale = req.user!.role === "vendedor" ? { sellerId: req.user!.id } : req.query.sellerId ? { sellerId: req.query.sellerId as string } : {};

  const [sales, opps, leads, goals, users, recentActivities] = await Promise.all([
    prisma.sale.findMany({ where: { ...whereSale, date: { gte: start, lte: end } } }),
    prisma.opportunity.findMany({ where: { ...sellerWhere(req), createdAt: { gte: start, lte: end } } }),
    prisma.client.count({ where: { ...sellerWhere(req), createdAt: { gte: start, lte: end } } }),
    prisma.goal.findMany({ where: { month, ...(req.user!.role === "vendedor" ? { sellerId: req.user!.id } : {}) } }),
    prisma.user.findMany({ where: req.user!.role === "vendedor" ? { id: req.user!.id } : { role: "vendedor" } }),
    prisma.activity.findMany({ where: sellerWhere(req), take: 8, orderBy: { createdAt: "desc" } })
  ]);

  const totalRevenue = sales.reduce((acc: number, sale: any) => acc + sale.value, 0);
  const totalSales = sales.length;
  const conversionRate = opps.length ? (opps.filter((opp: any) => opp.stage === "ganho").length / opps.length) * 100 : 0;
  const goalTotal = goals.reduce((acc: number, goal: any) => acc + goal.targetValue, 0);

  const sellerPerf = await Promise.all(
    users.map(async (user: any) => {
      const sellerSales = await prisma.sale.findMany({ where: { sellerId: user.id, date: { gte: start, lte: end } } });
      const revenue = sellerSales.reduce((acc: number, sale: any) => acc + sale.value, 0);
      const sellerGoal = goals.find((goal: any) => goal.sellerId === user.id)?.targetValue || 0;
      return { sellerId: user.id, seller: user.name, sales: sellerSales.length, revenue, target: sellerGoal, percent: sellerGoal ? (revenue / sellerGoal) * 100 : 0 };
    })
  );

  sellerPerf.sort((a, b) => b.revenue - a.revenue);
  res.json({ totalRevenue, totalSales, newLeads: leads, conversionRate, goalTotal, performance: sellerPerf, recentActivities });
});

router.get("/sales-series", async (req, res) => {
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const [year, monthN] = month.split("-").map(Number);
  const lastDay = new Date(year, monthN, 0).getDate();
  const whereSale = req.user!.role === "vendedor" ? { sellerId: req.user!.id } : req.query.sellerId ? { sellerId: req.query.sellerId as string } : {};

  const sales = await prisma.sale.findMany({
    where: { ...whereSale, date: { gte: new Date(year, monthN - 1, 1), lte: new Date(year, monthN, 0, 23, 59, 59) } },
    orderBy: { date: "asc" }
  });

  const goals = await prisma.goal.findMany({ where: { month, ...(req.user!.role === "vendedor" ? { sellerId: req.user!.id } : {}) } });
  const goalTotal = goals.reduce((acc: number, goal: any) => acc + goal.targetValue, 0);
  const goalDaily = goalTotal / lastDay;

  let accumReal = 0;
  const labels: string[] = [];
  const real: number[] = [];
  const target: number[] = [];

  for (let day = 1; day <= lastDay; day++) {
    labels.push(String(day));
    const daySum = sales.filter((sale: any) => sale.date.getDate() === day).reduce((acc: number, sale: any) => acc + sale.value, 0);
    accumReal += daySum;
    real.push(accumReal);
    target.push(goalDaily * day);
  }

  res.json({ labels, real, target, goalTotal, realizedTotal: accumReal });
});

export default router;
