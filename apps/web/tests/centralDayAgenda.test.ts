import assert from "node:assert/strict";

// Aparelho em outro fuso: o "hoje" da Central do Dia continua sendo o dia de Brasília. Dados fictícios.
process.env.TZ = "Asia/Tokyo";

const { agendaEventsOfToday, previousDaysPendingCount, routeStopsProgress, summarizeAgendaToday } = await import("../src/lib/centralDayAgenda");

const br = (dayTime: string) => new Date(`${dayTime}:00.000-03:00`).toISOString();
const now = new Date(br("2026-11-06T12:00"));

const events = [
  { id: "r1", title: "Roteiro ficticio", type: "roteiro_visita", status: "planned", startsAt: br("2026-11-06T07:00"), endsAt: br("2026-11-06T18:00"),
    stops: [{ resultStatus: "realizada", checkOutAt: br("2026-11-06T09:00") }, { resultStatus: "nao_realizada" }, { resultStatus: null }] },
  { id: "c1", title: "Ligacao concluida", type: "ligacao", status: "completed", startsAt: br("2026-11-06T08:00"), endsAt: br("2026-11-06T08:30") },
  { id: "n1", title: "Visita nao realizada", type: "visita", status: "not_done", startsAt: br("2026-11-06T10:00"), endsAt: br("2026-11-06T11:00") },
  { id: "o1", title: "Visita da tarde", type: "visita", status: "planned", startsAt: br("2026-11-06T15:00"), endsAt: br("2026-11-06T16:00") },
  { id: "x1", title: "Cancelamento antigo", type: "ligacao", status: "cancelled", startsAt: br("2026-11-06T09:00"), endsAt: br("2026-11-06T09:30") },
  // 21h de Brasília de ontem já é hoje em UTC: não pode entrar em hoje.
  { id: "y1", title: "Ontem a noite", type: "ligacao", status: "planned", startsAt: br("2026-11-05T21:30"), endsAt: br("2026-11-05T22:00") }
];

// Planejado de hoje: todos os status, menos o cancelamento antigo, em ordem de horário.
const today = agendaEventsOfToday(events, now);
assert.deepEqual(today.map((item) => item.id), ["r1", "c1", "n1", "o1"]);

// Cada parada conta 1: 3 paradas + 3 compromissos.
assert.deepEqual(summarizeAgendaToday(today, now), { planned: 6, completed: 2, notDone: 2, open: 2 });

assert.equal(routeStopsProgress(events[0]), "2/3 paradas");
assert.equal(routeStopsProgress(events[1]), null);

// Pendências de dias anteriores: só o que começou antes de hoje (Brasília).
const pending = [
  { id: "p1", title: "Ontem", type: "visita", status: "planned", startsAt: br("2026-11-05T21:30") },
  { id: "p2", title: "Semana passada", type: "visita", status: "planned", startsAt: br("2026-10-30T09:00") },
  { id: "p3", title: "Hoje cedo", type: "visita", status: "planned", startsAt: br("2026-11-06T07:00") }
];
assert.equal(previousDaysPendingCount(pending, now), 2);

console.log("CENTRAL_DAY_AGENDA=PASS today_all_status=PASS stops_count=PASS previous_days_pending=PASS");
