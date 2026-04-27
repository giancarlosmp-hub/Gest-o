import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Doughnut, Line } from "react-chartjs-2";
import { Link, useNavigate } from "react-router-dom";
import {
  type ActiveElement,
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  type ChartEvent,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartOptions,
  type ChartType,
  type Plugin,
} from "chart.js";
import type {
  DashboardPortfolio,
  DashboardSalesSeries,
  DashboardSummary,
  WeeklyHighlightItem,
  WeeklyHighlights,
} from "@salesforce-pro/shared";

import api from "../lib/apiClient";
import {
  formatCompactNumberBR,
  formatCurrencyBRL,
  formatNumberBR,
  formatPercentBR,
} from "../lib/formatters";
import { useAuth } from "../context/AuthContext";
import { DASHBOARD_REFRESH_EVENT } from "../lib/dashboardRefresh";
import { normalizeActivityType, toLabel } from "../constants/activityTypes";
import DonutLegendChips from "../components/DonutLegendChips";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Tooltip,
  Legend
);

type SellerOption = { id: string; name: string; role: string };

type ActivityKpi = {
  sellerId: string;
  type: string;
  targetValue: number;
  logicalCount?: number;
  seller?: { id: string; name: string };
};

type Activity = {
  id: string;
  type: string;
  ownerSellerId: string;
  createdAt: string;
  dueDate: string;
  date?: string;
  done?: boolean;
};

type ActivityTypeSummary = {
  type: string;
  target: number;
  realized: number;
  reachedPercent: number;
  requiredDailyAverage: number;
};


type WeeklyHighlightCard = {
  key: string;
  title: string;
  highlight: WeeklyHighlightItem | null;
  formatter: (value: number) => string;
};

type DisciplineRankingItem = {
  sellerId: string;
  sellerName: string;
  planned: number;
  executed: number;
  executionRate: number;
  punctualRate: number;
  followUpRate: number;
  disciplineScoreBase: number;
  volumeFactor: number;
  disciplineScoreFinal: number;
  disciplineScore: number;
  isUnderExecutionThreshold: boolean;
  hasInactivityFlag: boolean;
};

type ConsistencyLevel = "alta" | "media" | "baixa";

type ConsistencyRankingItem = {
  position: number;
  sellerId: string;
  sellerName: string;
  averageScore: number;
  metaHitRate: number;
  stdDevResult: number;
  stability: number;
  consistencyScore: number;
  consistencyLevel: ConsistencyLevel;
};

type ConsistencyResponse = {
  period: { months: string[] };
  ranking: ConsistencyRankingItem[];
};

type MonthlyScoreItem = {
  userId: string;
  name: string;
  role: string;
  faturadoMes: number;
  objetivoMes: number;
  atingimentoPercent: number;
  pipelinePonderado: number;
  score: number;
  rank: number;
};

type MonthlyScoreResponse = {
  month: string;
  items: MonthlyScoreItem[];
};

const palette = {
  primary: "#0B3C1D",
  success: "#2f9e44",
  warning: "#f59e0b",
  danger: "#ca8a04",
  info: "#348A4F",
  textMuted: "#4b5563",
  border: "#d1d5db",
  surface: "#ffffff",
  rest: "#8CC49B",
  grid: "rgba(15, 23, 42, 0.08)",
};

const dashboardStatusColors = {
  positive: "#16a34a",
  attention: "#eab308",
  negative: "#dc2626",
};

const donutSegmentColors = [
  dashboardStatusColors.positive,
  dashboardStatusColors.attention,
  dashboardStatusColors.negative,
];

const cardClass = "dashboard-card-enter rounded-xl border border-slate-200 bg-white p-4 shadow-sm";
const doughnutContainerClass = "mx-auto flex h-[200px] w-full max-w-[200px] items-center justify-center sm:h-[240px] sm:max-w-[240px]";

type DoughnutCenterTextOptions = {
  label: string;
  value: string;
};

declare module "chart.js" {
  interface PluginOptionsByType<TType extends ChartType> {
    doughnutCenterText?: DoughnutCenterTextOptions;
  }
}

const doughnutCenterTextPlugin: Plugin<"doughnut"> = {
  id: "doughnutCenterText",
  afterDraw: (chart, _, options) => {
    const centerText = options as DoughnutCenterTextOptions | undefined;
    if (!centerText?.label || !centerText?.value) return;

    const meta = chart.getDatasetMeta(0);
    const firstArc = meta?.data?.[0];
    if (!firstArc) return;

    const { x, y, innerRadius } = firstArc as unknown as { x: number; y: number; innerRadius: number };
    const labelFontSize = Math.max(Math.round(innerRadius * 0.2), 11);
    const valueFontSize = Math.max(Math.round(innerRadius * 0.32), 14);

    const ctx = chart.ctx;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#64748b";
    ctx.font = `500 ${labelFontSize}px Inter, system-ui, sans-serif`;
    ctx.fillText(centerText.label, x, y - valueFontSize * 0.5);

    ctx.fillStyle = "#0f172a";
    ctx.font = `700 ${valueFontSize}px Inter, system-ui, sans-serif`;
    ctx.fillText(centerText.value, x, y + valueFontSize * 0.55);
    ctx.restore();
  },
};

const getCurrentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

const getCurrentWeekStart = () => {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  const local = new Date(monday.getTime() - monday.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

const getBusinessDaysRemaining = (month: string) => {
  const [year, monthN] = month.split("-").map(Number);
  const now = new Date();
  const sameMonth = now.getFullYear() === year && now.getMonth() + 1 === monthN;
  const startDay = sameMonth ? now.getDate() : 1;
  const lastDay = new Date(year, monthN, 0).getDate();

  let count = 0;
  for (let day = startDay; day <= lastDay; day += 1) {
    const date = new Date(year, monthN - 1, day);
    const weekDay = date.getDay();
    if (weekDay >= 1 && weekDay <= 5) count += 1;
  }
  return count;
};

const clampPercent = (value: number) => Math.max(0, Math.min(value, 100));
const clampFiniteNonNegative = (value: number) => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(value, 0);
};

const formatKpiValue = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number" && !Number.isFinite(value)) return "—";
  if (typeof value === "string" && value.trim() === "") return "—";
  return String(value);
};

type RealizedTrendDirection = "up" | "down" | "flat";

const getMonthDayFromLabel = (label: string): number | null => {
  const normalizedLabel = label.trim();
  if (!normalizedLabel) return null;

  if (/^\d{1,2}$/.test(normalizedLabel)) {
    const day = Number(normalizedLabel);
    return Number.isInteger(day) ? day : null;
  }

  const slashMatch = normalizedLabel.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    const day = Number(slashMatch[1]);
    return Number.isInteger(day) ? day : null;
  }

  const dateMatch = normalizedLabel.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const day = Number(dateMatch[3]);
    return Number.isInteger(day) ? day : null;
  }

  return null;
};

const getRealizedTrend = (
  labels: string[],
  realizedDaily: number[],
  referenceMonth: string
): RealizedTrendDirection => {
  const [year, month] = referenceMonth.split("-").map(Number);
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month;

  const validDailyValues = labels.reduce<number[]>((accumulator, label, index) => {
    const value = realizedDaily[index];
    if (!Number.isFinite(value)) return accumulator;

    const day = getMonthDayFromLabel(label);
    if (day !== null && isCurrentMonth && day > now.getDate()) return accumulator;

    accumulator.push(value);
    return accumulator;
  }, []);

  if (validDailyValues.length < 6) return "flat";

  const recentWindow = validDailyValues.slice(-3);
  const previousWindow = validDailyValues.slice(-6, -3);
  const recentSum = recentWindow.reduce((sum, value) => sum + value, 0);
  const previousSum = previousWindow.reduce((sum, value) => sum + value, 0);

  if (recentSum > previousSum) return "up";
  if (recentSum < previousSum) return "down";
  return "flat";
};

const getElapsedSalesDays = (labels: string[], referenceMonth: string) => {
  if (!labels.length) return 0;

  const [year, month] = referenceMonth.split("-").map(Number);
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month;

  if (!isCurrentMonth) return labels.length;

  const parsedDays = labels
    .map(getMonthDayFromLabel)
    .filter((day): day is number => Number.isInteger(day));

  if (parsedDays.length > 0) {
    return parsedDays.filter((day) => day <= now.getDate()).length;
  }

  return Math.min(now.getDate(), labels.length);
};

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [month] = useState(getCurrentMonth());
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [series, setSeries] = useState<DashboardSalesSeries | null>(null);
  const [portfolio, setPortfolio] = useState<DashboardPortfolio | null>(null);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [sellerId, setSellerId] = useState("");
  const [debouncedSellerId, setDebouncedSellerId] = useState("");
  const dashboardInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const [animatedRealizedPercent, setAnimatedRealizedPercent] = useState(0);
  const [activityKpis, setActivityKpis] = useState<ActivityKpi[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [disciplineRanking, setDisciplineRanking] = useState<DisciplineRankingItem[]>([]);
  const [weeklyDisciplineRanking, setWeeklyDisciplineRanking] = useState<DisciplineRankingItem[]>([]);
  const [weeklyHighlights, setWeeklyHighlights] = useState<WeeklyHighlights | null>(null);
  const [consistencyReport, setConsistencyReport] = useState<ConsistencyResponse | null>(null);
  const [monthlyScore, setMonthlyScore] = useState<MonthlyScoreResponse | null>(null);
  const [scoreSellerId, setScoreSellerId] = useState("");
  const [scoreSearch, setScoreSearch] = useState("");
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);

    setIsMobile(media.matches);
    media.addEventListener("change", onChange);

    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

  useEffect(() => {
    if (user?.role === "vendedor") return;
    api.get<SellerOption[]>("/users").then((response) => {
      setSellers(response.data.filter((item) => item.role === "vendedor"));
    });
  }, [user?.role]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSellerId(sellerId), 350);
    return () => window.clearTimeout(timer);
  }, [sellerId]);

  const dashboardQueryKey = useMemo(
    () => JSON.stringify({ month, sellerId: debouncedSellerId, scoreSellerId }),
    [month, debouncedSellerId, scoreSellerId]
  );

  const fetchDashboard = useCallback((signal?: AbortSignal, options?: { force?: boolean }) => {
    const querySeller = debouncedSellerId ? `&sellerId=${debouncedSellerId}` : "";
    const [year, monthN] = month.split("-").map(Number);
    const from = `${month}-01`;
    const to = `${month}-${String(new Date(year, monthN, 0).getDate()).padStart(2, "0")}`;

    const existingRequest = dashboardInFlightRef.current.get(dashboardQueryKey);
    if (existingRequest && !options?.force) return existingRequest;

    const scoreQuery = user?.role !== "vendedor" && scoreSellerId ? `&userId=${scoreSellerId}` : "";

    const request = Promise.all([
      api.get<DashboardSummary>(`/dashboard/summary?month=${month}${querySeller}`, { signal }),
      api.get<DashboardSalesSeries>(`/dashboard/sales-series?month=${month}${querySeller}`, { signal }),
      api.get<DashboardPortfolio>(`/dashboard/portfolio?month=${month}${querySeller}`, { signal }),
      api.get<ActivityKpi[]>(`/activity-kpis?month=${month}${querySeller}`, { signal }),
      api.get<Activity[]>(`/activities?month=${month}${querySeller}&done=true`, { signal }),
      api.get<DisciplineRankingItem[]>(`/reports/discipline-ranking?from=${from}&to=${to}${querySeller}`, { signal }),
      api.get<DisciplineRankingItem[]>(`/reports/discipline-ranking?from=${getCurrentWeekStart()}&to=${new Date().toISOString().slice(0, 10)}${querySeller}`, { signal }),
      api.get<WeeklyHighlights>(`/reports/weekly-highlights?weekStart=${getCurrentWeekStart()}${querySeller}`, { signal }),
      api.get<ConsistencyResponse>(`/reports/consistency${querySeller ? `?sellerId=${debouncedSellerId}` : ""}`, { signal }),
      api.get<MonthlyScoreResponse>(`/reports/score-monthly?month=${month}${scoreQuery}`, { signal }),
    ])
      .then(([summaryResponse, seriesResponse, portfolioResponse, activityKpisResponse, activitiesResponse, disciplineRankingResponse, weeklyDisciplineRankingResponse, weeklyHighlightsResponse, consistencyResponse, monthlyScoreResponse]) => {
        if (signal?.aborted) return;
        setSummary(summaryResponse.data);
        setSeries(seriesResponse.data);
        setPortfolio(portfolioResponse.data);
        setActivityKpis(activityKpisResponse.data);
        setActivities(activitiesResponse.data);
        setDisciplineRanking(disciplineRankingResponse.data);
        setWeeklyDisciplineRanking(weeklyDisciplineRankingResponse.data);
        setWeeklyHighlights(weeklyHighlightsResponse.data);
        setConsistencyReport(consistencyResponse.data);
        setMonthlyScore(monthlyScoreResponse.data);
      })
      .finally(() => {
        dashboardInFlightRef.current.delete(dashboardQueryKey);
      });

    dashboardInFlightRef.current.set(dashboardQueryKey, request);
    return request;
  }, [dashboardQueryKey, debouncedSellerId, month, scoreSellerId, user?.role]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchDashboard(controller.signal);

    return () => {
      controller.abort();
    };
  }, [fetchDashboard]);

  useEffect(() => {
    const onRefresh = (event?: Event) => {
      const detailMonth = (event as CustomEvent<{ month?: string }> | undefined)?.detail?.month;
      if (detailMonth && detailMonth !== month) return;
      fetchDashboard(undefined, { force: true });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") fetchDashboard(undefined, { force: true });
    };

    window.addEventListener(DASHBOARD_REFRESH_EVENT, onRefresh);
    window.addEventListener("focus", onRefresh);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener(DASHBOARD_REFRESH_EVENT, onRefresh);
      window.removeEventListener("focus", onRefresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchDashboard]);

  const lineOptions = useMemo<ChartOptions<"line">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: palette.textMuted,
            usePointStyle: true,
            boxWidth: isMobile ? 10 : 24,
            padding: isMobile ? 10 : 16,
            font: { size: isMobile ? 11 : 12 },
          },
        },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatCurrencyBRL(Number(context.raw || 0))}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: palette.textMuted,
            autoSkip: true,
            maxTicksLimit: isMobile ? 6 : 12,
            maxRotation: 0,
          },
          grid: { color: palette.grid },
        },
        y: {
          ticks: { color: palette.textMuted, callback: (value) => formatCompactNumberBR(Number(value)) },
          grid: { color: palette.grid },
        },
      },
    }),
    [isMobile]
  );



  const activityLineOptions = useMemo<ChartOptions<"line">>(
    () => ({
      ...lineOptions,
      plugins: {
        ...lineOptions.plugins,
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatNumberBR(Number(context.raw || 0))}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: palette.textMuted }, grid: { color: palette.grid } },
        y: {
          ticks: { color: palette.textMuted, callback: (value) => formatNumberBR(Number(value)) },
          grid: { color: palette.grid },
        },
      },
    }),
    [lineOptions]
  );

  const doughnutOptions = useMemo<ChartOptions<"doughnut">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      animation: {
        duration: 800,
        easing: "easeOutCubic",
        animateRotate: true,
        animateScale: false,
      },
      plugins: {
        legend: {
          display: false,
        },
      },
    }),
    []
  );

  const getDoughnutSegmentIndex = useCallback((activeElements: ActiveElement[]) => {
    if (!activeElements.length) return null;
    const [firstElement] = activeElements;
    return typeof firstElement.index === "number" ? firstElement.index : null;
  }, []);

  const buildInteractiveDoughnutOptions = useCallback(
    (
      indexToPathMap: Record<number, string>,
      optionsOverride: NonNullable<ChartOptions<"doughnut">["plugins"]>
    ): ChartOptions<"doughnut"> => ({
      ...doughnutOptions,
      onClick: (_event: ChartEvent, activeElements: ActiveElement[]) => {
        const segmentIndex = getDoughnutSegmentIndex(activeElements);
        if (segmentIndex === null) return;

        const targetPath = indexToPathMap[segmentIndex];
        if (!targetPath) return;

        navigate(targetPath);
      },
      onHover: (event: ChartEvent, activeElements: ActiveElement[]) => {
        const nativeEvent = event.native;
        const canvas =
          nativeEvent && "target" in nativeEvent && nativeEvent.target instanceof HTMLCanvasElement
            ? nativeEvent.target
            : null;
        if (!canvas) return;

        canvas.style.cursor = activeElements.length > 0 ? "pointer" : "default";
      },
      plugins: {
        ...doughnutOptions.plugins,
        ...optionsOverride,
      },
    }),
    [doughnutOptions, getDoughnutSegmentIndex, navigate]
  );

  const walletData = useMemo(
    () => [
      portfolio?.walletStatus.active ?? 0,
      portfolio?.walletStatus.inactiveRecent ?? 0,
      portfolio?.walletStatus.inactiveOld ?? 0,
    ],
    [portfolio?.walletStatus.active, portfolio?.walletStatus.inactiveRecent, portfolio?.walletStatus.inactiveOld]
  );

  const walletTotal = useMemo(() => walletData.reduce((acc, value) => acc + value, 0), [walletData]);

  const walletSegments = useMemo(
    () => [
      { label: "Ativos", value: walletData[0], color: donutSegmentColors[0] },
      { label: "Inativos recentes", value: walletData[1], color: donutSegmentColors[1] },
      { label: "Inativos antigos", value: walletData[2], color: donutSegmentColors[2] },
    ],
    [walletData]
  );

  const abcData = useMemo(
    () => [
      portfolio?.abcCurve.A.percentRevenue ?? 0,
      portfolio?.abcCurve.B.percentRevenue ?? 0,
      portfolio?.abcCurve.C.percentRevenue ?? 0,
    ],
    [portfolio?.abcCurve.A.percentRevenue, portfolio?.abcCurve.B.percentRevenue, portfolio?.abcCurve.C.percentRevenue]
  );

  const abcTotal = useMemo(() => abcData.reduce((acc, value) => acc + value, 0), [abcData]);

  const abcSegments = useMemo(
    () => [
      { label: "Classe A", value: abcData[0], color: donutSegmentColors[0] },
      { label: "Classe B", value: abcData[1], color: donutSegmentColors[1] },
      { label: "Classe C", value: abcData[2], color: donutSegmentColors[2] },
    ],
    [abcData]
  );

  const walletQuickKpi = useMemo(() => {
    const activeClients = portfolio?.walletStatus.active;
    const totalClients = portfolio?.totalClients;
    const activePercent =
      typeof activeClients === "number" && typeof totalClients === "number" && totalClients > 0
        ? (activeClients / totalClients) * 100
        : null;

    return {
      primary: formatKpiValue(typeof activeClients === "number" ? formatNumberBR(activeClients) : null),
      secondary: `Ativos • ${formatKpiValue(activePercent === null ? null : formatPercentBR(activePercent))}`,
    };
  }, [portfolio?.totalClients, portfolio?.walletStatus.active]);

  const abcQuickKpi = useMemo(() => {
    const classAClients = portfolio?.abcCurve.A.clients;
    const totalClients = portfolio?.totalClients;
    const classAPercent =
      typeof classAClients === "number" && typeof totalClients === "number" && totalClients > 0
        ? (classAClients / totalClients) * 100
        : null;

    return {
      primary: formatKpiValue(typeof classAClients === "number" ? `${formatNumberBR(classAClients)} clientes` : null),
      secondary: `Classe A • ${formatKpiValue(classAPercent === null ? null : formatPercentBR(classAPercent))}`,
    };
  }, [portfolio?.abcCurve.A.clients, portfolio?.totalClients]);

  const teamQuickKpi = useMemo(() => {
    const topSeller = summary?.performance[0];
    return {
      primary: formatKpiValue(topSeller?.seller),
      secondary: `Faturamento • ${formatKpiValue(
        typeof topSeller?.revenue === "number" ? formatCurrencyBRL(topSeller.revenue) : null
      )}`,
    };
  }, [summary?.performance]);

  const walletDoughnutOptions = useMemo<ChartOptions<"doughnut">>(
    () =>
      buildInteractiveDoughnutOptions(
        {
          0: "/clientes?status=ativos",
          1: "/clientes?status=inativos_recentes",
          2: "/clientes?status=inativos_antigos",
        },
        {
          tooltip: {
            callbacks: {
              label: (context) => {
                const value = Number(context.raw || 0);
                const allValues = context.dataset.data.map((item) => Number(item || 0));
                const total = allValues.reduce((acc, item) => acc + item, 0);
                const percent = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
                return `${context.label}: ${formatNumberBR(value)} (${percent}%)`;
              },
            },
          },
          doughnutCenterText: {
            label: "Total",
            value: `${formatNumberBR(walletTotal)} clientes`,
          },
        }
      ),
    [buildInteractiveDoughnutOptions, walletTotal]
  );

  const abcDoughnutOptions = useMemo<ChartOptions<"doughnut">>(
    () =>
      buildInteractiveDoughnutOptions(
        {
          0: "/clientes?classe=A",
          1: "/clientes?classe=B",
          2: "/clientes?classe=C",
        },
        {
          tooltip: {
            callbacks: {
              label: (context) => {
                const value = Number(context.raw || 0);
                const allValues = context.dataset.data.map((item) => Number(item || 0));
                const total = allValues.reduce((acc, item) => acc + item, 0);
                const percent = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
                return `${context.label}: ${formatPercentBR(value)} (${percent}%)`;
              },
            },
          },
          doughnutCenterText: {
            label: "Total",
            value: formatPercentBR(abcTotal),
          },
        }
      ),
    [abcTotal, buildInteractiveDoughnutOptions]
  );

  const salesPace = useMemo(() => {
    if (!summary || !series || !portfolio) return null;
    const soldInMonth = summary.totalRevenue;
    const soldToday = portfolio.soldToday;
    const objectiveMonth = series.objectiveTotal;
    const realizedPercent = objectiveMonth > 0 ? (soldInMonth / objectiveMonth) * 100 : 0;
    const missingToSell = Math.max(objectiveMonth - soldInMonth, 0);
    const remainingBusinessDays = getBusinessDaysRemaining(month);
    const requiredPerBusinessDay =
      remainingBusinessDays > 0 ? missingToSell / remainingBusinessDays : null;
    const percentObjectiveReached = objectiveMonth > 0 ? (soldInMonth / objectiveMonth) * 100 : 0;
    const elapsedSalesDays = getElapsedSalesDays(series.labels, month);
    const totalSalesDays = series.labels.length;
    const projectedRevenueRaw =
      elapsedSalesDays > 0 ? (series.realizedTotal / elapsedSalesDays) * totalSalesDays : 0;
    const projectedRevenue = clampFiniteNonNegative(projectedRevenueRaw);
    const isProjectedAboveObjective = projectedRevenue >= objectiveMonth;

    return {
      soldInMonth,
      soldToday,
      objectiveMonth,
      realizedPercent,
      percentObjectiveReached,
      missingToSell,
      requiredPerBusinessDay,
      projectedRevenue,
      isProjectedAboveObjective,
    };
  }, [summary, series, portfolio, month]);

  const realizedPercentClamped = useMemo(
    () => clampPercent(salesPace?.realizedPercent ?? 0),
    [salesPace?.realizedPercent]
  );

  const realizedTrend = useMemo<RealizedTrendDirection>(
    () => getRealizedTrend(series?.labels ?? [], series?.realizedDaily ?? [], month),
    [month, series?.labels, series?.realizedDaily]
  );

  const realizedTrendStyle = useMemo(() => {
    if (realizedTrend === "up") {
      return { symbol: "↑", className: "text-green-600" };
    }
    if (realizedTrend === "down") {
      return { symbol: "↓", className: "text-red-600" };
    }
    return { symbol: "→", className: "text-slate-400" };
  }, [realizedTrend]);

  useEffect(() => {
    setAnimatedRealizedPercent(0);
    const frame = requestAnimationFrame(() => {
      setAnimatedRealizedPercent(realizedPercentClamped);
    });

    return () => cancelAnimationFrame(frame);
  }, [realizedPercentClamped]);

  const activityPerformance = useMemo(() => {
    const targetByType = new Map<string, number>();
    const realizedByType = new Map<string, number>();
    const realizedByDay = new Map<string, number>();

    for (const item of activityKpis) {
      const normalizedType = normalizeActivityType(item.type);
      targetByType.set(normalizedType, (targetByType.get(normalizedType) ?? 0) + Number(item.targetValue || 0));
    }

    for (const item of activities) {
      if (!item.done) continue;
      if (!item.date || !item.date.startsWith(`${month}-`)) continue;
      const normalizedType = normalizeActivityType(item.type);
      realizedByType.set(normalizedType, (realizedByType.get(normalizedType) ?? 0) + 1);
      const day = item.date.slice(0, 10);
      realizedByDay.set(day, (realizedByDay.get(day) ?? 0) + 1);
    }

    const activityTypes = Array.from(new Set([...targetByType.keys(), ...realizedByType.keys()]));
    const summaryByType: ActivityTypeSummary[] = activityTypes
      .map((type) => {
        const target = targetByType.get(type) ?? 0;
        const realized = realizedByType.get(type) ?? 0;
        const missing = Math.max(target - realized, 0);
        const businessDaysRemaining = getBusinessDaysRemaining(month);

        return {
          type,
          target,
          realized,
          reachedPercent: target > 0 ? (realized / target) * 100 : 0,
          requiredDailyAverage: businessDaysRemaining > 0 ? missing / businessDaysRemaining : 0,
        };
      })
      .sort((a, b) => b.target - a.target);

    const [year, monthN] = month.split("-").map(Number);
    const lastDay = new Date(year, monthN, 0).getDate();
    let runningRealized = 0;
    let runningTarget = 0;
    const totalTarget = summaryByType.reduce((sum, item) => sum + item.target, 0);
    const targetPerDay = lastDay > 0 ? totalTarget / lastDay : 0;

    const labels: string[] = [];
    const realizedAccumulated: number[] = [];
    const targetAccumulated: number[] = [];

    for (let day = 1; day <= lastDay; day += 1) {
      const dateKey = `${month}-${String(day).padStart(2, "0")}`;
      runningRealized += realizedByDay.get(dateKey) ?? 0;
      runningTarget += targetPerDay;
      labels.push(String(day));
      realizedAccumulated.push(runningRealized);
      targetAccumulated.push(runningTarget);
    }

    const totalRealized = summaryByType.reduce((sum, item) => sum + item.realized, 0);
    const reachedPercent = totalTarget > 0 ? (totalRealized / totalTarget) * 100 : 0;
    const businessDaysRemaining = getBusinessDaysRemaining(month);

    const rankingBySeller = user?.role === "vendedor"
      ? []
      : Array.from(
          activityKpis.reduce<Map<string, { seller: string; target: number; realized: number }>>((acc, item) => {
            const sellerName = item.seller?.name ?? sellers.find((seller) => seller.id === item.sellerId)?.name ?? "Sem nome";
            if (!acc.has(item.sellerId)) {
              acc.set(item.sellerId, { seller: sellerName, target: 0, realized: 0 });
            }
            const entry = acc.get(item.sellerId)!;
            entry.target += Number(item.targetValue || 0);
            entry.realized += Number(item.logicalCount || 0);
            return acc;
          }, new Map())
        )
          .map(([sellerId, values]) => ({
            sellerId,
            seller: values.seller,
            target: values.target,
            realized: values.realized,
            reachedPercent: values.target > 0 ? (values.realized / values.target) * 100 : 0,
          }))
          .sort((a, b) => b.reachedPercent - a.reachedPercent);

    return {
      summaryByType,
      labels,
      realizedAccumulated,
      targetAccumulated,
      totalTarget,
      totalRealized,
      reachedPercent,
      requiredDailyAverage: businessDaysRemaining > 0 ? Math.max(totalTarget - totalRealized, 0) / businessDaysRemaining : 0,
      rankingBySeller,
    };
  }, [activityKpis, activities, month, sellers, user?.role]);

  const currentSellerDisciplineStatus = useMemo(() => {
    if (!user) return null;
    const row = weeklyDisciplineRanking.find((item) => item.sellerId === user.id);
    if (!row) return null;

    return {
      isBelowMinimum: row.executionRate < 60,
      hasInactivityFlag: row.hasInactivityFlag,
    };
  }, [user, weeklyDisciplineRanking]);

  const weeklyHighlightCards = useMemo<WeeklyHighlightCard[]>(() => [
    {
      key: "bestResult",
      title: "Maior Resultado",
      highlight: weeklyHighlights?.bestResult ?? null,
      formatter: (value) => formatCurrencyBRL(value),
    },
    {
      key: "bestEvolution",
      title: "Maior Evolução",
      highlight: weeklyHighlights?.bestEvolution ?? null,
      formatter: (value) => formatPercentBR(value),
    },
    {
      key: "bestExecutor",
      title: "Executor da Semana",
      highlight: weeklyHighlights?.bestExecutor ?? null,
      formatter: (value) => formatPercentBR(value),
    },
    {
      key: "bestConversion",
      title: "Melhor Conversão",
      highlight: weeklyHighlights?.bestConversion ?? null,
      formatter: (value) => formatPercentBR(value),
    },
  ], [weeklyHighlights]);

  const disciplineRankingVisible = useMemo(() => {
    const rankingWithPosition = disciplineRanking.map((item, index) => ({
      ...item,
      position: index + 1,
    }));

    if (user?.role !== "vendedor") {
      return rankingWithPosition.slice(0, 5);
    }

    const topThree = rankingWithPosition.slice(0, 3);
    const myRow = rankingWithPosition.find((item) => item.sellerId === user.id);

    if (!myRow) return topThree;
    if (topThree.some((item) => item.sellerId === myRow.sellerId)) return topThree;

    return [...topThree, myRow];
  }, [disciplineRanking, user?.id, user?.role]);

  const consistencyRankingVisible = useMemo(() => {
    if (!consistencyReport) return [];
    if (user?.role === "vendedor") {
      return consistencyReport.ranking.filter((item) => item.sellerId === user.id);
    }

    return consistencyReport.ranking;
  }, [consistencyReport, user?.id, user?.role]);

  const monthlyScoreVisible = useMemo(() => {
    if (!monthlyScore) return [];

    if (user?.role === "vendedor") {
      return monthlyScore.items;
    }

    const search = scoreSearch.trim().toLowerCase();
    if (!search) return monthlyScore.items;

    return monthlyScore.items.filter((item) => item.name.toLowerCase().includes(search));
  }, [monthlyScore, scoreSearch, user?.role]);

  const monthlyScoreTopThree = useMemo(() => monthlyScoreVisible.filter((item) => item.rank <= 3), [monthlyScoreVisible]);

  const monthlyScoreMe = useMemo(() => {
    if (user?.role !== "vendedor") return null;
    return monthlyScoreVisible.find((item) => item.userId === user.id) || null;
  }, [monthlyScoreVisible, user?.id, user?.role]);

  const consistencyBadge = (level: ConsistencyLevel) => {
    if (level === "alta") return { label: "🟢 Alta", className: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    if (level === "media") return { label: "🟡 Média", className: "bg-amber-50 text-amber-700 border-amber-200" };
    return { label: "🔴 Baixa", className: "bg-rose-50 text-rose-700 border-rose-200" };
  };

  if (!summary || !series || !portfolio || !salesPace) {
    return <div className={cardClass}>Carregando dashboard...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:items-end">
        <Link
          to="/dashboard/score-comercial"
          className="rounded-lg border border-brand-300 bg-white px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          Ver Score Comercial
        </Link>
      </div>

      {currentSellerDisciplineStatus?.isBelowMinimum ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Você está abaixo da disciplina mínima esta semana.
        </div>
      ) : null}
      {user?.role !== "vendedor" && (
        <div className={cardClass}>
          <label className="text-sm font-medium text-slate-600">Filtrar vendedor</label>
          <select
            value={sellerId}
            onChange={(event) => setSellerId(event.target.value)}
            className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          >
            <option value="">Todos vendedores</option>
            {sellers.map((seller) => (
              <option key={seller.id} value={seller.id}>
                {seller.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-slate-900">Destaques da Semana</h3>
        <p className="mt-1 text-sm text-slate-500">Reconhecimento coletivo atualizado automaticamente a cada segunda-feira.</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {weeklyHighlightCards.map((item) => (
            <div key={item.key} className={cardClass}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-700">{item.title}</p>
                  <p className="mt-1 text-xs text-slate-500">{item.highlight?.metricLabel ?? "Sem dados na semana"}</p>
                </div>
                <span className="text-xl" aria-hidden>{item.highlight?.medal ?? "🏅"}</span>
              </div>

              {item.highlight ? (
                <div className="mt-4 flex items-center gap-3">
                  {item.highlight.avatarUrl ? (
                    <img
                      src={item.highlight.avatarUrl}
                      alt={`Avatar de ${item.highlight.sellerName}`}
                      className="h-10 w-10 rounded-full border border-slate-200 object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
                      {item.highlight.sellerName.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{item.highlight.sellerName}</p>
                    <p className="text-sm text-slate-600">{item.formatter(item.highlight.metricValue)}</p>
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-500">Aguardando movimentações da semana.</p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {[
          { label: "Faturamento no mês", value: formatCurrencyBRL(summary.totalRevenue) },
          { label: "Vendas no mês", value: formatNumberBR(summary.totalSales) },
          { label: "Vendido hoje", value: formatCurrencyBRL(salesPace.soldToday) },
          { label: "% do objetivo atingido", value: formatPercentBR(salesPace.percentObjectiveReached) },
          { label: "Clientes ativos", value: formatNumberBR(portfolio.walletStatus.active) },
          { label: "Inativos 31–90 / >90", value: `${formatNumberBR(portfolio.walletStatus.inactiveRecent)} / ${formatNumberBR(portfolio.walletStatus.inactiveOld)}` },
        ].map((item) => (
          <div key={item.label} className={cardClass}>
            <div className="text-sm text-slate-500">{item.label}</div>
            <div className="text-2xl font-bold text-slate-900">{item.value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-slate-900">Evolução do mês</h3>
        {series.objectiveTotal === 0 && (
          <div className="mt-2 text-sm text-amber-600">Objetivo do mês não definido.</div>
        )}
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12 xl:items-stretch">
          <div className="h-[250px] w-full sm:h-[300px] xl:col-span-9 xl:h-[360px]">
            <Line
              options={lineOptions}
              data={{
                labels: series.labels,
                datasets: [
                  {
                    label: isMobile ? "Faturado" : "Faturado acumulado",
                    data: series.realizedAccumulated,
                    borderColor: palette.success,
                    backgroundColor: "rgba(47, 158, 68, 0.2)",
                    borderWidth: 2,
                    tension: 0.3,
                  },
                  {
                    label: isMobile ? "Objetivo" : "Objetivo acumulado",
                    data: series.objectiveAccumulated,
                    borderColor: palette.primary,
                    backgroundColor: "rgba(11, 60, 29, 0.2)",
                    borderWidth: 2,
                    tension: 0.3,
                  },
                ],
              }}
            />
          </div>
          <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3 xl:col-span-3 xl:h-[360px]">
            <div className="flex h-full flex-col gap-4 xl:overflow-y-auto xl:pr-1">
              <div>
                <div className="mb-1 text-sm font-medium text-slate-500">Faturado acumulado</div>
                <div className="text-xl font-bold leading-tight text-slate-900 xl:text-2xl">
                  {formatCurrencyBRL(salesPace.soldInMonth)}
                </div>
              </div>

              <div>
                <div className="mb-1 text-sm font-medium text-slate-500">Objetivo do mês</div>
                <div className="text-xl font-bold leading-tight text-slate-900 xl:text-2xl">
                  {formatCurrencyBRL(salesPace.objectiveMonth)}
                </div>
              </div>

              <div>
                <div className="mb-1 text-sm font-medium text-slate-500">Previsão projetada</div>
                <div className="text-xl font-bold leading-tight text-slate-900 xl:text-2xl">
                  {formatCurrencyBRL(salesPace.projectedRevenue)}
                </div>
                <div
                  className={`mt-2 inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                    salesPace.isProjectedAboveObjective
                      ? "bg-green-100 text-green-700"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {salesPace.isProjectedAboveObjective ? "Acima do objetivo" : "Abaixo do objetivo"}
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-500">
                  <span>Realizado</span>
                  <span
                    className={`text-sm ${realizedTrendStyle.className}`}
                    title="Comparado aos 3 dias anteriores"
                    aria-label="Indicador de tendência do realizado"
                  >
                    {realizedTrendStyle.symbol}
                  </span>
                </div>
                <div className="text-lg font-semibold text-slate-900">{formatPercentBR(salesPace.realizedPercent)}</div>
                <div className="mt-2 h-3 rounded-full bg-slate-100">
                  <div
                    className="h-3 rounded-full bg-brand-600 transition-[width] duration-[600ms] ease-out motion-reduce:transition-none"
                    style={{ width: `${animatedRealizedPercent}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="mb-1 text-sm font-medium text-slate-500">Necessário vender por dia útil</div>
                <div className="text-xl font-bold leading-tight text-slate-900 xl:text-2xl">
                  {salesPace.requiredPerBusinessDay === null ? "—" : formatCurrencyBRL(salesPace.requiredPerBusinessDay)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-slate-900">Performance de Atividades</h3>
        <p className="mt-1 text-sm text-slate-500">
          {user?.role === "vendedor" ? "Visão individual do mês atual." : "Consolidado do time no mês atual."}
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div className={cardClass}>
            <div className="text-sm text-slate-500">Meta mensal (total)</div>
            <div className="text-2xl font-bold text-slate-900">{formatNumberBR(activityPerformance.totalTarget)}</div>
          </div>
          <div className={cardClass}>
            <div className="text-sm text-slate-500">Realizado até hoje</div>
            <div className="text-2xl font-bold text-slate-900">{formatNumberBR(activityPerformance.totalRealized)}</div>
          </div>
          <div className={cardClass}>
            <div className="text-sm text-slate-500">% atingido</div>
            <div className="text-2xl font-bold text-slate-900">{formatPercentBR(activityPerformance.reachedPercent)}</div>
          </div>
          <div className={cardClass}>
            <div className="text-sm text-slate-500">Média diária necessária</div>
            <div className="text-2xl font-bold text-slate-900">{formatNumberBR(activityPerformance.requiredDailyAverage)}</div>
          </div>
          <div className={cardClass}>
            <div className="text-sm text-slate-500">Tipos monitorados</div>
            <div className="text-2xl font-bold text-slate-900">{formatNumberBR(activityPerformance.summaryByType.length)}</div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-12">
          <div className="h-[230px] sm:h-[280px] xl:col-span-8 xl:h-[320px]">
            <Line
              options={activityLineOptions}
              data={{
                labels: activityPerformance.labels,
                datasets: [
                  {
                    label: isMobile ? "Realizado" : "Realizado acumulado (atividades)",
                    data: activityPerformance.realizedAccumulated,
                    borderColor: palette.success,
                    backgroundColor: "rgba(47, 158, 68, 0.2)",
                    borderWidth: 2,
                    tension: 0.3,
                  },
                  {
                    label: isMobile ? "Meta" : "Meta acumulada (atividades)",
                    data: activityPerformance.targetAccumulated,
                    borderColor: palette.primary,
                    backgroundColor: "rgba(11, 60, 29, 0.2)",
                    borderWidth: 2,
                    tension: 0.3,
                  },
                ],
              }}
            />
          </div>

          <div className="xl:col-span-4">
            <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Meta mensal por tipo</h4>
            <div className="max-h-[320px] overflow-auto rounded-lg border border-slate-100">
              <table className="min-w-[600px] w-full text-sm">
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="text-left text-slate-500">
                    <th className="px-3 py-2">Tipo</th>
                    <th className="px-3 py-2">Meta</th>
                    <th className="px-3 py-2">Realizado</th>
                    <th className="px-3 py-2">% atingido</th>
                    <th className="px-3 py-2">Média diária</th>
                  </tr>
                </thead>
                <tbody>
                  {activityPerformance.summaryByType.map((item) => (
                    <tr key={item.type} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-700">{toLabel(item.type)}</td>
                      <td className="px-3 py-2 text-slate-700">{formatNumberBR(item.target)}</td>
                      <td className="px-3 py-2 text-slate-700">{formatNumberBR(item.realized)}</td>
                      <td className="px-3 py-2 text-slate-700">{formatPercentBR(item.reachedPercent)}</td>
                      <td className="px-3 py-2 text-slate-700">{formatNumberBR(item.requiredDailyAverage)}</td>
                    </tr>
                  ))}
                  {activityPerformance.summaryByType.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                        Sem metas de atividade configuradas para este mês.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {user?.role !== "vendedor" && (
          <div className="mt-5">
            <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Ranking por vendedor</h4>
            <div className="w-full overflow-x-auto rounded-lg border border-slate-100">
              <table className="min-w-[600px] w-full text-sm">
                <thead className="bg-slate-50">
                  <tr className="text-left text-slate-500">
                    <th className="px-3 py-2">Ranking</th>
                    <th className="px-3 py-2">Vendedor</th>
                    <th className="px-3 py-2">Meta</th>
                    <th className="px-3 py-2">Realizado</th>
                    <th className="px-3 py-2">% atingido</th>
                  </tr>
                </thead>
                <tbody>
                  {activityPerformance.rankingBySeller.map((row, index) => (
                    <tr key={row.sellerId} className="border-t border-slate-100">
                      <td className="px-3 py-2">{index + 1}º</td>
                      <td className="px-3 py-2 text-slate-700">{row.seller}</td>
                      <td className="px-3 py-2 text-slate-700">{formatNumberBR(row.target)}</td>
                      <td className="px-3 py-2 text-slate-700">{formatNumberBR(row.realized)}</td>
                      <td className="px-3 py-2 text-slate-700">{formatPercentBR(row.reachedPercent)}</td>
                    </tr>
                  ))}
                  {activityPerformance.rankingBySeller.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                        Sem dados de ranking para o período.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className={cardClass}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-slate-800">Ranking Disciplina</h3>
          <span className="text-xs text-slate-500">Agenda + Roteiro</span>
        </div>
        <div className="w-full overflow-x-auto">
          <table className="min-w-[600px] w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2.5 pr-3">Posição</th>
                <th className="py-2.5 pr-3">Vendedor</th>
                <th className="py-2.5 pr-3">Execução</th>
                <th className="py-2.5 pr-3">Pontualidade</th>
                <th className="py-2.5 pr-3">Score</th>
              </tr>
            </thead>
            <tbody>
              {disciplineRankingVisible.map((row) => {
                const medal = row.position === 1 ? "🥇" : row.position === 2 ? "🥈" : row.position === 3 ? "🥉" : "";
                return (
                  <tr key={row.sellerId} className="border-b border-slate-100">
                    <td className="py-2.5 pr-3">{medal || `#${row.position}`}</td>
                    <td className="py-2.5 pr-3 font-medium text-slate-800">
                      <div className="inline-flex items-center gap-2">
                        <span>{row.sellerName}</span>
                        {row.hasInactivityFlag || row.isUnderExecutionThreshold || row.volumeFactor < 1 ? (
                          <span
                            className="inline-flex h-2.5 w-2.5 rounded-full bg-rose-600"
                            title={[
                              row.isUnderExecutionThreshold ? "Execução semanal abaixo de 60% (penalidade de 10% no score aplicada)." : null,
                              row.hasInactivityFlag ? "Inatividade: vendedor sem registro de visita nos últimos 3 dias úteis." : null,
                              row.volumeFactor < 1 ? "Score ajustado pelo volume mínimo semanal" : null,
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            aria-label={[
                              row.isUnderExecutionThreshold ? "Execução semanal abaixo de 60% (penalidade de 10% no score aplicada)." : null,
                              row.hasInactivityFlag ? "Inatividade: vendedor sem registro de visita nos últimos 3 dias úteis." : null,
                              row.volumeFactor < 1 ? "Score ajustado pelo volume mínimo semanal" : null,
                            ]
                              .filter(Boolean)
                              .join(" ")}
                          />
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-slate-700">{formatPercentBR(row.executionRate)}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{formatPercentBR(row.punctualRate)}</td>
                    <td
                      className="py-2.5 pr-3 text-slate-700"
                      title={row.volumeFactor < 1 ? "Score ajustado pelo volume mínimo semanal" : undefined}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span>{formatPercentBR(row.disciplineScoreFinal)}</span>
                        {row.volumeFactor < 1 ? (
                          <span
                            className="inline-flex h-2 w-2 rounded-full bg-amber-500"
                            title="Score ajustado pelo volume mínimo semanal"
                            aria-label="Score ajustado pelo volume mínimo semanal"
                          />
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {disciplineRankingVisible.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-500">
                    Sem dados de disciplina para o período.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={cardClass}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-slate-800">Score Comercial do Mês</h3>
            <p className="text-xs text-slate-500">Resultado mensal (faturado + atingimento + pipeline ponderado).</p>
          </div>
          <span className="text-xs text-slate-500">{monthlyScore?.month ?? month}</span>
        </div>

        {user?.role !== "vendedor" ? (
          <div className="mb-3 grid gap-2 sm:grid-cols-2">
            <select
              value={scoreSellerId}
              onChange={(event) => setScoreSellerId(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
            >
              <option value="">Todos vendedores</option>
              {sellers.map((seller) => (
                <option key={seller.id} value={seller.id}>{seller.name}</option>
              ))}
            </select>
            <input
              value={scoreSearch}
              onChange={(event) => setScoreSearch(event.target.value)}
              placeholder="Buscar vendedor"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
            />
          </div>
        ) : null}

        <div className="w-full overflow-x-auto">
          <table className="min-w-[600px] w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2.5 pr-3">Posição</th>
                <th className="py-2.5 pr-3">Vendedor</th>
                <th className="py-2.5 pr-3">Faturado</th>
                <th className="py-2.5 pr-3">Objetivo</th>
                <th className="py-2.5 pr-3">Atingimento</th>
                <th className="py-2.5 pr-3">Pipeline pond.</th>
                <th className="py-2.5 pr-3">Score</th>
              </tr>
            </thead>
            <tbody>
              {monthlyScoreVisible.map((row) => {
                const medal = row.rank === 1 ? "🥇" : row.rank === 2 ? "🥈" : row.rank === 3 ? "🥉" : "";
                return (
                  <tr key={`${row.userId}-${row.rank}`} className="border-b border-slate-100">
                    <td className="py-2.5 pr-3">{medal || `#${row.rank}`}</td>
                    <td className="py-2.5 pr-3 font-medium text-slate-800">{row.name}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{formatCurrencyBRL(row.faturadoMes)}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{row.objetivoMes > 0 ? formatCurrencyBRL(row.objetivoMes) : "—"}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{formatPercentBR(row.atingimentoPercent)}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{formatCurrencyBRL(row.pipelinePonderado)}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{formatNumberBR(row.score)}</td>
                  </tr>
                );
              })}
              {monthlyScoreVisible.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-slate-500">Sem dados de score mensal no período.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {user?.role === "vendedor" ? (
          <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900">
            <p className="font-semibold">Seu destaque</p>
            <p>
              Top 3 do mês: {monthlyScoreTopThree.map((item) => `${item.rank}º ${item.name}`).join(" • ") || "sem dados"}.
            </p>
            {monthlyScoreMe ? <p>Sua posição: #{monthlyScoreMe.rank} com score {formatNumberBR(monthlyScoreMe.score)}.</p> : null}
          </div>
        ) : null}
      </div>

      <div className={cardClass}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-slate-800">Consistência</h3>
            <p className="text-xs text-slate-500">Média de ScoreFinal, meses com meta batida e estabilidade (últimos 3 meses).</p>
          </div>
          <span className="text-xs text-slate-500">Dashboard &gt; Consistência</span>
        </div>
        <div className="w-full overflow-x-auto">
          <table className="min-w-[600px] w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2.5 pr-3">Posição</th>
                <th className="py-2.5 pr-3">Vendedor</th>
                <th className="py-2.5 pr-3">Índice</th>
                <th className="py-2.5 pr-3">Média Score</th>
                <th className="py-2.5 pr-3">% Meta</th>
                <th className="py-2.5 pr-3">Desvio padrão</th>
                <th className="py-2.5 pr-3">Indicador</th>
              </tr>
            </thead>
            <tbody>
              {consistencyRankingVisible.map((row) => {
                const badge = consistencyBadge(row.consistencyLevel);
                return (
                  <tr key={row.sellerId} className="border-b border-slate-100">
                    <td className="py-2.5 pr-3">#{row.position}</td>
                    <td className="py-2.5 pr-3 font-medium text-slate-800">{row.sellerName}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{formatPercentBR(row.consistencyScore)}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{formatPercentBR(row.averageScore)}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{formatPercentBR(row.metaHitRate)}</td>
                    <td className="py-2.5 pr-3 text-slate-700">{formatNumberBR(row.stdDevResult)}</td>
                    <td className="py-2.5 pr-3">
                      <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${badge.className}`}>{badge.label}</span>
                    </td>
                  </tr>
                );
              })}
              {consistencyRankingVisible.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-slate-500">
                    Sem dados de consistência para o período.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div className={cardClass}>
          <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <h3 className="font-semibold text-slate-800">Carteira de clientes</h3>
            <div className="sm:text-right">
              <div className="flex items-center gap-2 sm:justify-end">
                <span className="text-lg font-semibold text-slate-900">{walletQuickKpi.primary}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-brand-700">%</span>
              </div>
              <div className="text-xs text-slate-500">{walletQuickKpi.secondary}</div>
            </div>
          </div>
          <div className="mb-3 text-sm text-slate-600">Total de clientes: <span className="font-semibold text-slate-900">{formatNumberBR(portfolio.totalClients)}</span></div>
          <div className={doughnutContainerClass}>
            <Doughnut
              plugins={[doughnutCenterTextPlugin]}
              options={walletDoughnutOptions}
              data={{
                labels: ["Ativos", "Inativos recentes", "Inativos antigos"],
                datasets: [
                  {
                    data: walletData,
                    backgroundColor: donutSegmentColors,
                    borderColor: palette.surface,
                    borderWidth: 2,
                    hoverOffset: 8,
                  },
                ],
              }}
            />
          </div>
          <DonutLegendChips items={walletSegments} total={walletTotal} />
        </div>

        <div className={cardClass}>
          <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <h3 className="font-semibold text-slate-800">Curva ABC de clientes (últimos 90 dias)</h3>
            <div className="sm:text-right">
              <div className="flex items-center gap-2 sm:justify-end">
                <span className="text-lg font-semibold text-slate-900">{abcQuickKpi.primary}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-brand-700">%</span>
              </div>
              <div className="text-xs text-slate-500">{abcQuickKpi.secondary}</div>
            </div>
          </div>
          <div className={doughnutContainerClass}>
            <Doughnut
              plugins={[doughnutCenterTextPlugin]}
              options={abcDoughnutOptions}
              data={{
                labels: ["Classe A", "Classe B", "Classe C"],
                datasets: [
                  {
                    data: abcData,
                    backgroundColor: donutSegmentColors,
                    borderColor: palette.surface,
                    borderWidth: 2,
                    hoverOffset: 8,
                  },
                ],
              }}
            />
          </div>
          <DonutLegendChips items={abcSegments} total={abcTotal} formatValue={formatPercentBR} />
        </div>

        <div className={`${cardClass} flex min-h-[260px] flex-col p-5`}>
          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <h3 className="font-semibold text-slate-800">Performance da equipe</h3>
            <div className="sm:text-right">
              <div className="text-lg font-semibold text-slate-900">{teamQuickKpi.primary}</div>
              <div className="text-xs text-slate-500">{teamQuickKpi.secondary}</div>
            </div>
          </div>
          <div className="flex flex-1 items-center overflow-x-auto">
            <table className="min-w-[600px] w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-2.5 pr-3">Ranking</th>
                  <th className="py-2.5 pr-3">Vendedor</th>
                  <th className="py-2.5 pr-3">Vendas</th>
                  <th className="py-2.5 pr-3">Faturamento</th>
                  <th className="py-2.5 pr-3">Realizado</th>
                </tr>
              </thead>
              <tbody>
                {summary.performance.map((row: DashboardSummary["performance"][number], index: number) => {
                  const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "";
                  return (
                    <tr key={row.sellerId} className="border-b border-slate-100">
                      <td className="py-2.5 pr-3">{medal || `#${index + 1}`}</td>
                      <td className="py-2.5 pr-3 font-medium text-slate-800">{row.seller}</td>
                      <td className="py-2.5 pr-3 text-slate-700">{formatNumberBR(row.sales)}</td>
                      <td className="py-2.5 pr-3 text-slate-700">{formatCurrencyBRL(row.revenue)}</td>
                      <td className="py-2.5 pr-3 text-slate-700">{formatPercentBR(row.realizedPercent)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
