import assert from "node:assert/strict";
import { once } from "node:events";

// Dados fictícios. Dashboard na visão do vendedor: nenhuma rota que o Dashboard chama entrega dados de
// colegas ao vendedor, e "Minha semana" bate com a regra planejado × concluído da Agenda. Os fakes aplicam
// os filtros de vendedor que a rota manda (como o banco faria); rotas que calculam sobre o time e filtram
// a resposta recebem o time inteiro. Relógio fixo: sexta 06/11/2026 12:00 de Brasília, depois do corte.
const FIXED_NOW = Date.parse("2026-11-06T15:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...(args as [string]));
  }
  static now() {
    return FIXED_NOW;
  }
}
globalThis.Date = FixedDate as DateConstructor;

const shared = await import("@salesforce-pro/shared");
const { app } = await import("../app.js");
const { prisma } = await import("../config/prisma.js");
const { signAccessToken } = await import("../utils/jwt.js");

type Row = Record<string, any>;
const br = (dayTime: string) => new Date(`${dayTime}:00.000-03:00`);
const MONTH = "2026-11";
// Semanas como o Dashboard pede (segunda a domingo): a atual e a anterior.
const CURRENT_WEEK = { from: "2026-11-02", to: "2026-11-08" };
const PREVIOUS_WEEK = { from: "2026-10-26", to: "2026-11-01" };

const users: Row[] = [
  { id: "director-x", name: "Diretora Ficticia", role: "diretor", isActive: true },
  { id: "manager-x", name: "Gerente Ficticio", role: "gerente", isActive: true },
  { id: "seller-a", name: "Vendedor Ficticio Alfa", role: "vendedor", isActive: true },
  { id: "seller-b", name: "Vendedora Ficticia Beta", role: "vendedor", isActive: true }
];
const SELLER_B_MARKERS = ["seller-b", "Vendedora Ficticia Beta", "Cliente Ficticio Beta", "98765", "55555"];

const stop = (resultStatus: string | null, checkOutAt?: string) => ({ resultStatus, checkOutAt: checkOutAt ? br(checkOutAt) : null });
const event = (sellerId: string, type: string, status: string, start: string, end: string, extra: Row = {}) => ({
  sellerId,
  type,
  status,
  startDateTime: br(start),
  endDateTime: br(end),
  stops: [],
  activities: [],
  ...extra
});

const agendaEvents: Row[] = [
  // Semana atual, vendedor A.
  event("seller-a", "roteiro_visita", "agendado", "2026-11-03T08:00", "2026-11-03T18:00", {
    stops: [stop("realizada", "2026-11-03T10:00"), stop("realizada", "2026-11-04T09:00"), stop("nao_realizada"), stop(null)]
  }),
  event("seller-a", "visita", "realizado", "2026-11-04T09:00", "2026-11-04T10:00", { activities: [{ date: br("2026-11-04T10:00") }] }),
  event("seller-a", "ligacao", "agendado", "2026-11-05T09:00", "2026-11-05T09:30"),
  event("seller-a", "visita", "agendado", "2026-11-07T09:00", "2026-11-07T10:00"),
  // Semana anterior, vendedor A.
  event("seller-a", "visita", "realizado", "2026-10-27T09:00", "2026-10-27T10:00", { activities: [{ date: br("2026-10-27T10:00") }] }),
  event("seller-a", "visita", "nao_realizado", "2026-10-28T09:00", "2026-10-28T10:00"),
  // Vendedora B: tudo concluído nas duas semanas.
  ...["2026-10-27", "2026-11-03", "2026-11-04"].map((day) =>
    event("seller-b", "visita", "realizado", `${day}T09:00`, `${day}T10:00`, { activities: [{ date: br(`${day}T10:00`) }] })
  )
];

// Visitas feitas: A tem 3 na semana atual e 1 na anterior; B tem 27.
const visit = (ownerSellerId: string, when: string) => ({ id: `act-${ownerSellerId}-${when}`, ownerSellerId, type: "visita", done: true, date: br(when), dueDate: br(when), agendaEventId: null, opportunityId: null, createdAt: br(when) });
const activities: Row[] = [
  ...["2026-11-03T10:00", "2026-11-04T10:00", "2026-11-05T16:00", "2026-10-27T10:00"].map((when) => visit("seller-a", when)),
  ...Array.from({ length: 27 }, (_, index) => visit("seller-b", `2026-11-0${2 + (index % 5)}T${String(8 + (index % 9)).padStart(2, "0")}:00`))
];

const wonOpportunities: Row[] = [
  { id: "opp-a", ownerSellerId: "seller-a", clientId: "client-a", value: 1234, title: "Oportunidade Ficticia Alfa" },
  { id: "opp-b", ownerSellerId: "seller-b", clientId: "client-b", value: 98765, title: "Oportunidade Ficticia Beta" }
].map((row) => ({ ...row, stage: "ganho", closedAt: br("2026-11-03T10:00"), expectedCloseDate: br("2026-11-03T10:00"), client: { tenantId: "tenant-x" }, ownerSeller: { name: users.find((user) => user.id === row.ownerSellerId)!.name } }));
const clients: Row[] = [
  { id: "client-a", name: "Cliente Ficticio Alfa", ownerSellerId: "seller-a", isArchived: false, lastPurchaseDate: br("2026-10-01T10:00"), financialProfile: null },
  { id: "client-b", name: "Cliente Ficticio Beta", ownerSellerId: "seller-b", isArchived: false, lastPurchaseDate: br("2026-10-01T10:00"), financialProfile: null }
];
const goals: Row[] = [
  { sellerId: "seller-a", month: MONTH, targetValue: 2000 },
  { sellerId: "seller-b", month: MONTH, targetValue: 55555 }
];
const activityKpis: Row[] = ["seller-a", "seller-b"].map((sellerId) => ({
  id: `kpi-${sellerId}`,
  sellerId,
  month: MONTH,
  type: "visita",
  targetValue: 20,
  seller: { id: sellerId, name: users.find((user) => user.id === sellerId)!.name, email: `${sellerId}@test.invalid`, isActive: true }
}));

const inRange = (value: Date, range: Row = {}) =>
  (range.gte === undefined || value.getTime() >= range.gte.getTime()) &&
  (range.lte === undefined || value.getTime() <= range.lte.getTime()) &&
  (range.lt === undefined || value.getTime() < range.lt.getTime());
// Filtro de vendedor como o banco aplicaria: só as chaves de dono que as rotas usam.
const matchesId = (value: string, filter: unknown) =>
  filter === undefined || (typeof filter === "string" ? value === filter : ((filter as Row).in as string[] | undefined)?.includes(value) ?? true);
const byOwner = (rows: Row[], where: Row = {}) => rows.filter((row) => matchesId(row.ownerSellerId, where.ownerSellerId));
const matchesUser = (user: Row, where: Row = {}) =>
  (where.role === undefined || user.role === where.role) &&
  (where.isActive === undefined || user.isActive === where.isActive) &&
  matchesId(user.id, where.id);

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const countBySeller = (rows: Row[]) =>
  Object.entries(
    rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.ownerSellerId] = (acc[row.ownerSellerId] || 0) + 1;
      return acc;
    }, {})
  ).map(([ownerSellerId, count]) => ({ ownerSellerId, _count: { _all: count } }));
const activityRows = (where: Row = {}) =>
  byOwner(activities, where).filter((row) => (!where.date || inRange(row.date, where.date)) && (!where.dueDate || inRange(row.dueDate, where.dueDate)));

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, email: `${user.id}@test.invalid`, role: user.role, region: null } : null;
  },
  findMany: async ({ where }: any) => users.filter((user) => matchesUser(user, where))
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-x" }] : []) });
setModel("agendaEvent", {
  findMany: async ({ where }: any) =>
    agendaEvents.filter(
      (row) =>
        (!where.sellerId || row.sellerId === where.sellerId) &&
        (where.status?.not === undefined || row.status !== where.status.not) &&
        inRange(row.startDateTime, where.startDateTime)
    )
});
setModel("activity", {
  findMany: async ({ where }: any) => activityRows(where),
  groupBy: async ({ where }: any) => countBySeller(activityRows(where))
});
setModel("opportunity", {
  findMany: async ({ where }: any) => byOwner(where?.stage === "ganho" ? wonOpportunities : [], where),
  groupBy: async () => []
});
setModel("client", {
  findMany: async ({ where }: any) => byOwner(clients, where),
  count: async ({ where }: any) => byOwner(clients, where).length
});
setModel("goal", { findMany: async ({ where }: any) => goals.filter((goal) => (!where?.month || goal.month === where.month) && matchesId(goal.sellerId, where?.sellerId)) });
setModel("activityKPI", { findMany: async ({ where }: any) => activityKpis.filter((kpi) => matchesId(kpi.sellerId, where?.sellerId)) });
setModel("erpOrderSync", { findMany: async () => [] });
setModel("timelineEvent", { findMany: async () => [] });
setModel("appConfig", { upsert: async () => ({ value: "25" }) });

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const get = async (path: string, userId: string) => {
  const user = users.find((row) => row.id === userId)!;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role })}` }
  });
  return { status: response.status, json: (await response.json()) as any };
};

// Todas as rotas que o Dashboard chama (as de ranking só para gestão, mas o vendedor também não pode
// receber colegas se chamar direto) e as de "Minha semana".
const dashboardRoutes: Array<{ path: string; sellerIds: (json: any) => string[] }> = [
  { path: `/dashboard/summary?month=${MONTH}`, sellerIds: (json) => json.performance.map((row: Row) => row.sellerId) },
  { path: `/dashboard/sales-series?month=${MONTH}`, sellerIds: () => [] },
  { path: `/dashboard/portfolio?month=${MONTH}`, sellerIds: () => [] },
  { path: `/activity-kpis?month=${MONTH}`, sellerIds: (json) => json.map((row: Row) => row.sellerId) },
  { path: `/activities?month=${MONTH}&done=true`, sellerIds: (json) => json.map((row: Row) => row.ownerSellerId) },
  { path: `/reports/discipline-ranking?from=${CURRENT_WEEK.from}&to=${CURRENT_WEEK.to}`, sellerIds: (json) => json.map((row: Row) => row.sellerId) },
  { path: `/reports/discipline-ranking?from=${PREVIOUS_WEEK.from}&to=${PREVIOUS_WEEK.to}`, sellerIds: (json) => json.map((row: Row) => row.sellerId) },
  { path: `/reports/weekly-visits?weekStart=${CURRENT_WEEK.from}`, sellerIds: (json) => json.map((row: Row) => row.userId) },
  { path: `/reports/weekly-visits?weekStart=${PREVIOUS_WEEK.from}`, sellerIds: (json) => json.map((row: Row) => row.userId) },
  { path: `/reports/weekly-highlights?weekStart=${CURRENT_WEEK.from}`, sellerIds: (json) => Object.values(json).filter(Boolean).map((row: any) => row.sellerId) },
  { path: "/reports/consistency", sellerIds: (json) => json.ranking.map((row: Row) => row.sellerId) },
  { path: `/reports/score-monthly?month=${MONTH}`, sellerIds: (json) => json.items.map((row: Row) => row.userId) }
];

try {
  for (const route of dashboardRoutes) {
    const asSeller = await get(route.path, "seller-a");
    assert.equal(asSeller.status, 200, route.path);
    for (const sellerId of route.sellerIds(asSeller.json)) assert.equal(sellerId, "seller-a", `${route.path}: vendedor A recebe só A`);
    const body = JSON.stringify(asSeller.json);
    for (const marker of SELLER_B_MARKERS) assert(!body.includes(marker), `${route.path}: nada de B na resposta (${marker})`);
  }

  // Sem posição para o vendedor: o score mensal não traz rank (sai da comparação com os colegas).
  const ownScore = (await get(`/reports/score-monthly?month=${MONTH}`, "seller-a")).json.items;
  assert.equal(ownScore.length, 1);
  assert.equal("rank" in ownScore[0], false);

  // Gestão continua vendo a equipe, com posição.
  for (const viewer of ["manager-x", "director-x"]) {
    const summary = (await get(`/dashboard/summary?month=${MONTH}`, viewer)).json;
    assert.deepEqual(summary.performance.map((row: Row) => row.sellerId).sort(), ["seller-a", "seller-b"], viewer);
    const ranking = (await get(`/reports/discipline-ranking?from=${CURRENT_WEEK.from}&to=${CURRENT_WEEK.to}`, viewer)).json;
    assert.deepEqual(ranking.map((row: Row) => row.sellerId).sort(), ["seller-a", "seller-b"], viewer);
    const score = (await get(`/reports/score-monthly?month=${MONTH}`, viewer)).json.items;
    assert.deepEqual(score.map((row: Row) => [row.userId, row.rank]).sort(), [["seller-a", 2], ["seller-b", 1]], viewer);
    const visits = (await get(`/reports/weekly-visits?weekStart=${CURRENT_WEEK.from}`, viewer)).json;
    assert.deepEqual(visits.map((row: Row) => row.userId).sort(), ["seller-a", "seller-b"], viewer);
  }

  // "Minha semana" bate com a regra do planejado × concluído calculada direto em @salesforce-pro/shared.
  const now = new Date();
  const ruleTotals = (week: { from: string; to: string }) => {
    const start = br(`${week.from}T00:00`).getTime();
    const end = br(`${week.to}T23:59`).getTime();
    const totals = agendaEvents
      .filter((row) => row.sellerId === "seller-a" && row.startDateTime.getTime() >= start && row.startDateTime.getTime() <= end)
      .reduce<ReturnType<typeof shared.emptyDisciplineTotals>>(
        (acc, row) =>
          shared.addDisciplineItems(
            acc,
            shared.classifyDisciplineItems(
              { ...row, status: shared.mapAgendaDbStatusToDiscipline(row.status), completedAt: row.activities[0]?.date ?? null } as never,
              now
            )
          ),
        shared.emptyDisciplineTotals()
      );
    return { totals, rates: shared.computeDisciplineRates(totals) };
  };
  for (const week of [CURRENT_WEEK, PREVIOUS_WEEK]) {
    const [own] = (await get(`/reports/discipline-ranking?from=${week.from}&to=${week.to}`, "seller-a")).json;
    const { totals, rates } = ruleTotals(week);
    assert.deepEqual(
      [own.planned, own.executed, own.notDone, own.unresolved, own.upcoming, own.executionRate, own.punctualRate],
      [totals.planned, totals.completed, totals.notDone, totals.unresolved, totals.upcoming, rates.executionRate, rates.punctualRate],
      week.from
    );
  }
  // Semana atual: roteiro com 4 paradas (2 concluídas, 1 não realizada, 1 sem conclusão), visita concluída,
  // ligação sem conclusão e visita de sábado a fazer. 1 não realizado ≤ 20% de 6 elegíveis: neutro. 3 ÷ 5.
  const [current] = (await get(`/reports/discipline-ranking?from=${CURRENT_WEEK.from}&to=${CURRENT_WEEK.to}`, "seller-a")).json;
  assert.deepEqual([current.planned, current.executed, current.notDone, current.unresolved, current.upcoming], [7, 3, 1, 2, 1]);
  assert.equal(Math.round(current.executionRate * 100) / 100, 60);
  // Pontual: 2 de 3 concluídos no mesmo dia planejado.
  assert.equal(Math.round(current.punctualRate * 100) / 100, 66.67);

  // Visitas da semana: só as do vendedor, atual e anterior.
  const [currentVisits] = (await get(`/reports/weekly-visits?weekStart=${CURRENT_WEEK.from}`, "seller-a")).json;
  const [previousVisits] = (await get(`/reports/weekly-visits?weekStart=${PREVIOUS_WEEK.from}`, "seller-a")).json;
  assert.deepEqual([currentVisits.visitsDone, previousVisits.visitsDone, currentVisits.goal], [3, 1, 25]);
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
  globalThis.Date = RealDate;
}

console.log("SELLER_DASHBOARD_SCOPE=PASS dashboard_routes_own_only=PASS score_without_rank=PASS managers_see_all=PASS my_week_rule=PASS");
