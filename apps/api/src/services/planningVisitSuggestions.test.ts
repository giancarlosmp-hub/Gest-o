import assert from "node:assert/strict";
import { prisma } from "../config/prisma.js";
import { aiService } from "./ai/aiService.js";
import { planningIntelligenceService } from "./planningIntelligenceService.js";

// Visitas sugeridas pelo valor estimado do cliente (decisão da diretoria de 26/10/2026), com dados fictícios e Prisma e
// IA simulados. Hoje = terça 2026-10-27 (12h em Brasília); semana futura de segunda 2026-11-02 a sexta 2026-11-06, com
// todos os dias abertos. Padrões: faixa 1 = R$ 20.000 (45 dias), faixa 2 = R$ 5.000 (90 dias), oportunidade R$ 20.000.
type Row = Record<string, any>;

(aiService as any).chat = async () => null;

const RealDate = Date;
const NOW = RealDate.parse("2026-10-27T15:00:00.000Z");
class FixedDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length) super(...(args as [any]));
    else super(NOW);
  }
  static now() { return NOW; }
}
globalThis.Date = FixedDate as DateConstructor;

const WEEK = "2026-11-02";
const at = (iso: string) => new Date(iso);
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000);
const RECENT_PURCHASE = "2026-09-01T12:00:00.000Z";

// Cliente fictício em Toledo/PR. value = VALOR_ULTFATURA da última fatura (nos 365 dias quando a compra é recente).
const client = (id: string, value: number | null, lastPurchaseIso: string | null = RECENT_PURCHASE): Row => ({
  id, name: `Cliente Ficticio ${id}`, city: "Toledo", state: "PR", lastPurchaseDate: lastPurchaseIso ? at(lastPurchaseIso) : null, lastPurchaseValue: null,
  ownerSellerId: "seller-a", financialProfile: value === null ? null : { DATA_ULTFATURA: lastPurchaseIso ?? RECENT_PURCHASE, VALOR_ULTFATURA: value },
  openTitlesTotal: 0, overdueTitlesTotal: 0, createdAt: at("2024-01-01T12:00:00.000Z"),
});
const opportunity = (id: string, clientRow: Row, stage: string, value: number, followUpIso = "2026-11-25T15:00:00.000Z"): Row => ({
  id, title: `Oportunidade ${id}`, value, stage, followUpDate: at(followUpIso), proposalDate: at("2026-10-01T12:00:00.000Z"), lastContactAt: at("2026-10-20T12:00:00.000Z"),
  createdAt: at("2026-10-01T12:00:00.000Z"), clientId: clientRow.id, notes: null, client: clientRow, activities: [], timelineEvents: [],
});
const event = (id: string, type: string, startIso: string, stops: Row[] = [], clientId: string | null = null): Row => ({
  id, title: `Compromisso ${id}`, type, startDateTime: at(startIso), endDateTime: new Date(at(startIso).getTime() + 3_600_000), status: "agendado",
  city: "Toledo", clientId, opportunityId: null, updatedAt: at("2026-10-01T12:00:00.000Z"), stops,
});

let clients: Row[] = [];
let openOpportunities: Row[] = [];
let wonOpportunities: Row[] = [];
let pendingActivities: Row[] = [];
let visitActivities: Array<{ clientId: string; date: Date }> = [];
let stopCheckOuts: Array<{ clientId: string; checkOutAt: Date }> = [];
let events: Row[] = [];
let rules: Row[] = [];
const reset = () => { clients = []; openOpportunities = []; wonOpportunities = []; pendingActivities = []; visitActivities = []; stopCheckOuts = []; events = []; rules = []; };

const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);
setModel("client", { findMany: async () => clients });
setModel("opportunity", { findMany: async ({ where }: any) => (where.stage === "ganho" ? wonOpportunities : openOpportunities) });
setModel("activity", {
  findMany: async ({ where }: any) => (where.done === false ? pendingActivities : []),
  groupBy: async ({ where }: any) => (where.date === null ? [] : visitActivities.map((row) => ({ clientId: row.clientId, _max: { date: row.date } }))),
});
setModel("agendaStop", { groupBy: async () => stopCheckOuts.map((row) => ({ clientId: row.clientId, _max: { checkOutAt: row.checkOutAt } })) });
setModel("agendaEvent", { findMany: async () => events });
setModel("erpOrderSync", { findMany: async () => [] });
setModel("sellerTerritoryCity", { findMany: async () => [] });
setModel("appConfig", { findUnique: async () => null, findMany: async () => rules });

const generate = () => planningIntelligenceService.generateWeeklyCommercialPlan({ viewerUserId: "seller-a", viewerRole: "vendedor", weekStart: WEEK, refresh: true }) as Promise<Row>;
const planned = (plan: Row) => plan.days.flatMap((day: Row) => day.suggestedActions);
const actionsOf = (plan: Row, clientId: string) => [...planned(plan), ...plan.unallocatedPriorities].filter((action: Row) => action.clientId === clientId);
const typesOf = (plan: Row, clientId: string) => actionsOf(plan, clientId).map((action: Row) => action.type).sort();

const results: string[] = [];

// Critérios 1, 2, 3 e 5, atividade pendente de visita antiga e cliente com compromisso na semana.
{
  reset();
  const t1Old = client("t1-old", 25000);
  const t1Recent = client("t1-recent", 25000);
  const t2Old = client("t2-old", 8000);
  const t2Mid = client("t2-mid", 8000);
  const never = client("never", 6000);
  const low = client("low", 3000);
  const cooling = client("cooling", 7000, "2025-12-20T12:00:00.000Z");
  const coolingLow = client("cooling-low", 2000, "2025-12-20T12:00:00.000Z");
  const inactive = client("inactive", null, "2025-08-01T12:00:00.000Z");
  const scheduled = client("scheduled", 25000);
  const pending = client("pending", null);
  clients = [t1Old, t1Recent, t2Old, t2Mid, never, low, cooling, coolingLow, inactive, scheduled, pending];
  // Inativo recente com ganho no CRM nos 365 dias: valor estimado alto, mas continua ligação (critério 5).
  wonOpportunities = [{ id: "won-inactive", clientId: "inactive", value: 30000, client: { tenantId: "tenant-a" } }];
  visitActivities = [
    { clientId: "t1-old", date: daysAgo(50) },
    { clientId: "t1-recent", date: daysAgo(30) },
    { clientId: "t2-mid", date: daysAgo(60) },
    { clientId: "cooling", date: daysAgo(20) },
  ];
  stopCheckOuts = [{ clientId: "t2-old", checkOutAt: daysAgo(100) }];
  pendingActivities = [{
    id: "act-pending", type: "visita", dueDate: at("2026-12-01T15:00:00.000Z"), date: null, city: "Toledo", clientId: "pending", opportunityId: null,
    description: "Visita antiga pendente", notes: null, createdAt: at("2026-09-01T12:00:00.000Z"), client: { name: "Cliente Ficticio pending", city: "Toledo", state: "PR" },
  }];
  events = [event("evt-call", "ligacao", "2026-11-04T13:00:00.000Z", [], "scheduled")];
  const plan = await generate();

  assert.deepEqual(typesOf(plan, "t1-old"), ["visit"], "critério 1: faixa 1 e 50 dias sem visita");
  assert.match(actionsOf(plan, "t1-old")[0].reason, /Valor estimado do cliente a partir de R\$\s?20\.000; 50 dias sem visita/);
  assert.deepEqual(typesOf(plan, "t1-recent"), [], "faixa 1 com 30 dias sem visita: nada");
  assert.deepEqual(typesOf(plan, "t2-old"), ["visit"], "critério 2: faixa 2 e 100 dias desde o último check-out");
  assert.match(actionsOf(plan, "t2-old")[0].reason, /a partir de R\$\s?5\.000; 100 dias sem visita/);
  assert.deepEqual(typesOf(plan, "t2-mid"), [], "faixa 2 com 60 dias sem visita: nada");
  assert.deepEqual(typesOf(plan, "never"), ["visit"], "faixa 2 nunca visitado");
  assert.match(actionsOf(plan, "never")[0].reason, /sem visita registrada/);
  assert.deepEqual(typesOf(plan, "low"), [], "abaixo da faixa 2: nada");
  assert.deepEqual(typesOf(plan, "cooling"), ["visit"], "critério 3: esfriando a partir da faixa 2 recebe visita em vez de ligação");
  assert.match(actionsOf(plan, "cooling")[0].reason, /Cliente esfriando/);
  assert.deepEqual(typesOf(plan, "cooling-low"), ["call"], "esfriando abaixo da faixa 2 continua ligação");
  assert.deepEqual(typesOf(plan, "inactive"), ["call"], "critério 5: inativo recente continua ligação");
  assert.deepEqual(typesOf(plan, "scheduled"), [], "cliente com compromisso na semana sai das sugestões");
  assert.deepEqual(typesOf(plan, "pending"), ["visit"], "atividade pendente de visita antiga continua gerando visita");
  assert(actionsOf(plan, "t1-old").every((action: Row) => action.title === "Visitar: Cliente Ficticio t1-old"));
  for (const action of planned(plan)) assert(!/faturamento|valor comprado/i.test(action.reason), "não chama de faturamento nem de valor comprado");
  results.push("criteria_1_2_3_5=PASS");

  // Valores alterados pelo gerente: faixa 1 = 30.000 tira o t1-old da faixa 1 (50 dias ainda não chega aos 90 da faixa 2).
  rules = [{ key: "planning.visitTier1MinEstimatedValue", value: "30000" }];
  const changed = await generate();
  assert.deepEqual(typesOf(changed, "t1-old"), [], "faixa configurada vale na próxima geração");
  results.push("configured_tiers=PASS");
}

// Critério 4: oportunidade em proposta ou negociação a partir de R$ 20.000 troca ligação/revisão por visita; proposta
// continua proposta e follow-up vencido continua follow-up.
{
  reset();
  const neg = client("neg-big", 0);
  const negSmall = client("neg-small", 0);
  const prop = client("prop-big", 0);
  const overdue = client("overdue-big", 0);
  clients = [neg, negSmall, prop, overdue];
  openOpportunities = [
    opportunity("o-neg-big", neg, "negociacao", 25000),
    opportunity("o-neg-small", negSmall, "negociacao", 10000),
    opportunity("o-prop-big", prop, "proposta", 50000),
    opportunity("o-overdue-big", overdue, "negociacao", 50000, "2026-10-20T15:00:00.000Z"),
  ];
  const plan = await generate();
  assert.deepEqual(typesOf(plan, "neg-big"), ["visit"], "negociação a partir de R$ 20.000: visita");
  assert.match(actionsOf(plan, "neg-big")[0].reason, /Oportunidade em negociação a partir de R\$\s?20\.000/);
  assert.equal(actionsOf(plan, "neg-big")[0].opportunityId, "o-neg-big");
  assert.equal(actionsOf(plan, "neg-small").length, 1);
  assert(["call", "review"].includes(actionsOf(plan, "neg-small")[0].type), "abaixo do valor: continua ligação ou revisão");
  assert.deepEqual(typesOf(plan, "prop-big"), ["proposal"], "proposta continua proposta");
  assert.deepEqual(typesOf(plan, "overdue-big"), ["follow_up"], "follow-up vencido continua follow-up");
  results.push("criterion_4=PASS");
}

// Limite de 3 visitas por dia contando paradas de roteiro (roteiro sem parada conta 1) e contador de visitas da carga
// (sugeridas + já marcadas na Agenda).
{
  reset();
  clients = Array.from({ length: 12 }, (_, index) => client(`cap-${index + 1}`, 25000));
  events = [
    // Segunda: roteiro com 2 paradas + visita = 3 visitas; dia cheio.
    event("evt-route", "roteiro_visita", "2026-11-02T11:00:00.000Z", [{ clientId: null, city: "Toledo" }, { clientId: null, city: "Toledo" }]),
    event("evt-visit", "visita", "2026-11-02T17:00:00.000Z"),
    // Terça: roteiro sem paradas conta 1.
    event("evt-empty-route", "roteiro_visita", "2026-11-03T11:00:00.000Z"),
  ];
  const plan = await generate();
  const suggestedVisits = (date: string) => plan.days.find((day: Row) => day.date === date).suggestedActions.filter((action: Row) => action.type === "visit").length;
  assert.equal(suggestedVisits("2026-11-02"), 0, "segunda já tem 3 visitas na Agenda (2 paradas + 1 visita)");
  assert.equal(suggestedVisits("2026-11-03"), 2, "terça: roteiro sem paradas conta 1");
  for (const date of ["2026-11-04", "2026-11-05", "2026-11-06"]) assert.equal(suggestedVisits(date), 3, `até 3 visitas em ${date}`);
  assert.equal(plan.unallocatedPriorities.filter((action: Row) => action.type === "visit").length, 1, "a 12ª visita fica sem dia");
  assert.equal(plan.workload.visits, 11 + 3 + 1, "carga: 11 sugeridas + 3 da segunda + 1 da terça");
  results.push("max_3_per_day_with_stops_and_workload=PASS");
}

// Ordem do plano: vendedor com mais de 30 ligações/revisões e 5 clientes para visita. As visitas entram, e os
// follow-ups vencidos e as propostas não saem.
{
  reset();
  const callClients = Array.from({ length: 35 }, (_, index) => client(`call-${index + 1}`, 0));
  const followClients = Array.from({ length: 3 }, (_, index) => client(`follow-${index + 1}`, 0));
  const proposalClients = Array.from({ length: 2 }, (_, index) => client(`proposal-${index + 1}`, 0));
  const visitClients = Array.from({ length: 5 }, (_, index) => client(`visit-${index + 1}`, 25000));
  clients = [...callClients, ...followClients, ...proposalClients, ...visitClients];
  openOpportunities = [
    ...callClients.map((row, index) => opportunity(`o-call-${index + 1}`, row, index % 2 ? "negociacao" : "prospeccao", 5000)),
    ...followClients.map((row, index) => opportunity(`o-follow-${index + 1}`, row, "negociacao", 5000, "2026-10-20T15:00:00.000Z")),
    ...proposalClients.map((row, index) => opportunity(`o-proposal-${index + 1}`, row, "proposta", 8000)),
  ];
  const plan = await generate();
  const placed = planned(plan);
  assert(placed.filter((action: Row) => action.type === "call" || action.type === "review").length >= 1, "há ligações/revisões no plano");
  for (const row of visitClients) assert.deepEqual(placed.filter((action: Row) => action.clientId === row.id).map((action: Row) => action.type), ["visit"], `${row.id} entra no plano`);
  for (const row of followClients) assert.deepEqual(placed.filter((action: Row) => action.clientId === row.id).map((action: Row) => action.type), ["follow_up"], `${row.id} não sai`);
  for (const row of proposalClients) assert.deepEqual(placed.filter((action: Row) => action.clientId === row.id).map((action: Row) => action.type), ["proposal"], `${row.id} não sai`);
  assert.equal(plan.workload.visits, 5);
  assert.equal(placed.length, 30, "follow-ups, propostas e visitas primeiro; ligações e revisões completam até 30 ações");
  results.push("visits_not_cut_by_calls=PASS");
}

console.log(results.join("\n"));
