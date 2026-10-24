import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { brazilDayKeyOfInput, isFutureBrazilDay, pendingAgendaWindowStart } from "../services/agendaActivityRules.js";
import { signAccessToken } from "../utils/jwt.js";

// Agenda (planejamento) x Atividades (execução), PR 2: regras da API. Dados fictícios; Prisma simulado.
// Hoje = sexta 2026-10-23, 12h em Brasília (15h UTC).
type Row = Record<string, any>;

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

const DAY_MS = 86_400_000;
const at = (iso: string) => new Date(iso);
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS);

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" },
  { id: "seller-b", role: "vendedor" },
];
const clients: Row[] = [
  { id: "cli-a", name: "Cliente Ficticio A", ownerSellerId: "seller-a" },
  { id: "cli-b", name: "Cliente Ficticio B", ownerSellerId: "seller-b" },
];
const opportunities: Row[] = [
  { id: "opp-open", title: "Oportunidade ficticia aberta", clientId: "cli-a", ownerSellerId: "seller-a", stage: "negociacao" },
  { id: "opp-won", title: "Oportunidade ficticia ganha", clientId: "cli-a", ownerSellerId: "seller-a", stage: "ganho" },
];
const legacyActivity = (id: string, extra: Row): Row => ({
  id, notes: "Nota ficticia", description: null, result: null, noNextStepReason: null, date: null, duration: null, city: null, crop: null,
  areaEstimated: null, product: null, checkInAt: null, checkInLat: null, checkInLng: null, checkInAccuracy: null, clientId: "cli-a",
  opportunityId: null, agendaEventId: null, ownerSellerId: "seller-a", createdAt: daysAgo(20), ...extra,
});
const activities: Row[] = [
  // Antigas: a pendente (vencida) e uma realizada com tipo legado.
  legacyActivity("act-old-pending", { type: "reuniao", done: false, dueDate: daysAgo(5) }),
  legacyActivity("act-old-done", { type: "follow_up", done: true, dueDate: daysAgo(8), date: daysAgo(8), description: "Resumo ficticio antigo" }),
  // Realizada sem compromisso, para o "Concluir" por vínculo.
  legacyActivity("act-free", { type: "ligacao", done: true, dueDate: daysAgo(0), date: daysAgo(0), description: "Ligação ficticia feita" }),
];
const event = (id: string, extra: Row): Row => ({
  id, title: `Compromisso ficticio ${id}`, type: "ligacao", status: "agendado", notes: null, notDoneReason: null, city: null, clientId: "cli-a",
  opportunityId: null, sellerId: "seller-a", startDateTime: daysAgo(1), endDateTime: new Date(NOW - DAY_MS + 30 * 60_000),
  createdAt: daysAgo(10), updatedAt: daysAgo(10), ...extra,
});
const agendaEvents: Row[] = [
  event("evt-call", { opportunityId: "opp-open" }),
  event("evt-link", {}),
  event("evt-not-done", { type: "visita" }),
  event("evt-no-activity", { type: "whatsapp", startDateTime: daysAgo(2), endDateTime: daysAgo(2) }),
  event("evt-reopen", { type: "visita", status: "realizado" }),
  event("evt-route", { type: "roteiro_visita", title: "Roteiro ficticio" }),
  // Pendências: dentro dos 30 dias, no limite, fora da janela, já resolvidos, futuros e de outro vendedor.
  event("evt-pending-5", { startDateTime: daysAgo(5), endDateTime: daysAgo(5) }),
  event("evt-pending-edge", { startDateTime: at("2026-09-23T03:30:00.000Z"), endDateTime: at("2026-09-23T04:00:00.000Z") }),
  event("evt-older-31", { startDateTime: at("2026-09-23T02:30:00.000Z"), endDateTime: at("2026-09-23T02:45:00.000Z") }),
  event("evt-older-40", { startDateTime: daysAgo(40), endDateTime: daysAgo(40) }),
  event("evt-done-past", { status: "realizado", startDateTime: daysAgo(3), endDateTime: daysAgo(3) }),
  event("evt-future", { startDateTime: at("2026-10-26T12:00:00.000Z"), endDateTime: at("2026-10-26T12:30:00.000Z") }),
  event("evt-seller-b", { sellerId: "seller-b", clientId: "cli-b", startDateTime: daysAgo(2), endDateTime: daysAgo(2) }),
  // Legados: follow-up e cancelamento antigo (vencido).
  event("evt-legacy-followup", { type: "followup", status: "realizado", startDateTime: daysAgo(6), endDateTime: daysAgo(6) }),
  event("evt-legacy-cancelled", { type: "reuniao_online", status: "vencido", startDateTime: daysAgo(7), endDateTime: daysAgo(7) }),
];
activities.push(legacyActivity("act-reopen", { type: "visita", done: true, dueDate: daysAgo(1), date: daysAgo(1), description: "Visita ficticia", agendaEventId: "evt-reopen" }));
const agendaStops: Row[] = [
  { id: "stop-1", agendaEventId: "evt-route", order: 1, clientId: "cli-a", city: null, address: null, plannedTime: null, notes: null, checkInAt: null, checkOutAt: null, resultStatus: null },
  { id: "stop-2", agendaEventId: "evt-route", order: 2, clientId: "cli-a", city: null, address: null, plannedTime: null, notes: null, checkInAt: null, checkOutAt: null, resultStatus: null },
];
const timelineEvents: Row[] = [];

const matchValue = (value: unknown, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof RealDate) return (value as Date)?.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;
  if ("in" in condition) return condition.in.includes(value);
  if ("contains" in condition) return String(value ?? "").includes(condition.contains);
  if (value === null || value === undefined) return false;
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
    if (key === "opportunity" || key === "client") return true;
    return matchValue(row[key], condition);
  });
const byId = (rows: Row[], id: string) => rows.find((row) => row.id === id) ?? null;
const enrichEvent = (row: Row | null) => {
  if (!row) return null;
  const linked = activities.filter((activity) => activity.agendaEventId === row.id);
  const opportunity = row.opportunityId ? byId(opportunities, row.opportunityId) : null;
  return {
    ...row,
    stops: agendaStops.filter((stop) => stop.agendaEventId === row.id).map((stop) => ({ ...stop, client: { name: byId(clients, stop.clientId)?.name } })),
    client: row.clientId ? byId(clients, row.clientId) : null,
    activities: linked.map((activity) => ({ id: activity.id })),
    opportunity: opportunity ? { title: opportunity.title, stage: opportunity.stage } : null,
    _count: { activities: linked.length },
  };
};
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (!where?.role || row.role === where.role));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.id, role: user.role, region: null, isActive: true } : null;
  },
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("opportunity", {
  findFirst: async ({ where }: any) => opportunities.find((row) => matches(row, where)) ?? null,
  findUnique: async ({ where }: any) => byId(opportunities, where.id),
});
setModel("activity", {
  findMany: async ({ where }: any) => activities.filter((row) => matches(row, where)).map((row) => ({
    ...row, ownerSeller: { id: row.ownerSellerId, name: row.ownerSellerId }, client: row.clientId ? byId(clients, row.clientId) : null, opportunity: null,
  })),
  findFirst: async ({ where }: any) => activities.find((row) => matches(row, where)) ?? null,
  create: async ({ data }: any) => {
    const row = { id: `act-new-${activities.length + 1}`, createdAt: new Date(), noNextStepReason: null, agendaEventId: null, ...data };
    activities.push(row);
    return row;
  },
  update: async ({ where, data }: any) => Object.assign(byId(activities, where.id)!, data),
  delete: async ({ where }: any) => activities.splice(activities.findIndex((row) => row.id === where.id), 1)[0],
  count: async () => 0,
});
setModel("agendaEvent", {
  findMany: async ({ where }: any) => agendaEvents.filter((row) => matches(row, where)).map(enrichEvent),
  findFirst: async ({ where }: any) => enrichEvent(agendaEvents.find((row) => matches(row, where)) ?? null),
  findUnique: async ({ where }: any) => enrichEvent(byId(agendaEvents, where.id)),
  count: async ({ where }: any) => agendaEvents.filter((row) => matches(row, where)).length,
  create: async ({ data }: any) => {
    const { stops: _stops, ...rest } = data;
    const row = event(`evt-new-${agendaEvents.length + 1}`, { clientId: null, opportunityId: null, createdAt: new Date(), updatedAt: new Date(), ...rest });
    agendaEvents.push(row);
    return enrichEvent(row);
  },
  update: async ({ where, data }: any) => enrichEvent(Object.assign(byId(agendaEvents, where.id)!, data, { updatedAt: new Date() })),
  updateMany: async ({ where, data }: any) => {
    const rows = agendaEvents.filter((row) => matches(row, where));
    rows.forEach((row) => Object.assign(row, data));
    return { count: rows.length };
  },
  delete: async ({ where }: any) => agendaEvents.splice(agendaEvents.findIndex((row) => row.id === where.id), 1)[0],
});
setModel("agendaStop", {
  findUnique: async ({ where }: any) => {
    const stop = byId(agendaStops, where.id);
    return stop ? { ...stop, agendaEvent: byId(agendaEvents, stop.agendaEventId) } : null;
  },
  update: async ({ where, data }: any) => Object.assign(byId(agendaStops, where.id)!, data),
  count: async ({ where }: any) => agendaStops.filter((row) => matches(row, where)).length,
});
setModel("timelineEvent", { create: async ({ data }: any) => { timelineEvents.push(data); return { id: `tl-${timelineEvents.length}`, ...data }; } });
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
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as any };
};
const activityBody = (extra: Row = {}) => ({ type: "ligacao", clientId: "cli-a", date: "2026-10-23T14:00:00.000Z", description: "Resultado ficticio da ligação", ...extra });

const results: string[] = [];
try {
  // Regras puras: o dia é o de Brasília. 22h de 23/10 em Brasília (01h UTC de 24/10) ainda é hoje.
  assert.equal(brazilDayKeyOfInput("2026-10-24T01:00:00.000Z"), "2026-10-23");
  assert.equal(isFutureBrazilDay("2026-10-24T01:00:00.000Z"), false);
  assert.equal(isFutureBrazilDay("2026-10-24T03:00:00.000Z"), true);
  assert.equal(isFutureBrazilDay("2026-10-24"), true);
  assert.equal(pendingAgendaWindowStart().toISOString(), "2026-09-23T03:00:00.000Z", "janela começa às 0h de Brasília de 30 dias atrás");
  results.push("brazil_day=PASS");

  // 1. Atividade com data futura: recusada (instante de amanhã em Brasília, e dia YYYY-MM-DD de amanhã).
  const future = await call("POST", "/activities", "seller-a", activityBody({ date: "2026-10-24T12:00:00.000Z" }));
  assert.equal(future.status, 400);
  assert.equal(future.json.message, "A data da atividade não pode ser futura.");
  assert.equal((await call("POST", "/activities", "seller-a", activityBody({ date: undefined, dueDate: "2026-10-24" }))).status, 400);
  const lateNight = await call("POST", "/activities", "seller-a", activityBody({ date: "2026-10-24T01:00:00.000Z" }));
  assert.equal(lateNight.status, 201, "22h de Brasília ainda é hoje");
  assert.equal(lateNight.json.done, true, "toda atividade criada é realizada");
  results.push("future_date_refused=PASS");

  // 2. Sem resultado (resumo): recusada. Pendente (done=false): recusada.
  const noResult = await call("POST", "/activities", "seller-a", activityBody({ description: undefined }));
  assert.equal(noResult.status, 400);
  assert.equal(noResult.json.message, "Informe o resultado (resumo) do que foi feito.");
  assert.equal((await call("POST", "/activities", "seller-a", activityBody({ description: "  " }))).status, 400);
  const pending = await call("POST", "/activities", "seller-a", activityBody({ done: false }));
  assert.equal(pending.status, 400);
  assert.match(pending.json.message, /compromisso na Agenda/);
  results.push("result_required=PASS no_pending_creation=PASS");

  // 3. Próximo passo cria compromisso com tipo, data/hora, cliente e oportunidade herdados.
  const eventsBefore = agendaEvents.length;
  const withNextStep = await call("POST", "/activities", "seller-a", activityBody({ opportunityId: "opp-open", nextStep: { type: "visita", startsAt: "2026-10-27T13:00:00.000Z" } }));
  assert.equal(withNextStep.status, 201);
  assert.equal(agendaEvents.length, eventsBefore + 1);
  const nextStepEvent = agendaEvents.at(-1)!;
  assert.equal(withNextStep.json.nextStepAgendaEventId, nextStepEvent.id);
  assert.deepEqual(
    [nextStepEvent.type, nextStepEvent.status, nextStepEvent.sellerId, nextStepEvent.clientId, nextStepEvent.opportunityId],
    ["visita", "agendado", "seller-a", "cli-a", "opp-open"]
  );
  assert.equal(nextStepEvent.startDateTime.toISOString(), "2026-10-27T13:00:00.000Z");
  assert.equal(nextStepEvent.endDateTime.toISOString(), "2026-10-27T13:30:00.000Z", "30 minutos por padrão");
  assert.equal(nextStepEvent.title, "Visita: Oportunidade ficticia aberta");
  assert.equal(byId(activities, withNextStep.json.id)!.agendaEventId ?? null, null, "a atividade não fica vinculada ao próprio próximo passo");
  assert(timelineEvents.some((row) => row.description === "Visita agendada: Visita: Oportunidade ficticia aberta"), "próximo passo na timeline");
  const pastNextStep = await call("POST", "/activities", "seller-a", activityBody({ nextStep: { type: "ligacao", startsAt: "2026-10-22T13:00:00.000Z" } }));
  assert.equal(pastNextStep.status, 400);
  assert.equal(pastNextStep.json.message, "O próximo passo não pode ficar em dia passado.");
  assert.equal((await call("POST", "/activities", "seller-a", activityBody({ nextStep: { type: "followup", startsAt: "2026-10-27T13:00:00.000Z" } }))).status, 400, "followup é legado");
  assert.equal((await call("POST", "/activities", "seller-a", activityBody({ nextStep: { type: "roteiro_visita", startsAt: "2026-10-27T13:00:00.000Z" } }))).status, 400, "roteiro não é próximo passo");
  results.push("next_step_creates_agenda=PASS");

  // 4. Oportunidade aberta sem próximo passo: exige o motivo. Oportunidade ganha não exige.
  const openWithout = await call("POST", "/activities", "seller-a", activityBody({ opportunityId: "opp-open" }));
  assert.equal(openWithout.status, 400);
  assert.equal(openWithout.json.message, "Oportunidade aberta: informe o próximo passo ou o motivo de não ter próximo passo.");
  const openWithReason = await call("POST", "/activities", "seller-a", activityBody({ opportunityId: "opp-open", noNextStepReason: "Cliente ficticio pediu para aguardar" }));
  assert.equal(openWithReason.status, 201);
  assert.equal(byId(activities, openWithReason.json.id)!.noNextStepReason, "Cliente ficticio pediu para aguardar");
  assert.equal((await call("POST", "/activities", "seller-a", activityBody({ opportunityId: "opp-won" }))).status, 201);
  results.push("open_opportunity_requires_reason=PASS");

  // 5. Concluir: cria a atividade com cliente/oportunidade do compromisso e marca realizado; ou vincula uma existente.
  const completeWithout = await call("POST", "/agenda/events/evt-call/complete", "seller-a", { description: "Ligação ficticia feita" });
  assert.equal(completeWithout.status, 400, "oportunidade aberta também exige próximo passo ou motivo no Concluir");
  assert.equal((await call("POST", "/agenda/events/evt-call/complete", "seller-a", { noNextStepReason: "Motivo ficticio" })).status, 400, "Concluir exige resultado");
  const completed = await call("POST", "/agenda/events/evt-call/complete", "seller-a", { description: "Ligação ficticia feita", nextStep: { type: "proposta", startsAt: "2026-10-28T13:00:00.000Z" } });
  assert.equal(completed.status, 201);
  assert.equal(completed.json.agendaEvent.status, "completed");
  assert.equal(byId(agendaEvents, "evt-call")!.status, "realizado");
  const createdByComplete = byId(activities, completed.json.activityId)!;
  assert.deepEqual(
    [createdByComplete.type, createdByComplete.done, createdByComplete.agendaEventId, createdByComplete.clientId, createdByComplete.opportunityId, createdByComplete.ownerSellerId],
    ["ligacao", true, "evt-call", "cli-a", "opp-open", "seller-a"]
  );
  assert.equal(completed.json.agendaEvent.linkedActivityId, createdByComplete.id);
  assert.equal(byId(agendaEvents, completed.json.nextStepAgendaEventId)!.type, "proposta");
  assert.equal((await call("POST", "/agenda/events/evt-call/complete", "seller-a", { description: "De novo" })).status, 400, "já concluído");
  const linked = await call("POST", "/agenda/events/evt-link/complete", "seller-a", { activityId: "act-free" });
  assert.equal(linked.status, 201);
  assert.equal(byId(activities, "act-free")!.agendaEventId, "evt-link");
  assert.equal(byId(agendaEvents, "evt-link")!.status, "realizado");
  assert.equal((await call("POST", "/agenda/events/evt-call/complete", "seller-b", { description: "Outro vendedor" })).status, 403);
  assert.equal((await call("POST", "/agenda/events/evt-route/complete", "seller-a", { description: "Roteiro" })).status, 400, "roteiro conclui pelas paradas");
  results.push("complete_links_and_marks_done=PASS");

  // 6. Status direto: realizado sem atividade é bloqueado; "cancelled" (vencido) não é mais gravado.
  const completedWithoutActivity = await call("PATCH", "/agenda/evt-no-activity", "seller-a", { status: "completed" });
  assert.equal(completedWithoutActivity.status, 400);
  assert.equal(byId(agendaEvents, "evt-no-activity")!.status, "agendado");
  assert.equal((await call("PATCH", "/agenda/evt-no-activity", "seller-a", { status: "cancelled" })).status, 400);
  results.push("completed_requires_activity=PASS no_new_vencido=PASS");

  // 7. Não realizado exige motivo.
  const notDoneWithout = await call("POST", "/agenda/events/evt-not-done/not-done", "seller-a", {});
  assert.equal(notDoneWithout.status, 400);
  assert.equal(notDoneWithout.json.message, "Informe o motivo de o compromisso não ter sido realizado.");
  const notDone = await call("POST", "/agenda/events/evt-not-done/not-done", "seller-a", { reason: "Cliente ficticio ausente" });
  assert.equal(notDone.status, 200);
  assert.equal(notDone.json.status, "not_done");
  assert.equal(notDone.json.notDoneReason, "Cliente ficticio ausente");
  assert.deepEqual([byId(agendaEvents, "evt-not-done")!.status, byId(agendaEvents, "evt-not-done")!.notDoneReason], ["nao_realizado", "Cliente ficticio ausente"]);
  assert(timelineEvents.some((row) => row.description.includes("Compromisso não realizado") && row.description.includes("Motivo: Cliente ficticio ausente")));
  assert.equal((await call("POST", "/agenda/events/evt-not-done/not-done", "seller-a", { reason: "De novo" })).status, 400, "só agendado");
  results.push("not_done_requires_reason=PASS");

  // 8. Reabrir: só gerente/diretor; a atividade vinculada fica e o evento vai para a timeline.
  const sellerReopen = await call("PATCH", "/agenda/evt-reopen", "seller-a", { status: "planned" });
  assert.equal(sellerReopen.status, 403);
  assert.equal(byId(agendaEvents, "evt-reopen")!.status, "realizado");
  const managerReopen = await call("PATCH", "/agenda/evt-reopen", "manager-a", { status: "planned" });
  assert.equal(managerReopen.status, 200);
  assert.equal(byId(agendaEvents, "evt-reopen")!.status, "agendado");
  assert.equal(byId(activities, "act-reopen")!.agendaEventId, "evt-reopen", "atividade vinculada não é apagada");
  assert.equal(managerReopen.json.linkedActivityId, "act-reopen");
  assert(timelineEvents.some((row) => row.description.startsWith("Compromisso reaberto: Compromisso ficticio evt-reopen")));
  const reopenNotDone = await call("PATCH", "/agenda/evt-not-done", "director-a", { status: "planned" });
  assert.equal(reopenNotDone.status, 200);
  assert.deepEqual([byId(agendaEvents, "evt-not-done")!.status, byId(agendaEvents, "evt-not-done")!.notDoneReason], ["agendado", null]);
  assert.equal((await call("PATCH", "/agenda/evt-reopen", "seller-a", { status: "completed" })).status, 200, "com atividade vinculada pode voltar a realizado");
  results.push("reopen_manager_only=PASS");

  // 9. Roteiro: cada parada realizada cria a visita; com todas as paradas resolvidas, o roteiro fica realizado.
  const stop1 = await call("PATCH", "/agenda-events/stop-1/result", "seller-a", { status: "realizada", summary: "Visita ficticia feita" });
  assert.equal(stop1.status, 200);
  assert.equal(byId(agendaEvents, "evt-route")!.status, "agendado", "falta uma parada");
  assert(activities.some((row) => row.agendaEventId === "evt-route" && row.type === "visita" && row.done), "parada realizada cria visita");
  const stop2 = await call("PATCH", "/agenda-events/stop-2/result", "seller-a", { status: "nao_realizada", reason: "chuva" });
  assert.equal(stop2.status, 200);
  assert.equal(byId(agendaEvents, "evt-route")!.status, "realizado", "todas as paradas resolvidas");
  results.push("route_done_when_all_stops_resolved=PASS");

  // 10. Pendências: passados não concluídos dos últimos 30 dias (Brasília), no escopo; antigos só como contador.
  const sellerPending = await call("GET", "/agenda/pending", "seller-a");
  assert.equal(sellerPending.status, 200);
  const sellerIds = sellerPending.json.items.map((item: Row) => item.id);
  for (const id of ["evt-pending-5", "evt-pending-edge", "evt-no-activity", "evt-not-done"]) assert(sellerIds.includes(id), `${id} é pendência`);
  for (const id of ["evt-older-31", "evt-older-40", "evt-done-past", "evt-future", "evt-seller-b", "evt-call", "evt-route", "evt-legacy-cancelled"]) assert(!sellerIds.includes(id), `${id} fora`);
  assert.equal("olderCount" in sellerPending.json, false, "vendedor não recebe o contador dos antigos");
  assert.equal(sellerPending.json.windowStart, "2026-09-23T03:00:00.000Z");
  const directorPending = await call("GET", "/agenda/pending", "director-a");
  assert(directorPending.json.items.some((item: Row) => item.id === "evt-seller-b"), "diretor vê todos os vendedores");
  assert.equal(directorPending.json.olderCount, 2, "evt-older-31 e evt-older-40");
  const managerFiltered = await call("GET", "/agenda/pending?sellerId=seller-b", "manager-a");
  assert.deepEqual(managerFiltered.json.items.map((item: Row) => item.id), ["evt-seller-b"]);
  assert.equal(managerFiltered.json.olderCount, 0);
  results.push("pending_last_30_days=PASS");

  // 11. Vendedor não exclui atividade nem compromisso; gerente/diretor excluem.
  const sellerDeleteActivity = await call("DELETE", "/activities/act-old-done", "seller-a");
  assert.equal(sellerDeleteActivity.status, 403);
  assert(byId(activities, "act-old-done"));
  const sellerDeleteEvent = await call("DELETE", "/agenda/evt-future", "seller-a");
  assert.equal(sellerDeleteEvent.status, 403);
  assert(byId(agendaEvents, "evt-future"));
  assert.equal((await call("DELETE", "/agenda/events/evt-future", "manager-a")).status, 204);
  assert.equal(byId(agendaEvents, "evt-future"), null);
  assert.equal((await call("DELETE", "/activities/act-free", "director-a")).status, 204);
  results.push("seller_cannot_delete=PASS");

  // 12. Atividades e compromissos antigos continuam legíveis; a pendente antiga pode ser concluída pelo vendedor.
  const list = await call("GET", "/activities", "director-a");
  assert.equal(list.status, 200);
  const oldPending = list.json.find((item: Row) => item.id === "act-old-pending");
  const oldDone = list.json.find((item: Row) => item.id === "act-old-done");
  assert.deepEqual([oldPending.type, oldPending.done, oldPending.status, oldPending.isOverdue], ["reuniao", false, "vencido", true]);
  assert.deepEqual([oldDone.type, oldDone.status], ["follow_up", "realizado"]);
  const agenda = await call("GET", "/agenda/events?from=2026-10-01&to=2026-10-31", "director-a");
  assert.equal(agenda.status, 200);
  const legacyFollowup = agenda.json.items.find((item: Row) => item.id === "evt-legacy-followup");
  const legacyCancelled = agenda.json.items.find((item: Row) => item.id === "evt-legacy-cancelled");
  assert.deepEqual([legacyFollowup.type, legacyFollowup.status], ["followup", "completed"]);
  assert.equal(legacyCancelled.status, "cancelled", "vencido antigo segue lido como cancelado");
  const createdFollowup = await call("POST", "/agenda/events", "seller-a", { title: "Follow-up ficticio", type: "followup", startsAt: "2026-10-27T13:00:00.000Z", endsAt: "2026-10-27T13:30:00.000Z" });
  assert.equal(createdFollowup.status, 400, "followup não é aceito em compromisso novo");
  for (const type of ["ligacao", "whatsapp", "visita", "reuniao_online", "reuniao_presencial", "proposta", "fechamento"]) {
    const created = await call("POST", "/agenda/events", "seller-a", { title: `Compromisso ficticio ${type}`, type, startsAt: "2026-10-27T13:00:00.000Z", endsAt: "2026-10-27T13:30:00.000Z" });
    assert.equal(created.status, 201, type);
    assert.equal(created.json.type, type);
  }
  const concludeOld = await call("PUT", "/activities/act-old-pending", "seller-a", { done: true, date: new Date().toISOString(), description: "Reunião ficticia concluída" });
  assert.equal(concludeOld.status, 200);
  assert.equal(concludeOld.json.status, "realizado");
  assert.equal((await call("PUT", "/activities/act-old-pending", "seller-a", { done: false })).status, 400, "realizada não volta a pendente");
  assert.equal((await call("PATCH", "/activities/act-old-done/done", "seller-a", { done: false })).status, 400);
  assert.equal((await call("PUT", "/activities/act-old-done", "seller-a", { date: "2026-10-25T12:00:00.000Z" })).status, 400, "realizada não vai para data futura");
  results.push("legacy_readable=PASS");

  console.log(`AGENDA_ACTIVITY_SPLIT=PASS ${results.join(" ")}`);
} finally {
  server.close();
  globalThis.Date = RealDate;
}
