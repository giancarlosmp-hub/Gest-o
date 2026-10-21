import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: rotas de score e ranking devolvem ao vendedor só a própria linha, filtrando no
// servidor. Os fakes ignoram o filtro de vendedor de propósito: o banco devolve o time inteiro.
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const MONTH = new Date().toISOString().slice(0, 7);
const mondayKey = () => {
  const today = new Date();
  const offset = (today.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset)).toISOString().slice(0, 10);
};

const users: Row[] = [
  { id: "director-x", name: "Diretora Ficticia", role: "diretor", isActive: true },
  { id: "manager-x", name: "Gerente Ficticio", role: "gerente", isActive: true },
  { id: "seller-a", name: "Vendedor Ficticio Alfa", role: "vendedor", isActive: true },
  { id: "seller-b", name: "Vendedora Ficticia Beta", role: "vendedor", isActive: true },
];
const SELLER_B_MARKERS = ["seller-b", "Vendedora Ficticia Beta", "98765", "55555"];

const wonOpportunities: Row[] = [
  { id: "opp-a", ownerSellerId: "seller-a", value: 1234 },
  { id: "opp-b", ownerSellerId: "seller-b", value: 98765 },
].map((row) => ({ ...row, stage: "ganho", client: { tenantId: "tenant-x" } }));
const openOpportunities: Row[] = [
  { id: "open-a", ownerSellerId: "seller-a", value: 500, probability: 50, followUpDate: daysAgo(-3) },
  { id: "open-b", ownerSellerId: "seller-b", value: 4000, probability: 50, followUpDate: daysAgo(-3) },
];
const bySeller = (counts: Record<string, number>, key = "ownerSellerId") =>
  Object.entries(counts).map(([sellerId, count]) => ({ [key]: sellerId, _count: { _all: count } }));

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const matchesUser = (user: Row, where: Row = {}) =>
  (where.role === undefined || user.role === where.role) &&
  (where.isActive === undefined || user.isActive === where.isActive) &&
  (where.id === undefined || (typeof where.id === "string" ? user.id === where.id : (where.id.in as string[]).includes(user.id)));

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, email: `${user.id}@test.invalid`, role: user.role, region: null } : null;
  },
  findMany: async ({ where }: any) => users.filter((user) => matchesUser(user, where)),
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-x" }] : []) });
setModel("opportunity", {
  findMany: async ({ where }: any) => (where?.stage === "ganho" ? wonOpportunities : openOpportunities),
  groupBy: async () => bySeller({ "seller-a": 1, "seller-b": 3 }),
});
setModel("erpOrderSync", { findMany: async () => [] });
setModel("goal", { findMany: async () => [{ sellerId: "seller-a", targetValue: 2000 }, { sellerId: "seller-b", targetValue: 55555 }] });
setModel("agendaEvent", { groupBy: async () => bySeller({ "seller-a": 4, "seller-b": 30 }, "sellerId") });
setModel("timelineEvent", { findMany: async () => [] });
setModel("activity", {
  findMany: async () => [],
  groupBy: async () => bySeller({ "seller-a": 2, "seller-b": 27 }),
});
setModel("appConfig", { upsert: async () => ({ value: "25" }) });

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const get = async (path: string, userId: string) => {
  const user = users.find((row) => row.id === userId)!;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role })}` },
  });
  return { status: response.status, json: (await response.json()) as any };
};

const routes: Array<{ path: string; rows: (json: any) => Row[]; idKey: string }> = [
  { path: `/reports/commercial-score?month=${MONTH}`, rows: (json) => json.sellers, idKey: "sellerId" },
  { path: `/reports/score-monthly?month=${MONTH}`, rows: (json) => json.items, idKey: "userId" },
  { path: `/reports/weekly-missions?weekStart=${mondayKey()}`, rows: (json) => json, idKey: "userId" },
  { path: `/reports/weekly-visits?weekStart=${mondayKey()}`, rows: (json) => json, idKey: "userId" },
];

try {
  for (const route of routes) {
    const asSeller = await get(route.path, "seller-a");
    assert.equal(asSeller.status, 200, route.path);
    assert.deepEqual(route.rows(asSeller.json).map((row) => row[route.idKey]), ["seller-a"], `${route.path}: vendedor A recebe só A`);
    const body = JSON.stringify(asSeller.json);
    for (const marker of SELLER_B_MARKERS) assert(!body.includes(marker), `${route.path}: nada de B na resposta (${marker})`);

    for (const viewer of ["manager-x", "director-x"]) {
      const asViewer = await get(route.path, viewer);
      assert.equal(asViewer.status, 200, `${route.path} (${viewer})`);
      assert.deepEqual(route.rows(asViewer.json).map((row) => row[route.idKey]).sort(), ["seller-a", "seller-b"], `${route.path}: ${viewer} recebe todos`);
    }
  }

  // O score do vendedor continua calculado sobre o time: igual ao que o gerente vê para ele.
  const ownScore = (await get(`/reports/score-monthly?month=${MONTH}`, "seller-a")).json.items[0];
  const managerScore = (await get(`/reports/score-monthly?month=${MONTH}`, "manager-x")).json.items.find((row: Row) => row.userId === "seller-a");
  assert.equal(ownScore.score, managerScore.score);

  // Missões: o vendedor recebe todas as próprias missões, não só a principal.
  const missions = (await get(`/reports/weekly-missions?weekStart=${mondayKey()}`, "seller-a")).json;
  assert.equal(missions[0].missions.length, 4);
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("SELLER_SCORE_SCOPE=PASS commercial_score=PASS score_monthly=PASS weekly_missions=PASS weekly_visits=PASS managers_see_all=PASS");
