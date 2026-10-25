import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prisma } from "../config/prisma.js";
import { aiService } from "./ai/aiService.js";
import { planningIntelligenceService } from "./planningIntelligenceService.js";

// Dados fictícios. Semana de segunda 2026-10-19 a sexta 2026-10-23, com hoje = quarta 2026-10-21 (12h em Brasília).
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

const at = (iso: string) => new Date(iso);
const client = (id: string, city: string): Row => ({
  id, name: `Cliente Ficticio ${id}`, city, state: "PR", lastPurchaseDate: at("2026-10-01T12:00:00.000Z"), lastPurchaseValue: null,
  ownerSellerId: "seller-a", financialProfile: null, openTitlesTotal: 0, overdueTitlesTotal: 0, createdAt: at("2024-01-01T12:00:00.000Z"),
});
const activity = (id: string, type: string, dueIso: string, city: string, clientId: string | null = null): Row => ({
  id, type, dueDate: at(dueIso), date: at(dueIso), city, clientId, opportunityId: null, description: `Atividade ${id}`, notes: null,
  createdAt: at("2026-10-01T12:00:00.000Z"), client: null,
});
const event = (id: string, type: string, startIso: string, city: string): Row => ({
  id, title: `Compromisso ${id}`, type, startDateTime: at(startIso), endDateTime: new Date(at(startIso).getTime() + 3_600_000), status: "agendado",
  city, clientId: null, opportunityId: null, updatedAt: at("2026-10-01T12:00:00.000Z"), stops: [],
});

let events: Row[] = [];
let opportunities: Row[] = [];
let activities: Row[] = [];
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);
setModel("agendaEvent", {
  findMany: async ({ where }: any) => events.filter((row) => row.startDateTime < where.startDateTime.lt && row.endDateTime >= where.endDateTime.gte),
});
setModel("opportunity", { findMany: async () => opportunities });
setModel("activity", { findMany: async () => activities });
// Sem cliente em cobrança e sem cliente para reativar (todos compraram há pouco).
setModel("client", { findMany: async () => [] });
setModel("erpOrderSync", { findMany: async () => [] });
setModel("sellerTerritoryCity", { findMany: async () => [] });
// Raio do agrupamento de visitas: sem configuração, o padrão.
setModel("appConfig", { findUnique: async () => null });

const generate = () => planningIntelligenceService.generateWeeklyCommercialPlan({ viewerUserId: "seller-a", viewerRole: "vendedor", weekStart: "2026-10-19", refresh: true });
const dayOf = (plan: Row, date: string) => plan.days.find((day: Row) => day.date === date);
const dateOfAction = (plan: Row, predicate: (action: Row) => boolean) => plan.days.find((day: Row) => day.suggestedActions.some(predicate))?.date;

const results: string[] = [];
try {
  // 1. Hoje = quarta: nada sugerido em segunda e terça; vencidos presos em hoje; compromissos continuam nos dias que passaram.
  events = [
    event("seg", "roteiro_visita", "2026-10-19T13:00:00.000Z", "Cidade Ficticia A"),
    // 22h30 de quinta em Brasília (sexta em UTC): fica na quinta.
    event("qui-noite", "reuniao_online", "2026-10-23T01:30:00.000Z", "Cidade Ficticia A"),
    // 22h de sexta em Brasília (sábado em UTC): ainda é sexta.
    event("sex-noite", "reuniao_online", "2026-10-24T01:00:00.000Z", "Cidade Ficticia A"),
  ];
  opportunities = [{
    id: "opp-vencida", title: "Oportunidade ficticia", value: 1000, stage: "prospeccao", followUpDate: at("2026-10-19T12:00:00.000Z"), proposalDate: null,
    lastContactAt: at("2026-10-10T12:00:00.000Z"), createdAt: at("2026-10-01T12:00:00.000Z"), clientId: "cli-opp", notes: null,
    client: client("cli-opp", "Cidade Ficticia A"), activities: [], timelineEvents: [],
  }];
  activities = [
    activity("act-vencida-semana-passada", "ligacao", "2026-10-14T12:00:00.000Z", "Cidade Ficticia A", "cli-act"),
    activity("act-futura", "ligacao", "2026-11-10T12:00:00.000Z", "Cidade Ficticia A", "cli-futura"),
  ];
  const plan = await generate() as Row;
  assert.deepEqual(plan.days.map((day: Row) => day.date), ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
  assert.equal(dayOf(plan, "2026-10-19").suggestedActions.length, 0, "segunda (passou) sem sugestões");
  assert.equal(dayOf(plan, "2026-10-20").suggestedActions.length, 0, "terça (passou) sem sugestões");
  assert.deepEqual(dayOf(plan, "2026-10-19").existingAppointments.map((a: Row) => a.id), ["seg"], "compromisso de segunda continua");
  assert.equal(dateOfAction(plan, (a) => a.opportunityId === "opp-vencida"), "2026-10-21", "follow-up vencido na segunda vai para hoje");
  assert.equal(dateOfAction(plan, (a) => a.clientId === "cli-act"), "2026-10-21", "atividade vencida na semana passada vai para hoje");
  assert(["2026-10-21", "2026-10-22", "2026-10-23"].includes(dateOfAction(plan, (a) => a.clientId === "cli-futura")), "sugestão sem data fica de hoje em diante");
  results.push("today_onwards=PASS");

  assert.deepEqual(dayOf(plan, "2026-10-22").existingAppointments.map((a: Row) => a.id), ["qui-noite"], "22h30 de quinta em Brasília fica na quinta");
  assert.deepEqual(dayOf(plan, "2026-10-23").existingAppointments.map((a: Row) => a.id), ["sex-noite"], "22h de sexta em Brasília fica na sexta");
  results.push("brazil_day_grouping=PASS");

  // 2. Texto da tela sem termo técnico.
  const FORBIDDEN = /determin|balanced|light|overloaded|morning|afternoon|Haversine|Fallback/i;
  assert.equal(plan.summary, "3 ações sugeridas para a semana e 3 compromisso(s) já na agenda.");
  assert.doesNotMatch(plan.summary, FORBIDDEN);
  const weeklySource = readFileSync(new URL("../../../web/src/components/planning/WeeklyCommercialPlan.tsx", import.meta.url), "utf8");
  const agendaSource = readFileSync(new URL("../../../web/src/components/agenda/AgendaIntelligencePanel.tsx", import.meta.url), "utf8");
  const agendaServiceSource = readFileSync(new URL("./agendaIntelligenceService.ts", import.meta.url), "utf8");
  for (const [name, source] of [["WeeklyCommercialPlan", weeklySource], ["AgendaIntelligencePanel", agendaSource]] as const) {
    assert.doesNotMatch(source, /determinístic|Fallback|Haversine|score \{/, `${name}: sem termo técnico escrito na tela`);
    assert(source.includes('"Sugestão da IA" : "Sugestão do sistema"'), `${name}: fonte como IA ou sistema`);
  }
  assert(!weeklySource.includes("{plan.workload.capacityStatus}") && weeklySource.includes('balanced: "Carga equilibrada"') && weeklySource.includes('light: "Carga leve"') && weeklySource.includes('overloaded: "Carga alta"'));
  assert(!agendaSource.includes("{item.suggestedPeriod}") && !agendaSource.includes("{data.source}") && !agendaSource.includes("{data.metrics.optimizationConfidence}</strong>"));
  assert(agendaSource.includes('morning: "Manhã"') && agendaSource.includes('afternoon: "Tarde"'));
  assert(!agendaServiceSource.includes("Análise determinística"), "resumo da Agenda Inteligente sem termo técnico");
  results.push("no_technical_text=PASS");

  // 3. Ligação e WhatsApp para a Cidade X não puxam a visita da Cidade X; compromisso presencial continua puxando.
  events = [event("sex-presencial", "roteiro_visita", "2026-10-23T13:00:00.000Z", "Cidade Ficticia Y")];
  opportunities = [];
  activities = [
    activity("act-ligacao-x", "ligacao", "2026-10-22T15:00:00.000Z", "Cidade Ficticia X", "cli-ligacao-x"),
    activity("act-whatsapp-x", "whatsapp", "2026-10-22T16:00:00.000Z", "Cidade Ficticia X", "cli-whatsapp-x"),
    activity("act-visita-x", "visita", "2026-11-10T12:00:00.000Z", "Cidade Ficticia X", "cli-visita-x"),
    activity("act-visita-y", "visita", "2026-11-10T12:00:00.000Z", "Cidade Ficticia Y", "cli-visita-y"),
  ];
  const cityPlan = await generate() as Row;
  assert.equal(dateOfAction(cityPlan, (a) => a.clientId === "cli-ligacao-x"), "2026-10-22");
  assert.equal(dateOfAction(cityPlan, (a) => a.clientId === "cli-whatsapp-x"), "2026-10-22");
  const visitX = dateOfAction(cityPlan, (a) => a.clientId === "cli-visita-x");
  assert(visitX && visitX !== "2026-10-22" && visitX >= "2026-10-21", `visita da Cidade X não vai para o dia da ligação (foi ${visitX})`);
  assert.equal(dateOfAction(cityPlan, (a) => a.clientId === "cli-visita-y"), "2026-10-23", "visita da Cidade Y fica no dia do roteiro na Cidade Y");
  results.push("calls_outside_city_grouping=PASS");

  console.log(results.join("\n"));
  console.log("planning intelligence today: ok");
} finally {
  globalThis.Date = RealDate;
}
