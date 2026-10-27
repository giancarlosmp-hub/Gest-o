import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prisma } from "../config/prisma.js";
import { aiService } from "./ai/aiService.js";
import { agendaIntelligenceService } from "./agendaIntelligenceService.js";
import { planningIntelligenceService } from "./planningIntelligenceService.js";

// Ajustes da Agenda: janela do "Agendar", horário de Brasília em todos os blocos, próximos 5 dias úteis e
// follow-up/ligação fora da contagem de visitas. Dados fictícios; Prisma e IA simulados.
// Hoje = sexta 2026-10-23, 12h em Brasília (15h UTC).
type Row = Record<string, any>;

(aiService as any).chat = async () => null;

const RealDate = Date;
const NOW = RealDate.parse("2026-10-23T15:00:00.000Z");
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
const { toAgendaEvent, defaultScheduleTime } = actionsModule;

const at = (iso: string) => new Date(iso);
const event = (id: string, type: string, startIso: string, minutes: number, city: string | null): Row => ({
  id, title: `Compromisso ${id}`, type, startDateTime: at(startIso), endDateTime: new Date(at(startIso).getTime() + minutes * 60_000), status: "agendado",
  city, clientId: null, opportunityId: null, client: null, opportunity: null, updatedAt: at("2026-10-01T12:00:00.000Z"), stops: [],
});
const activity = (id: string, type: string, dueIso: string, city: string): Row => ({
  id, type, dueDate: at(dueIso), date: at(dueIso), city, clientId: `cli-${id}`, opportunityId: null, description: `Atividade ${id}`, notes: null,
  createdAt: at("2026-10-01T12:00:00.000Z"), client: null,
});

let events: Row[] = [];
let activities: Row[] = [];
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);
setModel("agendaEvent", {
  findMany: async ({ where }: any) => events.filter((row) => {
    const before = where.startDateTime.lt ? row.startDateTime < where.startDateTime.lt : row.startDateTime <= where.startDateTime.lte;
    return before && row.endDateTime >= where.endDateTime.gte;
  }),
});
setModel("opportunity", { findMany: async () => [] });
setModel("activity", { findMany: async () => activities });
setModel("client", { findMany: async () => [] });
setModel("erpOrderSync", { findMany: async () => [] });
setModel("sellerTerritoryCity", { findMany: async () => [] });
// Visitas pela carteira (valor estimado do cliente e última visita): valores padrão e nenhuma visita registrada.
setModel("appConfig", { findMany: async () => [] });
setModel("agendaStop", { groupBy: async () => [] });
setModel("activity", { groupBy: async () => [] });
// Raio do agrupamento de visitas: sem configuração, o padrão.
setModel("appConfig", { findUnique: async () => null });

const seller = { viewerUserId: "seller-a", viewerRole: "vendedor" };
const results: string[] = [];
try {
  // 1. Janela do "Agendar": manhã às 09:00, tarde às 14:00, período flexível às 09:00; dia, horário e duração editáveis.
  const action = { type: "call", clientId: "cli-x", opportunityId: null, title: "Ligar: Cliente Ficticio", city: "Cidade Ficticia", score: 50, priorityLevel: "normal", reason: "Motivo", objective: "Objetivo", suggestedPeriod: "morning", estimatedDurationMinutes: 20, source: "priority" };
  assert.equal(defaultScheduleTime(action), "09:00");
  assert.equal(defaultScheduleTime({ ...action, suggestedPeriod: "afternoon" }), "14:00");
  assert.equal(defaultScheduleTime({ ...action, suggestedPeriod: null }), "09:00");
  const morning = toAgendaEvent(action, "2026-10-26", "seller-a");
  assert.equal(morning.startDateTime, "2026-10-26T12:00:00.000Z", "09:00 de Brasília");
  assert.equal(morning.endDateTime, "2026-10-26T12:20:00.000Z", "duração da sugestão");
  const edited = toAgendaEvent(action, "2026-10-27", "seller-a", "15:30", 45);
  assert.equal(edited.startDateTime, "2026-10-27T18:30:00.000Z", "dia e horário editados, em Brasília");
  assert.equal(edited.endDateTime, "2026-10-27T19:15:00.000Z", "duração editada");
  const weeklySource = readFileSync(new URL("../../../web/src/components/planning/WeeklyCommercialPlan.tsx", import.meta.url), "utf8");
  assert(weeklySource.includes("onSchedule={() => openSchedule(day.date, action, key)}"), "Agendar abre a janela em vez de gravar");
  assert(weeklySource.includes('>Cancelar</button>') && weeklySource.includes('{saving ? "Agendando…" : "Confirmar"}'), "janela com Confirmar e Cancelar");
  assert(weeklySource.includes('type="date"') && weeklySource.includes('type="time"') && weeklySource.includes("Duração (min)"));
  results.push("schedule_dialog_times=PASS");

  // 2. Compromisso às 09:00 de Brasília aparece 09:00 na Sugestão operacional, no Assistente e no Planejamento.
  events = [event("visita-9h", "reuniao_presencial", "2026-10-23T12:00:00.000Z", 60, "Cidade Ficticia A")];
  activities = [];
  const day = await agendaIntelligenceService.generateAgendaOptimization({ ...seller, date: "2026-10-23", refresh: true });
  assert.equal(day.currentSchedule[0].fixedStartTime, "09:00", "Sugestão operacional do dia");
  assert.equal(day.currentSchedule[0].fixedEndTime, "10:00");
  const assistant = await agendaIntelligenceService.listDaySchedule({ ...seller, date: "2026-10-23" });
  assert.equal(assistant.currentSchedule[0].fixedStartTime, "09:00", "Assistente Comercial");
  const plan = await planningIntelligenceService.generateWeeklyCommercialPlan({ ...seller, refresh: true });
  const appointment = plan.days.find((planDay) => planDay.date === "2026-10-23")!.existingAppointments[0];
  assert.equal(new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date(appointment.startsAt)), "09:00", "Planejamento");
  assert(weeklySource.includes('timeZone: "America/Sao_Paulo"'), "Planejamento formata o horário em Brasília");
  // 22h de Brasília continua no mesmo dia e às 22:00.
  events = [event("noite", "followup", "2026-10-24T01:00:00.000Z", 15, null)];
  const night = await agendaIntelligenceService.generateAgendaOptimization({ ...seller, date: "2026-10-23", refresh: true });
  assert.equal(night.currentSchedule[0].fixedStartTime, "22:00");
  results.push("brazil_time_all_blocks=PASS");

  // 3. Hoje = sexta: sugestões de sexta até a quinta seguinte, no máximo 8 ações e 3 visitas por dia.
  events = [];
  activities = [
    ...Array.from({ length: 12 }, (_, index) => activity(`visita-${index}`, "visita", "2026-11-30T12:00:00.000Z", `Cidade Ficticia ${index}`)),
    ...Array.from({ length: 16 }, (_, index) => activity(`ligacao-${index}`, "ligacao", "2026-11-30T12:00:00.000Z", "Cidade Ficticia Z")),
    activity("vence-sabado", "ligacao", "2026-10-24T12:00:00.000Z", "Cidade Ficticia Z"),
  ];
  const rolling = await planningIntelligenceService.generateWeeklyCommercialPlan({ ...seller, refresh: true });
  assert.deepEqual(rolling.days.map((planDay) => planDay.date), ["2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]);
  assert.deepEqual(rolling.days.map((planDay) => planDay.label), ["Sexta-feira", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira"]);
  assert.equal(rolling.weekStart, "2026-10-23");
  assert.equal(rolling.weekEnd, "2026-10-29");
  for (const planDay of rolling.days) {
    assert(planDay.suggestedActions.length <= 8, `${planDay.date}: no máximo 8 ações`);
    assert(planDay.suggestedActions.filter((item) => item.type === "visit").length <= 3, `${planDay.date}: no máximo 3 visitas`);
  }
  assert(rolling.days.slice(1).every((planDay) => planDay.suggestedActions.length > 0), "a semana seguinte também recebe sugestões");
  assert.equal(rolling.days.find((planDay) => planDay.suggestedActions.some((item) => item.clientId === "cli-vence-sabado"))?.date, "2026-10-26", "vencimento no sábado vai para a segunda");
  assert.match(rolling.summary, /para os próximos 5 dias úteis/);
  results.push("rolling_business_days=PASS");

  // 4. Follow-up e ligação não contam como visita: dia com 4 follow-ups ainda recebe 3 visitas, e a Sugestão
  // operacional não pede coordenada nem acusa excesso de visitas por causa deles.
  events = Array.from({ length: 5 }, (_, index) => event(`followup-${index}`, "followup", `2026-10-23T1${2 + (index % 2)}:${index}0:00.000Z`, 10, null));
  events.push(event("visita", "reuniao_presencial", "2026-10-23T17:00:00.000Z", 60, "Cidade Ficticia A"));
  activities = Array.from({ length: 3 }, (_, index) => activity(`visita-hoje-${index}`, "visita", "2026-10-23T12:00:00.000Z", "Cidade Ficticia A"));
  const withFollowUps = await planningIntelligenceService.generateWeeklyCommercialPlan({ ...seller, refresh: true });
  const friday = withFollowUps.days[0];
  assert.equal(friday.date, "2026-10-23");
  assert.equal(friday.suggestedActions.filter((item) => item.type === "visit").length, 2, "1 visita marcada + 2 sugeridas = 3; follow-ups não ocupam vaga de visita");
  const followUpDay = await agendaIntelligenceService.generateAgendaOptimization({ ...seller, date: "2026-10-23", refresh: true });
  assert.equal(followUpDay.currentSchedule.filter((item) => item.isVisit).length, 1);
  assert.match(followUpDay.summary, /1 visita\(s\) e 5 outro\(s\) compromisso\(s\)/);
  assert.equal(followUpDay.conflicts.filter((conflict) => conflict.type === "missing_location").length, 1, "só a visita pede localização");
  assert(!followUpDay.conflicts.some((conflict) => conflict.type === "over_capacity"), "follow-ups não viram excesso de visitas");
  results.push("follow_up_not_visit=PASS");

  // 5. Vendedor vê só a ordem do dia em linguagem simples.
  const panelSource = readFileSync(new URL("../../../web/src/components/agenda/AgendaIntelligencePanel.tsx", import.meta.url), "utf8");
  const sellerView = panelSource.slice(panelSource.indexOf("function SellerDayOrder"), panelSource.indexOf("export default function"));
  assert(sellerView.length > 0 && panelSource.includes("{data && isSeller ? <SellerDayOrder data={data} /> : null}"));
  assert.doesNotMatch(sellerView, /[Ff]ixo|coordenada|Confiança|Paradas|Reordenável|prioridade/);
  results.push("seller_simple_order=PASS");

  console.log(`AGENDA_SCHEDULE_TIMEZONE=PASS ${results.join(" ")}`);
} finally {
  globalThis.Date = RealDate;
}
