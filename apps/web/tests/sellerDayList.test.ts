import assert from "node:assert/strict";

// Aparelho em outro fuso: "vencido" e "hoje" continuam em dias de Brasília. Dados fictícios.
process.env.TZ = "Asia/Tokyo";

const { buildSellerDayList, sellerDayItemKey, SELLER_DAY_TAG_LABEL } = await import("../src/lib/sellerDayList");
const { isActivityDoneToday, isActivityOfToday } = await import("../src/lib/centralDayActivities");

const br = (dayTime: string) => new Date(`${dayTime}:00.000-03:00`).toISOString();
const now = new Date(br("2026-11-06T10:00"));

const priorities = [
  { opportunityId: "op-top", clientId: "cl-top", clientName: "Cliente Alfa", title: "Proposta Alfa", priorityReasons: ["Follow-up vencido"] },
  // Follow-up vencido e prioridade alta: tem de aparecer uma vez só, com o motivo do follow-up.
  { opportunityId: "op-dup", clientId: "cl-dup", clientName: "Cliente Beta", title: "Renovação Beta", priorityReasons: ["Prioridade alta"] },
  { opportunityId: "op-cool", clientId: "cl-cool", clientName: "Cliente Gama", title: "Recompra Gama", priorityReasons: ["Esfriando: ativo sem comprar há mais de 9 meses"] },
  { opportunityId: "op-prio", clientId: "cl-prio", clientName: "Cliente Delta", title: "Pedido Delta" }
];

const opportunities = [
  { id: "op-top", title: "Proposta Alfa", stage: "negociacao", followUpDate: br("2026-11-03T09:00"), client: { id: "cl-top", name: "Cliente Alfa" } },
  { id: "op-dup", title: "Renovação Beta", stage: "negociacao", followUpDate: br("2026-11-04T09:00"), client: { id: "cl-dup", name: "Cliente Beta" } },
  // 22h de Brasília de ontem já é hoje em UTC (e em Tóquio): continua vencido.
  { id: "op-late-night", title: "Visita Épsilon", stage: "prospeccao", followUpDate: br("2026-11-05T22:00"), client: { id: "cl-eps", name: "Cliente Épsilon" } },
  { id: "op-today", title: "Retorno Zeta", stage: "prospeccao", followUpDate: br("2026-11-06T17:00"), client: { id: "cl-zeta", name: "Cliente Zeta" } },
  { id: "op-proposal", title: "Proposta Eta", stage: "proposta", lastContactAt: br("2026-10-20T10:00"), followUpDate: br("2026-11-20T10:00"), client: { id: "cl-eta", name: "Cliente Eta" } },
  { id: "op-future", title: "Futuro Teta", stage: "prospeccao", followUpDate: br("2026-11-10T10:00"), client: { id: "cl-teta", name: "Cliente Teta" } },
  // Cliente em cobrança: sem ação de venda na lista.
  { id: "op-collection", title: "Cobrança Iota", stage: "negociacao", followUpDate: br("2026-11-01T10:00"), client: { id: "cl-iota", name: "Cliente Iota" }, clientInCollection: true }
];

const list = buildSellerDayList({ priorities, opportunities, excludeKey: sellerDayItemKey(priorities[0]), now });
const keys = list.map((item) => item.key);

// Sem duplicatas.
assert.equal(new Set(keys).size, keys.length);
assert.equal(keys.filter((key) => key === "opportunity:op-dup").length, 1, "follow-up vencido + prioridade alta: uma vez só");
const duplicated = list.find((item) => item.opportunityId === "op-dup")!;
assert.equal(duplicated.tag, "followup_overdue");
assert.equal(SELLER_DAY_TAG_LABEL[duplicated.tag], "Follow-up vencido");
assert.equal(duplicated.daysLate, 2);
assert.equal(duplicated.clientName, "Cliente Beta");

// O item nº 1 ("Comece por aqui") não se repete, nem pela prioridade nem pela oportunidade crítica.
assert(!keys.includes("opportunity:op-top"));

// Ordem: vencidos (maior atraso primeiro no mesmo motivo, depois da ordem das prioridades), hoje, proposta, esfriando, prioridade.
assert.deepEqual(keys, [
  "opportunity:op-dup",
  "opportunity:op-late-night",
  "opportunity:op-today",
  "opportunity:op-proposal",
  "opportunity:op-cool",
  "opportunity:op-prio"
]);
assert.deepEqual(list.map((item) => SELLER_DAY_TAG_LABEL[item.tag]), [
  "Follow-up vencido",
  "Follow-up vencido",
  "Follow-up hoje",
  "Proposta sem retorno",
  "Esfriando",
  "Prioridade"
]);

// Follow-up futuro e cliente em cobrança ficam fora.
assert(!keys.includes("opportunity:op-future"));
assert(!keys.includes("opportunity:op-collection"));

// Sem oportunidade, a chave é o cliente.
assert.equal(sellerDayItemKey({ clientId: "cl-x" }), "client:cl-x");
assert.equal(sellerDayItemKey({ opportunityId: "op-x", clientId: "cl-x" }), "opportunity:op-x");
assert.equal(sellerDayItemKey({}), null);

// Sem "Comece por aqui" (nenhuma prioridade), a lista traz todos.
assert.equal(buildSellerDayList({ priorities: [], opportunities, now }).length, 5);

// Rotina Comercial do Dia: só conta atividade concluída hoje (Brasília).
const doneToday = { done: true, date: br("2026-11-06T08:00"), createdAt: br("2026-11-06T08:05"), dueDate: br("2026-11-06T08:00") };
const pendingToday = { done: false, createdAt: br("2026-11-06T07:00"), dueDate: br("2026-11-06T15:00") };
const pendingOld = { done: false, createdAt: br("2026-10-20T07:00"), dueDate: br("2026-10-21T15:00") };
// Pendente antiga cadastrada hoje: continua fora da lista do dia.
const pendingOldCreatedToday = { done: false, date: br("2026-11-06T07:00"), createdAt: br("2026-11-06T07:00"), dueDate: br("2026-10-30T15:00") };
const doneYesterdayLate = { done: true, date: br("2026-11-05T22:30"), createdAt: br("2026-11-05T22:30"), dueDate: br("2026-11-05T22:00") };
assert.equal(isActivityDoneToday(doneToday, now), true);
assert.equal(isActivityDoneToday(pendingToday, now), false, "pendente de hoje não conta na Rotina");
assert.equal(isActivityDoneToday(doneYesterdayLate, now), false);

// Lista do celular: concluídas hoje e pendentes que vencem hoje.
const activities = [doneToday, pendingToday, pendingOld, pendingOldCreatedToday, doneYesterdayLate];
assert.deepEqual(activities.map((activity) => isActivityOfToday(activity, now)), [true, true, false, false, false]);

console.log("SELLER_DAY_LIST=PASS no_duplicates=PASS first_item_excluded=PASS overdue_tag=PASS order=PASS routine_done_only=PASS mobile_list_today=PASS");
