import assert from "node:assert/strict";
import { once } from "node:events";

// Dados fictícios. Disciplina = planejado na Agenda × concluído: cada parada conta 1, "não realizado" é neutro
// até 20% dos elegíveis, antes do corte (26/10/2026) o "sem conclusão" é neutro. Relógio fixo depois do corte.
const FIXED_NOW = Date.parse("2026-11-06T15:00:00.000Z"); // sexta 06/11/2026 12:00 de Brasília
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
// Instante em Brasília (UTC-3).
const br = (dayTime: string) => new Date(`${dayTime}:00.000-03:00`);

// ---------- Regra pura (@salesforce-pro/shared) ----------
{
  const now = br("2026-11-06T12:00");
  const totalsOf = (events: Parameters<typeof shared.classifyDisciplineItems>[0][]) =>
    events.reduce((acc, event) => shared.addDisciplineItems(acc, shared.classifyDisciplineItems(event, now)), shared.emptyDisciplineTotals());

  // Roteiro: cada parada conta 1; parada realizada no dia seguinte não é pontual.
  const route = totalsOf([
    {
      type: "roteiro_visita",
      status: "open",
      startDateTime: br("2026-11-03T08:00"),
      endDateTime: br("2026-11-03T18:00"),
      stops: [
        { resultStatus: "realizada", checkOutAt: br("2026-11-03T10:00") },
        { resultStatus: "realizada", checkOutAt: br("2026-11-04T09:00") },
        { resultStatus: "nao_realizada" },
        { resultStatus: null }
      ]
    }
  ]);
  assert.deepEqual(
    [route.planned, route.completed, route.notDone, route.unresolved, route.punctual, route.punctualMeasured],
    [4, 2, 1, 1, 1, 2]
  );

  // Roteiro realizado com todas as paradas "não realizada" não vira concluído.
  const allNotDone = totalsOf([
    { type: "roteiro_visita", status: "completed", startDateTime: br("2026-11-03T08:00"), endDateTime: br("2026-11-03T18:00"), stops: [{ resultStatus: "nao_realizada" }, { resultStatus: "nao_realizada" }] }
  ]);
  assert.equal(allNotDone.completed, 0);
  assert.equal(allNotDone.notDone, 2);

  // Roteiro sem paradas conta 1 pelo status; vencido (cancelamento antigo) fica fora; futuro é "a fazer".
  const misc = totalsOf([
    { type: "roteiro_visita", status: "completed", startDateTime: br("2026-11-03T08:00"), endDateTime: br("2026-11-03T18:00"), stops: [] },
    { type: "ligacao", status: "cancelled", startDateTime: br("2026-11-03T08:00"), endDateTime: br("2026-11-03T08:30") },
    { type: "visita", status: "open", startDateTime: br("2026-11-06T15:00"), endDateTime: br("2026-11-06T16:00") }
  ]);
  assert.deepEqual([misc.planned, misc.completed, misc.upcoming], [2, 1, 1]);

  // N3: 4 não realizados em 10 elegíveis; 2 (20%) ficam neutros, 2 contam contra: 6 ÷ 8 = 75%.
  const n3 = shared.computeDisciplineRates({ ...shared.emptyDisciplineTotals(), planned: 10, completed: 6, notDone: 4 });
  assert.equal(n3.eligible, 10);
  assert.equal(n3.notDoneNeutral, 2);
  assert.equal(n3.executionRate, 75);

  // Antes do corte: roteiro aberto sem parada resolvida é neutro; roteiro realizado sem paradas resolvidas conta 1.
  const legacy = totalsOf([
    { type: "roteiro_visita", status: "open", startDateTime: br("2026-10-20T08:00"), endDateTime: br("2026-10-20T18:00"), stops: [{}, {}, {}] },
    { type: "roteiro_visita", status: "completed", startDateTime: br("2026-10-21T08:00"), endDateTime: br("2026-10-21T18:00"), stops: [{}, {}, {}, {}] },
    { type: "ligacao", status: "open", startDateTime: br("2026-10-22T09:00"), endDateTime: br("2026-10-22T09:30") }
  ]);
  assert.deepEqual([legacy.planned, legacy.completed, legacy.neutral, legacy.unresolved], [5, 1, 4, 0]);
  assert.equal(shared.computeDisciplineRates(legacy).executionRate, 100);
  // O mesmo compromisso aberto depois do corte é "sem conclusão".
  const afterCutoff = totalsOf([{ type: "ligacao", status: "open", startDateTime: br("2026-10-26T09:00"), endDateTime: br("2026-10-26T09:30") }]);
  assert.equal(afterCutoff.unresolved, 1);
}

// ---------- Motivos de "Não realizado" (@salesforce-pro/shared) ----------
{
  const now = br("2026-11-06T12:00");
  const codes = ["cliente_ausente", "cliente_remarcou", "clima_estrada", "veiculo", "demanda_urgente", "falta_tempo", "outro"];
  assert.deepEqual(shared.AGENDA_NOT_DONE_REASON_CODES, codes, "catálogo fixo, nesta ordem");

  // Cada motivo: validação, gravação e leitura na Agenda e na Rota.
  for (const code of codes) {
    const description = code === "outro" ? "Motivo ficticio" : null;
    assert.equal(shared.notDoneReasonError(code, description), null, `${code} aceito`);
    const stored = shared.formatAgendaNotDoneReason(code as never, description);
    assert.deepEqual(shared.parseAgendaNotDoneReason(stored), { code, description, legacy: false }, `${code} lido na Agenda`);
    assert.deepEqual(shared.parseStopNotDoneReason(code, description), { code, description, legacy: false }, `${code} lido na Rota`);
  }
  assert.equal(shared.formatAgendaNotDoneReason("outro", "  Motivo ficticio  "), "outro: Motivo ficticio");
  assert.equal(shared.formatAgendaNotDoneReason("veiculo", "ignorado"), "veiculo", "só \"outro\" leva descrição");
  assert.equal(shared.describeNotDoneReason(shared.parseAgendaNotDoneReason("veiculo")), "Problema com veículo");
  assert.equal(shared.describeNotDoneReason(shared.parseAgendaNotDoneReason("outro: Motivo ficticio")), "Outro (Motivo ficticio)");

  // Código desconhecido ou ausente é recusado; "outro" exige descrição (mínimo 2 caracteres).
  assert.equal(shared.notDoneReasonError(undefined), shared.NOT_DONE_REASON_REQUIRED_MESSAGE);
  assert.equal(shared.notDoneReasonError("chuva"), shared.NOT_DONE_REASON_REQUIRED_MESSAGE, "código antigo não é aceito em gravação nova");
  assert.equal(shared.notDoneReasonError("Texto livre ficticio"), shared.NOT_DONE_REASON_REQUIRED_MESSAGE);
  assert.equal(shared.notDoneReasonError("outro"), shared.NOT_DONE_DESCRIPTION_REQUIRED_MESSAGE);
  assert.equal(shared.notDoneReasonError("outro", "  x "), shared.NOT_DONE_DESCRIPTION_REQUIRED_MESSAGE);

  // Registros antigos: texto livre da Agenda vira "Outro" com o texto original; códigos antigos da Rota são traduzidos.
  assert.deepEqual(shared.parseAgendaNotDoneReason("Cliente ficticio viajou"), { code: "outro", description: "Cliente ficticio viajou", legacy: true });
  assert.equal(shared.describeNotDoneReason(shared.parseAgendaNotDoneReason("Cliente ficticio viajou")), "Outro (Cliente ficticio viajou)");
  assert.equal(shared.parseAgendaNotDoneReason(null), null);
  assert.equal(shared.parseAgendaNotDoneReason("  "), null);
  const legacyStop = (reason: string, summary: string | null = null) => shared.describeNotDoneReason(shared.parseStopNotDoneReason(reason, summary));
  assert.equal(legacyStop("cliente_ausente"), "Cliente ausente / não atendeu");
  assert.equal(legacyStop("chuva"), "Clima ou condição da estrada");
  assert.equal(legacyStop("estrada"), "Clima ou condição da estrada");
  assert.equal(legacyStop("reagendar"), "Outro (Precisa reagendar)");
  assert.equal(legacyStop("outro"), "Outro", "\"outro\" antigo sem resumo");
  assert.equal(legacyStop("outro", "Resumo ficticio"), "Outro (Resumo ficticio)");
  assert.deepEqual(shared.parseStopNotDoneReason("chuva"), { code: "clima_estrada", description: null, legacy: true });

  // Disciplina: cada "não realizado" é contado pelo motivo, Agenda e Rota no mesmo catálogo. A taxa não muda.
  const events: Parameters<typeof shared.classifyDisciplineItems>[0][] = [
    { type: "visita", status: "not_done", notDoneReason: "veiculo", startDateTime: br("2026-11-03T08:00"), endDateTime: br("2026-11-03T09:00") },
    { type: "ligacao", status: "not_done", notDoneReason: "Texto livre ficticio", startDateTime: br("2026-11-03T10:00"), endDateTime: br("2026-11-03T10:30") },
    {
      type: "roteiro_visita",
      status: "open",
      startDateTime: br("2026-11-04T08:00"),
      endDateTime: br("2026-11-04T18:00"),
      stops: [
        { resultStatus: "nao_realizada", resultReason: "chuva" },
        { resultStatus: "nao_realizada", resultReason: "clima_estrada" },
        { resultStatus: "nao_realizada", resultReason: "reagendar" },
        { resultStatus: "nao_realizada", resultReason: "falta_tempo" },
        { resultStatus: "realizada", checkOutAt: br("2026-11-04T10:00") }
      ]
    },
    // Roteiro não realizado inteiro: as paradas abertas levam o motivo do compromisso.
    { type: "roteiro_visita", status: "not_done", notDoneReason: "cliente_remarcou", startDateTime: br("2026-11-05T08:00"), endDateTime: br("2026-11-05T18:00"), stops: [{}, { resultStatus: "nao_realizada", resultReason: "cliente_ausente" }] }
  ];
  const items = events.flatMap((item) => shared.classifyDisciplineItems(item, now));
  const counts = shared.addNotDoneReasons(shared.emptyNotDoneReasonCounts(), items);
  assert.deepEqual(counts, { cliente_ausente: 1, cliente_remarcou: 1, clima_estrada: 2, veiculo: 1, demanda_urgente: 0, falta_tempo: 1, outro: 2 });
  const totals = shared.addDisciplineItems(shared.emptyDisciplineTotals(), items);
  assert.equal(totals.notDone, 8);
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), totals.notDone, "todo não realizado tem um motivo");
}

// ---------- Rotas ----------
const users: Row[] = [
  { id: "director-x", name: "Diretora Ficticia", role: "diretor", isActive: true },
  { id: "manager-x", name: "Gerente Ficticio", role: "gerente", isActive: true },
  { id: "seller-a", name: "Vendedor Ficticio Alfa", role: "vendedor", isActive: true },
  { id: "seller-b", name: "Vendedora Ficticia Beta", role: "vendedor", isActive: true }
];

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
  // Semana depois do corte (02 a 08/11), vendedor A: 13 planejados, 7 concluídos, 2 não realizados, 2 sem conclusão, 2 a fazer.
  event("seller-a", "roteiro_visita", "agendado", "2026-11-03T08:00", "2026-11-03T18:00", {
    stops: [
      stop("realizada", "2026-11-03T09:00"),
      stop("realizada", "2026-11-03T11:00"),
      stop("realizada", "2026-11-03T15:00"),
      stop("realizada", "2026-11-04T09:00"),
      stop("nao_realizada"),
      stop(null)
    ]
  }),
  event("seller-a", "visita", "realizado", "2026-11-02T09:00", "2026-11-02T10:00", { activities: [{ date: br("2026-11-02T10:00") }] }),
  event("seller-a", "ligacao", "realizado", "2026-11-02T14:00", "2026-11-02T14:30", { activities: [{ date: br("2026-11-02T14:20") }] }),
  event("seller-a", "reuniao_online", "realizado", "2026-11-04T09:00", "2026-11-04T10:00", { activities: [{ date: br("2026-11-05T09:00") }] }),
  event("seller-a", "visita", "nao_realizado", "2026-11-05T09:00", "2026-11-05T10:00", { notDoneReason: "Estrada interditada" }),
  event("seller-a", "followup", "agendado", "2026-11-05T15:00", "2026-11-05T15:30"),
  event("seller-a", "visita", "agendado", "2026-11-06T15:00", "2026-11-06T16:00"),
  event("seller-a", "ligacao", "agendado", "2026-11-06T17:00", "2026-11-06T17:30"),
  event("seller-a", "ligacao", "vencido", "2026-11-04T08:00", "2026-11-04T08:30"),
  // Semana antes do corte (19 a 25/10), vendedor A: só o que teve desfecho conta.
  event("seller-a", "roteiro_visita", "agendado", "2026-10-19T08:00", "2026-10-19T18:00", { stops: [stop(null), stop(null), stop(null), stop(null), stop(null)] }),
  event("seller-a", "roteiro_visita", "agendado", "2026-10-20T08:00", "2026-10-20T18:00", { stops: [stop(null), stop(null), stop(null), stop(null), stop(null)] }),
  event("seller-a", "roteiro_visita", "realizado", "2026-10-21T08:00", "2026-10-21T18:00", { stops: [stop(null), stop(null), stop(null), stop(null)] }),
  ...["2026-10-19", "2026-10-20", "2026-10-22", "2026-10-23"].map((day) =>
    event("seller-a", "visita", "realizado", `${day}T09:00`, `${day}T10:00`, { activities: [{ date: br(`${day}T10:00`) }] })
  ),
  event("seller-a", "visita", "nao_realizado", "2026-10-22T14:00", "2026-10-22T15:00", { notDoneReason: "Chuva" }),
  event("seller-a", "ligacao", "agendado", "2026-10-23T14:00", "2026-10-23T14:30"),
  event("seller-a", "ligacao", "vencido", "2026-10-23T16:00", "2026-10-23T16:30"),
  // Vendedora B, semana depois do corte: 2 concluídos.
  event("seller-b", "visita", "realizado", "2026-11-03T09:00", "2026-11-03T10:00", { activities: [{ date: br("2026-11-03T10:00") }] }),
  event("seller-b", "visita", "realizado", "2026-11-04T09:00", "2026-11-04T10:00", { activities: [{ date: br("2026-11-04T10:00") }] })
];

// Atividades executadas: as vinculadas aos compromissos e 3 visitas de A fora da Agenda.
const activities: Row[] = [
  ...agendaEvents.flatMap((item, index) =>
    item.activities.map((activity: Row) => ({ ownerSellerId: item.sellerId, type: "visita", date: activity.date, agendaEventId: `evt-${index}`, opportunityId: null }))
  ),
  ...["2026-11-03T16:00", "2026-11-04T16:00", "2026-11-05T16:00"].map((when) => ({
    ownerSellerId: "seller-a",
    type: "visita",
    date: br(when),
    agendaEventId: null,
    opportunityId: null
  }))
];

const inRange = (value: Date, range: Row = {}) =>
  (range.gte === undefined || value.getTime() >= range.gte.getTime()) &&
  (range.lte === undefined || value.getTime() <= range.lte.getTime()) &&
  (range.lt === undefined || value.getTime() < range.lt.getTime());

const agendaQueries: Row[] = [];
const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const matchesUser = (user: Row, where: Row = {}) =>
  (where.role === undefined || user.role === where.role) &&
  (where.isActive === undefined || user.isActive === where.isActive) &&
  (where.id === undefined || (typeof where.id === "string" ? user.id === where.id : (where.id.in as string[]).includes(user.id)));
const activityRows = (where: Row = {}) =>
  activities.filter((row) => (!where.ownerSellerId || row.ownerSellerId === where.ownerSellerId) && (!where.date || inRange(row.date, where.date)));

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, email: `${user.id}@test.invalid`, role: user.role, region: null } : null;
  },
  findMany: async ({ where }: any) => users.filter((user) => matchesUser(user, where))
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-x" }] : []) });
setModel("agendaEvent", {
  findMany: async ({ where }: any) => {
    agendaQueries.push(where);
    return agendaEvents.filter(
      (row) =>
        (!where.sellerId || row.sellerId === where.sellerId) &&
        (where.status?.not === undefined || row.status !== where.status.not) &&
        inRange(row.startDateTime, where.startDateTime)
    );
  }
});
setModel("activity", {
  findMany: async ({ where }: any) => activityRows(where),
  groupBy: async ({ where }: any) => {
    const counts = activityRows(where).reduce<Record<string, number>>((acc, row) => {
      acc[row.ownerSellerId] = (acc[row.ownerSellerId] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts).map(([ownerSellerId, count]) => ({ ownerSellerId, _count: { _all: count } }));
  }
});
setModel("opportunity", { findMany: async () => [], groupBy: async () => [] });
setModel("erpOrderSync", { findMany: async () => [] });
setModel("goal", { findMany: async () => [] });
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
const round = (value: number) => Math.round(value * 100) / 100;
const WEEK = "from=2026-11-02&to=2026-11-08";
const LEGACY_WEEK = "from=2026-10-19&to=2026-10-25";

try {
  // Ranking de disciplina, semana depois do corte, visto pelo vendedor A: só a própria linha.
  agendaQueries.length = 0;
  const ranking = await get(`/reports/discipline-ranking?${WEEK}`, "seller-a");
  assert.equal(ranking.status, 200);
  assert.deepEqual(ranking.json.map((row: Row) => row.sellerId), ["seller-a"]);
  assert.equal(agendaQueries[0].sellerId, "seller-a", "a consulta da Agenda já sai filtrada pelo vendedor");
  const own = ranking.json[0];
  assert.deepEqual(
    [own.planned, own.executed, own.notDone, own.unresolved, own.upcoming, own.extra],
    [13, 7, 2, 2, 2, 3]
  );
  // 2 não realizados ≤ 20% de 11 elegíveis: neutros. 7 ÷ 9.
  assert.equal(round(own.executionRate), 77.78);
  // Pontual: 3 de 4 paradas e 2 de 3 compromissos concluídos no mesmo dia planejado.
  assert.equal(round(own.punctualRate), 71.43);
  assert(!JSON.stringify(ranking.json).includes("seller-b"));

  // Gestão vê a equipe.
  for (const viewer of ["manager-x", "director-x"]) {
    const asViewer = await get(`/reports/discipline-ranking?${WEEK}`, viewer);
    assert.deepEqual(asViewer.json.map((row: Row) => row.sellerId).sort(), ["seller-a", "seller-b"], viewer);
    const sellerB = asViewer.json.find((row: Row) => row.sellerId === "seller-b");
    assert.deepEqual([sellerB.planned, sellerB.executed, sellerB.executionRate], [2, 2, 100]);
  }

  // Semana antes do corte: os roteiros abertos e o compromisso sem conclusão ficam neutros.
  const legacy = (await get(`/reports/discipline-ranking?${LEGACY_WEEK}`, "seller-a")).json[0];
  assert.deepEqual([legacy.planned, legacy.executed, legacy.notDone, legacy.unresolved], [17, 5, 1, 0]);
  assert.equal(legacy.executionRate, 100);

  // Planejado × realizado: não realizado e sem conclusão separados; o vendedor vê só o próprio total.
  const report = (await get(`/reports/planned-vs-realized?${WEEK}`, "seller-a")).json;
  assert.deepEqual(
    [report.totalPlanned, report.totalExecuted, report.totalNotDone, report.totalUnresolved, report.totalUpcoming, report.totalExtra],
    [13, 7, 2, 2, 2, 3]
  );
  assert.deepEqual(report.sellers.map((row: Row) => row.sellerId), ["seller-a"]);
  const teamReport = (await get(`/reports/planned-vs-realized?${WEEK}`, "manager-x")).json;
  assert.deepEqual([teamReport.totalPlanned, teamReport.totalExecuted], [15, 9]);
  assert.equal(teamReport.sellers.length, 2);

  // Disciplina semanal (semana atual, 02 a 08/11): planejado real; o mínimo continua nas visitas feitas.
  const weekly = (await get("/reports/weekly-discipline", "seller-a")).json;
  assert.deepEqual(weekly.map((row: Row) => row.sellerId), ["seller-a"]);
  assert.deepEqual([weekly[0].planned, weekly[0].executed, weekly[0].notDone, weekly[0].unresolved], [13, 7, 2, 2]);
  assert.equal(weekly[0].visitsDone, 6);
  assert.equal(weekly[0].belowMinimum, true);
  const weeklyTeam = (await get("/reports/weekly-discipline", "manager-x")).json;
  assert.deepEqual(weeklyTeam.map((row: Row) => row.sellerId).sort(), ["seller-a", "seller-b"]);

  // Score comercial: o componente de disciplina usa a mesma regra; o vendedor recebe só a própria linha.
  const score = (await get("/reports/commercial-score?month=2026-11", "seller-a")).json;
  assert.deepEqual(score.sellers.map((row: Row) => row.sellerId), ["seller-a"]);
  assert(score.sellers[0].disciplineScore > 0);
  const teamScore = (await get("/reports/commercial-score?month=2026-11", "manager-x")).json;
  assert.equal(teamScore.sellers.find((row: Row) => row.sellerId === "seller-a").disciplineScore, score.sellers[0].disciplineScore);
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
  globalThis.Date = RealDate;
}

console.log("AGENDA_DISCIPLINE=PASS rule=PASS history_cutoff=PASS not_done_limit=PASS punctuality=PASS seller_own=PASS team=PASS");
