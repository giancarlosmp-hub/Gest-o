import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { aiService } from "../services/ai/aiService.js";
import { signAccessToken } from "../utils/jwt.js";

// Botões do Planejamento semanal: "Agendar" cria o compromisso no dia da sugestão (Brasília), "Registrar" abre a
// Nova atividade preenchida, e a sugestão tratada não volta. Dados fictícios; Prisma e IA simulados.
// Semana de segunda 2026-10-19 a sexta 2026-10-23, com hoje = quarta 2026-10-21 (12h em Brasília).
type Row = Record<string, any>;

(aiService as any).chat = async () => null;

const RealDate = Date;
const NOW = RealDate.parse("2026-10-21T15:00:00.000Z");
class FixedDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length) super(...(args as [any]));
    else super(NOW);
  }
  static now() { return NOW; }
}
globalThis.Date = FixedDate as DateConstructor;

// As funções dos botões ficam no web; import dinâmico para não sair do rootDir da API no typecheck.
const actionsModule: any = await import(new URL("../../../web/src/components/planning/weeklyPlanActions.ts", import.meta.url).href);
const { toAgendaEvent, registerHref, openHref, canActOnPlan } = actionsModule;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS);
const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "seller-a", role: "vendedor" },
  { id: "seller-b", role: "vendedor" },
];
// Título de venda vencido há 40 dias: cliente em cobrança, fora das sugestões.
const overdueTitle = { DOCTO: "DOC-FICTICIO", PARCELA: 1, DATA_VENCIMENTO: new Date(NOW - 40 * DAY_MS).toISOString(), DSCRECEITA: "VENDAS", VALOR: 10, SALDO_CAPITAL: 10 };
const client = (id: string, ownerSellerId: string, extra: Row = {}): Row => ({
  id, name: `Cliente Ficticio ${id}`, city: "Cidade Ficticia", state: "PR", ownerSellerId, tenantId: "tenant-a", isArchived: false, lastPurchaseDate: daysAgo(30),
  lastPurchaseValue: null, financialProfile: null, partnerTitles: null, openTitlesTotal: 0, overdueTitlesTotal: 0, createdAt: daysAgo(2000), ...extra,
});
const clients: Row[] = [
  client("cli-opp", "seller-a"),
  // Inativo recente (sem comprar há mais de 12 meses): sugestão de reativação, sem oportunidade.
  client("cli-reativar", "seller-a", { lastPurchaseDate: daysAgo(450) }),
  client("cli-cobranca", "seller-a", { lastPurchaseDate: daysAgo(450), partnerTitles: [overdueTitle], openTitlesTotal: 10, overdueTitlesTotal: 10 }),
  client("cli-pendente", "seller-a"),
  client("cli-b", "seller-b"),
];
const opportunity = (id: string, clientId: string, ownerSellerId: string): Row => ({
  id, title: `Oportunidade ficticia ${id}`, value: 1000, stage: "prospeccao", followUpDate: daysAgo(2), proposalDate: null, lastContactAt: daysAgo(10),
  createdAt: daysAgo(20), clientId, ownerSellerId, notes: null,
});
const opportunities: Row[] = [opportunity("opp-a", "cli-opp", "seller-a"), opportunity("opp-cobranca", "cli-cobranca", "seller-a"), opportunity("opp-b", "cli-b", "seller-b")];
const activities: Row[] = [
  // Atividade pendente criada nesta semana: a própria sugestão "Concluir atividade" continua.
  { id: "act-pendente", type: "ligacao", dueDate: new Date("2026-10-22T15:00:00.000Z"), date: new Date("2026-10-22T15:00:00.000Z"), city: "Cidade Ficticia", clientId: "cli-pendente", opportunityId: null, ownerSellerId: "seller-a", done: false, description: "Ligar", notes: null, createdAt: daysAgo(1) },
];
const agendaEvents: Row[] = [];

const clientOf = (row: Row) => clients.find((candidate) => candidate.id === row.clientId) ?? null;
const matchValue = (value: unknown, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (typeof condition !== "object") return value === condition;
  if ("in" in condition) return condition.in.includes(value);
  if ("notIn" in condition) return !condition.notIn.includes(value);
  if ("gt" in condition) return typeof value === "number" && value > condition.gt;
  const time = (value as Date).getTime();
  if ("lt" in condition && !(time < condition.lt.getTime())) return false;
  if ("lte" in condition && !(time <= condition.lte.getTime())) return false;
  if ("gte" in condition && !(time >= condition.gte.getTime())) return false;
  return true;
};
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Row[]).every((part) => matches(row, part));
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
    if (key === "client") { const related = clientOf(row); return related ? matches(related, condition) : false; }
    return matchValue(row[key], condition);
  });
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (!where?.role || row.role === where.role));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.id, role: user.role, region: null, isActive: true } : null;
  },
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findMany: async ({ where, select }: any) => clients.filter((row) => matches(row, where)).map((row) => pick(row, select)),
  findFirst: async ({ where, select }: any) => { const row = clients.find((candidate) => matches(candidate, where)); return row ? pick(row, select) : null; },
});
setModel("opportunity", {
  findMany: async ({ where, select }: any) => opportunities.filter((row) => matches(row, where)).map((row) => ({ ...pick(row, select), client: pick(clientOf(row)!, select?.client?.select), activities: [], timelineEvents: [] })),
  findFirst: async ({ where }: any) => opportunities.find((row) => matches(row, where)) ?? null,
  findUnique: async ({ where }: any) => opportunities.find((row) => row.id === where.id) ?? null,
});
setModel("activity", {
  findMany: async ({ where, select }: any) => activities.filter((row) => matches(row, where)).map((row) => ({ ...pick(row, select), client: row.clientId ? pick(clientOf(row)!, { name: true, city: true }) : null })),
  create: async ({ data }: any) => { const row = { id: `act-${activities.length + 1}`, createdAt: new Date(), ...data }; activities.push(row); return row; },
  count: async () => 0,
});
setModel("agendaEvent", {
  findMany: async ({ where }: any) => agendaEvents.filter((row) => matches(row, where)),
  create: async ({ data }: any) => {
    const { stops, ...rest } = data;
    const row = { id: `evt-${agendaEvents.length + 1}`, status: "agendado", city: null, clientId: null, opportunityId: null, notes: null, ...rest, stops: [], createdAt: new Date(), updatedAt: new Date() };
    agendaEvents.push(row);
    return row;
  },
});
setModel("timelineEvent", { create: async () => ({}) });
setModel("erpOrderSync", { findMany: async () => [] });
setModel("sellerTerritoryCity", { findMany: async () => [] });
// Visitas pela carteira (valor estimado do cliente e última visita): valores padrão e nenhuma visita registrada.
setModel("appConfig", { findMany: async () => [] });
setModel("agendaStop", { groupBy: async () => [] });
setModel("activity", { groupBy: async () => [] });
// Raio do agrupamento de visitas: sem configuração, o padrão.
setModel("appConfig", { findUnique: async () => null });
(prisma as any).$transaction = async (callback: (tx: unknown) => unknown) => callback(prisma);

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const call = async (method: string, path: string, userId: string, body?: unknown) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: (await response.json()) as any };
};
const getPlan = async (userId = "seller-a", query = "") => {
  const response = await call("GET", `/ai/commercial-planning/week?weekStart=2026-10-19&refresh=true${query}`, userId);
  assert.equal(response.status, 200);
  return response.json;
};
const findAction = (plan: Row, predicate: (action: Row) => boolean) => {
  for (const day of plan.days) {
    const action = day.suggestedActions.find(predicate);
    if (action) return { day, action };
  }
  return null;
};
const clientIdsOf = (plan: Row) => plan.days.flatMap((day: Row) => day.suggestedActions.map((action: Row) => action.clientId));
const brazilDateOf = (iso: string) => new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(0, 10);

const results: string[] = [];
try {
  const plan = await getPlan();
  assert.equal(plan.sellerId, "seller-a");
  const withOpportunity = findAction(plan, (action) => action.opportunityId === "opp-a");
  const reactivation = findAction(plan, (action) => action.clientId === "cli-reativar");
  assert(withOpportunity && reactivation, "sugestões com e sem oportunidade");
  assert(findAction(plan, (action) => action.clientId === "cli-pendente"), "atividade pendente da semana continua como sugestão");

  // 1. Cliente em cobrança fora das sugestões.
  assert(!clientIdsOf(plan).includes("cli-cobranca"), "cliente em cobrança fora do planejamento");
  results.push("collection_out=PASS");

  // 2. Agendar: compromisso no dia da sugestão em Brasília (manhã 9h, tarde 14h); a sugestão sai do planejamento.
  assert.equal(toAgendaEvent({ ...withOpportunity.action, suggestedPeriod: "afternoon" }, "2026-10-23", "seller-a").startDateTime, "2026-10-23T17:00:00.000Z");
  assert.equal(toAgendaEvent({ ...withOpportunity.action, suggestedPeriod: null }, "2026-10-23", "seller-a").startDateTime, "2026-10-23T12:00:00.000Z");
  assert.equal(toAgendaEvent({ ...withOpportunity.action, type: "visit" }, "2026-10-23", "seller-a").type, "visita", "visita entra como compromisso de Visita");
  const payload = toAgendaEvent(withOpportunity.action, withOpportunity.day.date, plan.sellerId);
  assert.equal(brazilDateOf(payload.startDateTime), withOpportunity.day.date, "início no dia da sugestão em Brasília");
  assert.equal(payload.type, "ligacao", "follow-up entra como Ligação (followup é legado)");
  const created = await call("POST", "/agenda/events", "seller-a", payload);
  assert.equal(created.status, 201);
  assert.equal(brazilDateOf(created.json.startsAt), withOpportunity.day.date);
  assert.deepEqual([agendaEvents[0].sellerId, agendaEvents[0].clientId, agendaEvents[0].opportunityId], ["seller-a", "cli-opp", "opp-a"]);
  const afterSchedule = await getPlan();
  assert(!findAction(afterSchedule, (action) => action.clientId === "cli-opp"), "sugestão agendada não reaparece");
  assert(afterSchedule.days.find((day: Row) => day.date === withOpportunity.day.date).existingAppointments.some((item: Row) => item.id === created.json.id), "vira compromisso do dia");
  results.push("schedule=PASS");

  // 3. Registrar: Nova atividade preenchida (tipo, cliente, oportunidade, data); ao salvar, a sugestão não volta.
  const withOpportunityHref = new URL(registerHref(withOpportunity.action, withOpportunity.day.date, plan.sellerId), "http://web.invalid");
  assert.equal(withOpportunityHref.pathname, "/atividades");
  assert.deepEqual(Object.fromEntries(withOpportunityHref.searchParams), { open: "create", date: withOpportunity.day.date, type: "followup", ownerSellerId: "seller-a", notes: withOpportunity.action.title, executed: "true", clientId: "cli-opp", opportunityId: "opp-a", city: "Cidade Ficticia" });
  assert.equal(openHref(withOpportunity.action), "/oportunidades/opp-a", "Abrir vai para a oportunidade");
  results.push("register_prefill=PASS");

  // 4. Sugestão sem oportunidade (reativação): só o cliente; Abrir vai para o cliente.
  const reactivationHref = new URL(registerHref(reactivation.action, reactivation.day.date, plan.sellerId), "http://web.invalid");
  assert.equal(reactivationHref.searchParams.get("clientId"), "cli-reativar");
  assert.equal(reactivationHref.searchParams.get("opportunityId"), null);
  assert.equal(reactivationHref.searchParams.get("type"), "ligacao");
  assert.equal(openHref(reactivation.action), "/clientes/cli-reativar");
  // O que a tela de Atividades envia ao salvar a atividade realizada: a data preenchida nunca passa de hoje (Brasília),
  // porque a atividade registra o que já foi feito.
  const saved = await call("POST", "/activities", "seller-a", {
    type: reactivationHref.searchParams.get("type"), notes: reactivationHref.searchParams.get("notes"), description: "Resultado ficticio da ligação",
    dueDate: new Date().toISOString(), date: new Date().toISOString(), done: true,
    clientId: reactivationHref.searchParams.get("clientId"), ownerSellerId: reactivationHref.searchParams.get("ownerSellerId"),
  });
  assert.equal(saved.status, 201);
  const afterRegister = await getPlan();
  assert(!clientIdsOf(afterRegister).includes("cli-reativar"), "sugestão registrada não volta");
  assert(findAction(afterRegister, (action) => action.clientId === "cli-pendente"), "atividade pendente segue sugerida");
  assert(!clientIdsOf(afterRegister).includes("cli-cobranca"), "cobrança continua fora");
  results.push("reactivation_client_only=PASS register_saved=PASS");

  // 5. Vendedor não age em sugestão de outro vendedor: vê só o próprio planejamento, não cria no nome do outro e
  // não registra na oportunidade do outro. Gerente e diretor criam no nome do vendedor (regra do CRM).
  const otherPlan = await getPlan("seller-a", "&sellerId=seller-b");
  assert.equal(otherPlan.sellerId, "seller-a");
  assert(!clientIdsOf(otherPlan).includes("cli-b"));
  assert.equal(canActOnPlan({ id: "seller-a", role: "vendedor" }, "seller-b"), false);
  assert.equal(canActOnPlan({ id: "seller-a", role: "vendedor" }, "seller-a"), true);
  assert.equal(canActOnPlan({ id: "director-a", role: "diretor" }, "seller-b"), true);
  // Cliente de outra carteira: aceito só pela oportunidade do próprio vendedor; oportunidade de outro vendedor é 403.
  const eventsBeforeForged = agendaEvents.length;
  const forged = await call("POST", "/agenda/events", "seller-a", { ...payload, clientId: "cli-b", opportunityId: "opp-b", ownerSellerId: "seller-b" });
  assert.equal(forged.status, 403, "oportunidade de outro vendedor");
  assert.equal(forged.json.message, "Cliente fora da sua carteira.");
  assert.equal(agendaEvents.length, eventsBeforeForged, "nada criado");
  opportunities.push(opportunity("opp-a-cli-b", "cli-b", "seller-a"));
  const ownOpportunity = await call("POST", "/agenda/events", "seller-a", { ...payload, clientId: "cli-b", opportunityId: "opp-a-cli-b", ownerSellerId: "seller-b" });
  assert.equal(ownOpportunity.status, 201, "oportunidade do vendedor em cliente de outra carteira");
  assert.deepEqual([agendaEvents.at(-1)!.sellerId, agendaEvents.at(-1)!.clientId], ["seller-a", "cli-b"], "vendedor não cria na agenda de outro");
  opportunities.pop();
  const forgedActivity = await call("POST", "/activities", "seller-a", { type: "ligacao", notes: "Ficticio", dueDate: "2026-10-22T12:00:00.000Z", opportunityId: "opp-b", ownerSellerId: "seller-b" });
  assert.equal(forgedActivity.status, 404, "oportunidade de outro vendedor");
  const directorPlan = await getPlan("director-a", "&sellerId=seller-b");
  assert.equal(directorPlan.sellerId, "seller-b");
  const directorBAction = findAction(directorPlan, (action) => action.opportunityId === "opp-b");
  assert(directorBAction);
  const byDirector = await call("POST", "/agenda/events", "director-a", toAgendaEvent(directorBAction.action, directorBAction.day.date, directorPlan.sellerId));
  assert.equal(byDirector.status, 201);
  assert.equal(agendaEvents.at(-1)!.sellerId, "seller-b", "diretor agenda no nome do vendedor do planejamento");
  results.push("seller_scope=PASS");

  // 6. Tela: botões no padrão da "Minha IA Comercial", sem WhatsApp neste passo; Atividades abre como realizada.
  const weeklySource = readFileSync(new URL("../../../web/src/components/planning/WeeklyCommercialPlan.tsx", import.meta.url), "utf8");
  const activitiesSource = readFileSync(new URL("../../../web/src/pages/ActivitiesPage.tsx", import.meta.url), "utf8");
  for (const label of [">{scheduling ? \"Agendando…\" : \"Agendar\"}</button>", ">Registrar</Link>", ">Abrir</Link>"]) assert(weeklySource.includes(label), label);
  assert(!weeklySource.includes("/whatsapp"), "sem botão de WhatsApp");
  // Nova atividade é sempre realizada (Agenda planeja, Atividades registram o que foi feito): desde o #989 não há campo
  // "realizada" no formulário; a criação manda done: true fixo e nenhum caminho cria pendente.
  assert.match(activitiesSource, /api\.post\("\/activities", \{\s*\.\.\.payload,\s*done: true,/, "criação sempre realizada");
  assert.equal(activitiesSource.match(/api\.post\("\/activities"/g)?.length, 1, "um só caminho de criação");
  assert.doesNotMatch(activitiesSource, /done: false|done: form\.|done: !/, "nenhuma atividade criada como pendente");
  results.push("screen=PASS");

  console.log(`WEEKLY_PLAN_ACTIONS=PASS ${results.join(" ")}`);
} finally {
  server.close();
  globalThis.Date = RealDate;
}
