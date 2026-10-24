import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Executar roteiro: status das paradas, check-out e fila offline. Aparelho em outro fuso; dados fictícios.
process.env.TZ = "Asia/Tokyo";

const {
  STOP_OPPORTUNITY_REQUIRED_MESSAGE,
  STOP_REASON_REQUIRED_MESSAGE,
  STOP_SUMMARY_REQUIRED_MESSAGE,
  initialStopResultForm,
  isRouteFinished,
  mapsAppHref,
  openStreetMapRouteHref,
  stopExecutionStatus,
  stopMapDestination,
  stopResultError,
  stopResultPayload
} = await import("../src/lib/routeExecution");
const { NEXT_STEP_REQUIRED_MESSAGE } = await import("../src/lib/agendaActivity");
const {
  ROUTE_STOP_QUEUE_TTL_MS,
  enqueueRouteStopAction,
  flushRouteStopQueue,
  isNetworkError,
  loadRouteStopQueue,
  pendingRouteStopActions
} = await import("../src/lib/routeStopQueue");

// 24/10/2026 às 10:30 em Brasília.
const now = new Date("2026-10-24T13:30:00.000Z");

// Status: pendente, em visita (check-in no servidor ou guardado no aparelho), realizada, não realizada.
assert.equal(stopExecutionStatus({}), "pendente");
assert.equal(stopExecutionStatus({ checkInAt: "2026-10-24T12:00:00.000Z" }), "em_visita");
assert.equal(stopExecutionStatus({}, ["check-in"]), "em_visita", "check-in guardado sem internet já conta");
assert.equal(stopExecutionStatus({ checkInAt: "2026-10-24T12:00:00.000Z", resultStatus: "realizada" }), "realizada");
assert.equal(stopExecutionStatus({ resultStatus: "nao_realizada" }), "nao_realizada");
assert.equal(isRouteFinished([]), false);
assert.equal(isRouteFinished([{ resultStatus: "realizada" }, { resultStatus: null }]), false);
assert.equal(isRouteFinished([{ resultStatus: "realizada" }, { resultStatus: "nao_realizada" }]), true, "Roteiro concluído");

// Mapa: só endereço e cidade vão para o link; sem eles, não há link.
assert.equal(stopMapDestination({ address: "Rua Ficticia, 10", city: "Cidade Ficticia" }), "Rua Ficticia, 10, Cidade Ficticia");
assert.equal(stopMapDestination({ city: " Cidade Ficticia " }), "Cidade Ficticia");
assert.equal(stopMapDestination({ address: " ", city: null }), null);
assert.equal(openStreetMapRouteHref("Cidade Ficticia"), "https://www.openstreetmap.org/directions?to=Cidade%20Ficticia");
assert.equal(mapsAppHref("Cidade Ficticia", "Mozilla/5.0 (Linux; Android 14)"), "geo:0,0?q=Cidade%20Ficticia");
assert.equal(mapsAppHref("Cidade Ficticia", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"), "https://maps.apple.com/?daddr=Cidade%20Ficticia");

// Check-out realizada: resumo obrigatório.
const openOpp = { id: "opp-ficticia-1", stage: "negociacao" };
const otherOpp = { id: "opp-ficticia-2", stage: "proposta" };
const done = initialStopResultForm("realizada");
assert.equal(stopResultError(done, [], now), STOP_SUMMARY_REQUIRED_MESSAGE, "realizada sem resumo é recusada");
assert.equal(stopResultError({ ...done, summary: "   " }, [], now), STOP_SUMMARY_REQUIRED_MESSAGE);
assert.equal(stopResultError({ ...done, summary: "Visita ficticia" }, [], now), null, "sem oportunidade aberta não exige nada");

// Não realizada: exige o motivo.
const notDone = initialStopResultForm("nao_realizada");
assert.equal(stopResultError(notDone, [], now), STOP_REASON_REQUIRED_MESSAGE);
assert.equal(stopResultError({ ...notDone, reason: "chuva" }, [], now), null);
assert.deepEqual(stopResultPayload({ ...notDone, reason: "chuva" }), { status: "nao_realizada", reason: "chuva" });

// Oportunidade aberta: com uma, já vem escolhida; com várias, o vendedor escolhe; depois, a regra das atividades.
assert.equal(initialStopResultForm("realizada", [openOpp]).opportunityId, "opp-ficticia-1");
assert.equal(initialStopResultForm("realizada", [openOpp, otherOpp]).opportunityId, "");
const withSummary = { ...initialStopResultForm("realizada", [openOpp]), summary: "Visita ficticia" };
assert.equal(stopResultError(withSummary, [openOpp], now), NEXT_STEP_REQUIRED_MESSAGE);
assert.equal(stopResultError({ ...withSummary, opportunityId: "" }, [openOpp, otherOpp], now), STOP_OPPORTUNITY_REQUIRED_MESSAGE);
const noNext = { ...withSummary, nextStep: { ...withSummary.nextStep, mode: "none" as const, reason: "Cliente ficticio aguarda a safra" } };
assert.equal(stopResultError(noNext, [openOpp], now), null);
assert.deepEqual(stopResultPayload(noNext), {
  status: "realizada",
  summary: "Visita ficticia",
  opportunityId: "opp-ficticia-1",
  noNextStepReason: "Cliente ficticio aguarda a safra"
});
const scheduled = { ...withSummary, nextStep: { ...withSummary.nextStep, mode: "schedule" as const, type: "ligacao", day: "2026-10-27", time: "09:00" } };
assert.equal(stopResultError(scheduled, [openOpp], now), null);
assert.deepEqual(stopResultPayload(scheduled).nextStepEvent, {
  type: "ligacao",
  startsAt: "2026-10-27T12:00:00.000Z",
  endsAt: "2026-10-27T12:30:00.000Z"
}, "09:00 de Brasília, mesmo com o aparelho em Tóquio");
assert.equal(stopResultError({ ...scheduled, nextStep: { ...scheduled.nextStep, day: "2026-10-23" } }, [openOpp], now), "O próximo passo não pode ficar em dia passado.");

// Fila offline: por usuário, em ordem, sem duplicar, expira em 24 h, e funciona com o armazenamento bloqueado.
const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key)
  };
};
const blockedStorage = {
  getItem: () => { throw new Error("SecurityError ficticio"); },
  setItem: () => { throw new Error("QuotaExceededError ficticio"); },
  removeItem: () => { throw new Error("SecurityError ficticio"); }
};
const storage = memoryStorage();
const options = { storage, now };
const checkIn = { stopId: "stop-ficticia-1", action: "check-in" as const, payload: { timestamp: "2026-10-24T13:05:00.000Z" } };
const checkOut = { stopId: "stop-ficticia-1", action: "check-out" as const, payload: { lat: -10.5, lng: -50.25, timestamp: "2026-10-24T13:25:00.000Z" } };
assert.equal(enqueueRouteStopAction("seller-ficticio", checkIn, options), true);
assert.equal(enqueueRouteStopAction("seller-ficticio", checkOut, options), true);
assert.equal(enqueueRouteStopAction("seller-ficticio", { ...checkIn, payload: { timestamp: "2026-10-24T13:10:00.000Z" } }, options), true);
const queued = loadRouteStopQueue("seller-ficticio", options);
assert.deepEqual(queued.map((item) => item.action), ["check-in", "check-out"], "repetir o check-in não duplica");
assert.equal(queued[0].payload.timestamp, "2026-10-24T13:05:00.000Z", "vale a hora do primeiro toque");
assert.deepEqual(pendingRouteStopActions(queued, "stop-ficticia-1"), ["check-in", "check-out"]);
assert.deepEqual(loadRouteStopQueue("outro-vendedor-ficticio", options), [], "fila é por usuário");
assert.deepEqual(loadRouteStopQueue("seller-ficticio", { storage, now: new Date(now.getTime() + ROUTE_STOP_QUEUE_TTL_MS) }), [], "expira em 24 h");
assert.equal(storage.data.size, 0, "a fila expirada é apagada");
assert.equal(enqueueRouteStopAction("seller-ficticio", checkIn, { storage: blockedStorage, now }), false);
assert.deepEqual(loadRouteStopQueue("seller-ficticio", { storage: blockedStorage, now }), []);
storage.data.set("gest-o:route-stop-queue:seller-ficticio", "{quebrado");
assert.deepEqual(loadRouteStopQueue("seller-ficticio", options), [], "conteúdo inválido é descartado");

// Envio quando a conexão volta: em ordem, com a hora do aparelho; erro de rede para e mantém; recusa do servidor sai.
const networkError = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", request: {} });
const refusedError = Object.assign(new Error("Request failed"), { response: { status: 400 } });
assert.equal(isNetworkError(networkError), true);
assert.equal(isNetworkError(refusedError), false);
enqueueRouteStopAction("seller-ficticio", checkIn, options);
enqueueRouteStopAction("seller-ficticio", checkOut, options);
const offline = await flushRouteStopQueue("seller-ficticio", async () => { throw networkError; }, options);
assert.deepEqual([offline.sent.length, offline.remaining], [0, 2], "sem conexão, tudo fica guardado");
const sentPayloads: unknown[] = [];
const online = await flushRouteStopQueue("seller-ficticio", async (item) => { sentPayloads.push([item.action, item.payload.timestamp]); }, options);
assert.deepEqual(sentPayloads, [["check-in", "2026-10-24T13:05:00.000Z"], ["check-out", "2026-10-24T13:25:00.000Z"]]);
assert.deepEqual([online.sent.length, online.remaining], [2, 0]);
assert.deepEqual(loadRouteStopQueue("seller-ficticio", options), []);
enqueueRouteStopAction("seller-ficticio", { ...checkIn, stopId: "stop-de-outro-roteiro" }, options);
const refused = await flushRouteStopQueue("seller-ficticio", async () => { throw refusedError; }, options);
assert.deepEqual([refused.refused.length, refused.remaining], [1, 0], "o que o servidor recusa (ex.: roteiro de outro) sai da fila");

// Telas: "Iniciar rota" da Agenda e "Iniciar roteiro" da Central do Dia abrem a tela; a tela usa a fila e o GPS opcional.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = source("../src/App.tsx");
const agendaPage = source("../src/pages/AgendaPage.tsx");
const homePage = source("../src/pages/HomePage.tsx");
const page = source("../src/pages/RouteExecutionPage.tsx");
assert.match(app, /path="agenda\/roteiro" element=\{<RouteExecutionPage \/>\}/);
assert.match(app, /path="agenda\/roteiro\/:eventId" element=\{<RouteExecutionPage \/>\}/);
assert.equal((agendaPage.match(/to=\{`\/agenda\/roteiro\/\$\{selectedEvent\.id\}`\}[^>]*>Iniciar rota<\/Link>/g) || []).length, 2, "os dois Iniciar rota abrem a tela");
assert.match(agendaPage, /navigate\(eventId \? `\/agenda\/roteiro\/\$\{eventId\}` : "\/agenda\/roteiro", \{ replace: true \}\)/, "links antigos ?execute=1");
assert.match(homePage, /to="\/agenda\/roteiro"[\s\S]{0,200}Iniciar roteiro/);
assert.match(page, /enqueueRouteStopAction\(userId, \{ stopId: stop\.id, action, payload \}\)/);
assert.match(page, /Aguardando conexão/);
assert.match(page, /Roteiro concluído/);
assert.match(page, /sem localização/);
assert.match(page, /\(\) => resolve\(\{\}\)/, "GPS negado ou sem sinal segue sem localização");
assert.match(page, /window\.setTimeout\(\(\) => resolve\(\{\}\), timeoutMs \+ 2000\)/, "pedido de permissão sem resposta não trava o check-in");
assert.match(page, /window\.addEventListener\("online", goOnline\)/);

console.log("route execution tests passed");
