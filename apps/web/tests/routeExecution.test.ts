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
  stopNotDoneReasonText,
  stopResultError,
  stopResultPayload
} = await import("../src/lib/routeExecution");
const { NEXT_STEP_REQUIRED_MESSAGE } = await import("../src/lib/agendaActivity");
const {
  ROUTE_STOP_EXPIRED_MESSAGE,
  ROUTE_STOP_QUEUE_TTL_MS,
  enqueueRouteStopAction,
  flushRouteStopQueue,
  isNetworkError,
  loadRouteStopQueue,
  loadUnsentRouteStopActions,
  pendingRouteStopActions,
  queuedRouteStopResult,
  removeUnsentRouteStopAction,
  retryUnsentRouteStopAction
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
assert.equal(stopResultError({ ...notDone, reason: "chuva" }, [], now), "Escolha o motivo de não ter sido realizado.", "código antigo não é gravado");
for (const code of ["cliente_ausente", "cliente_remarcou", "clima_estrada", "veiculo", "demanda_urgente", "falta_tempo"]) {
  assert.equal(stopResultError({ ...notDone, reason: code }, [], now), null, code);
  assert.deepEqual(stopResultPayload({ ...notDone, reason: code }), { status: "nao_realizada", reason: code });
}
// "Outro" exige descrição, que vai no resumo da parada.
assert.equal(stopResultError({ ...notDone, reason: "outro" }, [], now), 'Descreva o motivo em "Outro".');
assert.equal(stopResultError({ ...notDone, reason: "outro", summary: "Porteira ficticia fechada" }, [], now), null);
assert.deepEqual(stopResultPayload({ ...notDone, reason: "outro", summary: " Porteira ficticia fechada " }), { status: "nao_realizada", reason: "outro", summary: "Porteira ficticia fechada" });

// Motivo exibido: catálogo, detalhe opcional e registros antigos traduzidos só na leitura.
assert.equal(stopNotDoneReasonText({ resultReason: "veiculo" }), "Problema com veículo");
assert.equal(stopNotDoneReasonText({ resultReason: "veiculo", resultSummary: "Pneu ficticio" }), "Problema com veículo · Pneu ficticio");
assert.equal(stopNotDoneReasonText({ resultReason: "outro", resultSummary: "Porteira ficticia fechada" }), "Outro (Porteira ficticia fechada)");
assert.equal(stopNotDoneReasonText({ resultReason: "cliente_ausente" }), "Cliente ausente / não atendeu");
assert.equal(stopNotDoneReasonText({ resultReason: "chuva" }), "Clima ou condição da estrada");
assert.equal(stopNotDoneReasonText({ resultReason: "estrada", resultSummary: "Ponte ficticia" }), "Clima ou condição da estrada · Ponte ficticia");
assert.equal(stopNotDoneReasonText({ resultReason: "reagendar" }), "Outro (Precisa reagendar)");
assert.equal(stopNotDoneReasonText({ resultReason: "outro" }), "Outro", "\"outro\" antigo sem detalhe");
assert.equal(stopNotDoneReasonText({ resultReason: null }), "não informado");

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

// Fila offline: por usuário, em ordem, sem duplicar, vale 72 h (depois vai para "Não enviados") e funciona com o
// armazenamento bloqueado.
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
const seller = "seller-ficticio";
const checkIn = { stopId: "stop-ficticia-1", action: "check-in" as const, payload: { timestamp: "2026-10-24T13:05:00.000Z" }, stopLabel: "Parada 1 · Cliente Ficticio" };
const checkOut = { stopId: "stop-ficticia-1", action: "check-out" as const, payload: { lat: -10.5, lng: -50.25, timestamp: "2026-10-24T13:25:00.000Z" } };
const doneForm = { ...initialStopResultForm("realizada"), summary: "Visita ficticia" };
const doneResult = { stopId: "stop-ficticia-1", action: "result" as const, payload: stopResultPayload(doneForm), form: doneForm, stopLabel: "Parada 1 · Cliente Ficticio" };
const notDoneForm = { ...initialStopResultForm("nao_realizada"), reason: "veiculo" };
const notDoneResult = { stopId: "stop-ficticia-2", action: "result" as const, payload: stopResultPayload(notDoneForm), form: notDoneForm };
assert.equal(enqueueRouteStopAction(seller, checkIn, options), true);
assert.equal(enqueueRouteStopAction(seller, checkOut, options), true);
assert.equal(enqueueRouteStopAction(seller, doneResult, options), true);
assert.equal(enqueueRouteStopAction(seller, { ...checkIn, payload: { timestamp: "2026-10-24T13:10:00.000Z" } }, options), true);
assert.equal(enqueueRouteStopAction(seller, { ...doneResult, payload: { status: "nao_realizada", reason: "veiculo" } }, options), true);
const queued = loadRouteStopQueue(seller, options);
assert.deepEqual(queued.map((item) => item.action), ["check-in", "check-out", "result"], "repetir check-in ou resultado não duplica");
assert.equal(queued[0].payload.timestamp, "2026-10-24T13:05:00.000Z", "vale a hora do primeiro toque");
assert.deepEqual(queued[2].payload, { status: "realizada", summary: "Visita ficticia" }, "vale o primeiro resultado");
assert.deepEqual(pendingRouteStopActions(queued, "stop-ficticia-1"), ["check-in", "check-out", "result"]);
assert.deepEqual(queuedRouteStopResult(queued, "stop-ficticia-1"), { status: "realizada", summary: "Visita ficticia" });
assert.equal(queuedRouteStopResult(queued, "stop-ficticia-2"), null);
assert.deepEqual(loadRouteStopQueue("outro-vendedor-ficticio", options), [], "fila é por usuário");
assert.equal(loadRouteStopQueue(seller, { storage, now: new Date(now.getTime() + ROUTE_STOP_QUEUE_TTL_MS - 60_000) }).length, 3, "ainda vale perto de 72 h");

// Depois de 72 h: nada some em silêncio; tudo vai para "Não enviados" com aviso e os dados preservados.
const later = new Date(now.getTime() + ROUTE_STOP_QUEUE_TTL_MS);
assert.deepEqual(loadRouteStopQueue(seller, { storage, now: later }), [], "a fila expirada sai da fila");
const expired = loadUnsentRouteStopActions(seller, { storage, now: later });
assert.deepEqual(expired.map((item) => [item.action, item.unsentReason, item.message]), [
  ["check-in", "expired", ROUTE_STOP_EXPIRED_MESSAGE],
  ["check-out", "expired", ROUTE_STOP_EXPIRED_MESSAGE],
  ["result", "expired", ROUTE_STOP_EXPIRED_MESSAGE]
]);
const expiredResult = expired[2];
assert(expiredResult.action === "result");
assert.deepEqual([expiredResult.payload, expiredResult.form?.summary, expiredResult.stopLabel], [{ status: "realizada", summary: "Visita ficticia" }, "Visita ficticia", "Parada 1 · Cliente Ficticio"]);
for (const item of expired) removeUnsentRouteStopAction(seller, item, options);
assert.deepEqual(loadUnsentRouteStopActions(seller, options), [], "descartar remove de \"Não enviados\"");
assert.equal(storage.data.size, 0);
assert.equal(enqueueRouteStopAction(seller, checkIn, { storage: blockedStorage, now }), false);
assert.deepEqual(loadRouteStopQueue(seller, { storage: blockedStorage, now }), []);
assert.deepEqual(loadUnsentRouteStopActions(seller, { storage: blockedStorage, now }), []);
storage.data.set("gest-o:route-stop-queue:seller-ficticio", "{quebrado");
assert.deepEqual(loadRouteStopQueue(seller, options), [], "conteúdo inválido é descartado");

// Envio quando a conexão volta: em ordem (check-in, check-out, resultado), com a hora do aparelho; erro de rede
// para e mantém o resto na mesma ordem; nada é enviado duas vezes.
const networkError = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", request: {} });
const refusedError = (message: string) => Object.assign(new Error("Request failed"), { response: { status: 400, data: { message } } });
assert.equal(isNetworkError(networkError), true);
assert.equal(isNetworkError(refusedError("Recusa ficticia")), false);
enqueueRouteStopAction(seller, checkIn, options);
enqueueRouteStopAction(seller, checkOut, options);
enqueueRouteStopAction(seller, doneResult, options);
enqueueRouteStopAction(seller, notDoneResult, options);
const offline = await flushRouteStopQueue(seller, async () => { throw networkError; }, options);
assert.deepEqual([offline.sent.length, offline.remaining], [0, 4], "sem conexão, tudo fica guardado");
const sentLog: string[] = [];
const flaky = await flushRouteStopQueue(seller, async (item) => {
  if (item.action === "check-out") throw networkError;
  sentLog.push(`${item.stopId}:${item.action}`);
}, options);
assert.deepEqual([flaky.sent.length, flaky.remaining], [1, 3], "a conexão caiu no check-out: o resto espera");
assert.deepEqual(loadRouteStopQueue(seller, options).map((item) => `${item.stopId}:${item.action}`), ["stop-ficticia-1:check-out", "stop-ficticia-1:result", "stop-ficticia-2:result"]);
const online = await flushRouteStopQueue(seller, async (item) => {
  sentLog.push(`${item.stopId}:${item.action}`);
  // A API já tinha o resultado da parada 2 (primeiro resultado vale).
  return { data: item.stopId === "stop-ficticia-2" ? { applied: false } : { applied: true } };
}, options);
assert.deepEqual(sentLog, ["stop-ficticia-1:check-in", "stop-ficticia-1:check-out", "stop-ficticia-1:result", "stop-ficticia-2:result"], "cada registro enviado uma vez, na ordem");
assert.deepEqual([online.sent.length, online.notApplied.map((item) => item.stopId), online.remaining], [3, ["stop-ficticia-2"], 0]);
assert.deepEqual(loadRouteStopQueue(seller, options), []);
const again = await flushRouteStopQueue(seller, async () => { sentLog.push("duplicado"); }, options);
assert.deepEqual([again.sent.length, sentLog.includes("duplicado")], [0, false], "fila vazia não reenvia");

// Recusa do servidor: sai da fila e vai para "Não enviados" com a mensagem e os dados; os seguintes continuam.
enqueueRouteStopAction(seller, doneResult, options);
enqueueRouteStopAction(seller, notDoneResult, options);
const refused = await flushRouteStopQueue(seller, async (item) => {
  if (item.stopId === "stop-ficticia-1") throw refusedError("Oportunidade aberta: informe o próximo passo.");
}, options);
assert.deepEqual([refused.refused.length, refused.sent.length, refused.remaining], [1, 1, 0]);
assert.deepEqual(loadRouteStopQueue(seller, options), []);
const unsent = loadUnsentRouteStopActions(seller, options);
assert.equal(unsent.length, 1);
const unsentResult = unsent[0];
assert(unsentResult.action === "result");
assert.deepEqual(
  [unsentResult.stopId, unsentResult.unsentReason, unsentResult.message, unsentResult.payload, unsentResult.form?.summary],
  ["stop-ficticia-1", "refused", "Oportunidade aberta: informe o próximo passo.", { status: "realizada", summary: "Visita ficticia" }, "Visita ficticia"],
  "o resumo e os dados ficam preservados para corrigir"
);
// Reenviar: sem rede fica; recusado de novo atualiza a mensagem; enviado sai da lista.
assert.equal((await retryUnsentRouteStopAction(seller, unsentResult, async () => { throw networkError; }, options)).status, "network");
assert.equal(loadUnsentRouteStopActions(seller, options).length, 1);
const refusedAgain = await retryUnsentRouteStopAction(seller, unsentResult, async () => { throw refusedError("Recusa ficticia de novo"); }, options);
assert.deepEqual([refusedAgain.status, refusedAgain.message], ["refused", "Recusa ficticia de novo"]);
assert.deepEqual(loadUnsentRouteStopActions(seller, options).map((item) => item.message), ["Recusa ficticia de novo"], "não duplica em \"Não enviados\"");
const resent = await retryUnsentRouteStopAction(seller, unsentResult, async () => ({ data: { applied: true } }), options);
assert.equal(resent.status, "sent");
assert.deepEqual(loadUnsentRouteStopActions(seller, options), []);
enqueueRouteStopAction(seller, { ...checkIn, stopId: "stop-de-outro-roteiro" }, options);
await flushRouteStopQueue(seller, async () => { throw refusedError("Acesso negado."); }, options);
const otherRoute = loadUnsentRouteStopActions(seller, options);
assert.deepEqual(otherRoute.map((item) => [item.stopId, item.action, item.message]), [["stop-de-outro-roteiro", "check-in", "Acesso negado."]]);
assert.equal((await retryUnsentRouteStopAction(seller, otherRoute[0], async () => ({ data: { applied: false } }), options)).status, "not_applied");

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
assert.match(page, /enqueueRouteStopAction\(userId, \{ stopId: stop\.id, action, payload, stopLabel: stopLabelOf\(stop\) \}\)/);
assert.match(page, /enqueueRouteStopAction\(userId, \{ stopId: resultStop\.id, action: "result", payload, form: resultForm/, "o resultado entra na fila");
assert.match(page, /Não enviados \(\{unsent\.length\}\)/);
assert.match(page, /"Reenviar"/);
assert.match(page, />Corrigir</);
assert.match(page, />Descartar</);
assert.match(page, /Aguardando conexão/);
assert.match(page, /Roteiro concluído/);
assert.match(page, /sem localização/);
assert.match(page, /\(\) => resolve\(\{\}\)/, "GPS negado ou sem sinal segue sem localização");
assert.match(page, /window\.setTimeout\(\(\) => resolve\(\{\}\), timeoutMs \+ 2000\)/, "pedido de permissão sem resposta não trava o check-in");
assert.match(page, /window\.addEventListener\("online", goOnline\)/);

console.log("route execution tests passed");
