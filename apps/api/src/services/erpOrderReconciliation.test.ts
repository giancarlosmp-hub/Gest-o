import assert from "node:assert/strict";
import fs from "node:fs";
import { ErpOrderSyncStatus } from "@prisma/client";
import { buildErpOrderStatusReconciliation, classifyUltraFv3OrderLookup, planErpOrderStatusLookup, sanitizeErpOrderPayload } from "./erpOrderService.js";
import { formatOrderStatusSyncWarning } from "./erpOrderStatusSyncWarning.js";

const expected = { pedidoIdImportacao: "6f5edc8a-55a7-4502-a816-a8b94b8e67c2", numPedido: "3657" };

assert.deepEqual(
  classifyUltraFv3OrderLookup({ PEDIDO_ID_IMPORTACAO: expected.pedidoIdImportacao, NUM_PEDIDO: "3657", STATUS: "ACEITO" }, expected),
  { outcome: "confirmed", matched: true, erpOrderNumber: "3657", orderStatus: "pendente" },
  "pedido criado e resposta recebida/perdida deve ser reconciliado pelo identificador preservado",
);
assert.equal(classifyUltraFv3OrderLookup([{ PEDIDO_ID_IMPORTACAO: expected.pedidoIdImportacao, STATUS: "PROCESSANDO" }], expected).outcome, "processing", "aceite assíncrono deve continuar bloqueado");
assert.equal(classifyUltraFv3OrderLookup({ items: [] }, expected).outcome, "unknown", "não encontrado não prova não criação");
assert.equal(classifyUltraFv3OrderLookup({ PEDIDO_ID_IMPORTACAO: "outra-chave", STATUS: "REJEITADO" }, expected).outcome, "unknown", "resposta de outro pedido não pode liberar reenvio");
assert.equal(classifyUltraFv3OrderLookup({ PEDIDO_ID_IMPORTACAO: expected.pedidoIdImportacao, STATUS: "REJEITADO" }, expected).outcome, "rejected", "rejeição só é autoritativa quando vinculada ao identificador");

const redacted = sanitizeErpOrderPayload({ authorization: "Bearer secret", password: "secret", cliente: "Pessoa", nested: { token: "secret" } }) as Record<string, unknown>;
assert.equal(redacted.authorization, "[REDACTED]");
assert.equal(redacted.password, "[REDACTED]");
assert.equal(redacted.cliente, "[REDACTED]");
assert.deepEqual(redacted.nested, { token: "[REDACTED]" });

// Conferência de status: situação só com registro do ERP casado; recusa definitiva fora da conferência.
type StatusSyncAttempt = Parameters<typeof buildErpOrderStatusReconciliation>[0];
const attempt: StatusSyncAttempt = {
  id: "sync-1",
  opportunityId: "opp-1",
  status: ErpOrderSyncStatus.sent,
  erpResponse: { NUM_PEDIDO: "900500" },
  pedidoIdImportacao: "0d7c4a52-1b7e-4d0a-9f3c-5a1e2b3c4d5e",
  erpOrderId: null,
  erpOrderNumber: "900500",
  numPedido: "900500",
  orderStatus: null,
  operationalStatusRaw: null,
  sentAt: new Date("2026-01-02T10:00:00Z"),
};
const reconcile = (order: StatusSyncAttempt, response: unknown) => {
  const plan = planErpOrderStatusLookup(order);
  assert.equal(plan.skip, false);
  if (plan.skip) throw new Error("plano inesperado");
  return buildErpOrderStatusReconciliation(order, {
    response,
    classification: classifyUltraFv3OrderLookup(response, plan.expected),
    expected: plan.expected,
    queries: plan.queries,
    correlationId: "corr-1",
    reconciledAt: new Date("2026-01-03T10:00:00Z"),
  });
};
const situationKeys = ["status", "orderStatus", "operationalStatusRaw", "operationalOrderStatus", "erpOrderNumber", "erpResponse"];

const unrelatedList = { data: [{ PEDIDO_ID_IMPORTACAO: "outra-chave", NUM_PEDIDO: "777", SITUACAO_PEDIDO: "FINALIZADO" }] };
const unknown = reconcile(attempt, unrelatedList);
assert.equal(unknown.located, false, "lista sem o pedido não localiza");
for (const key of situationKeys) assert.equal(key in unknown.data, false, `unknown não pode gravar ${key}`);
assert.equal(unknown.history, null, "unknown não grava histórico");
assert.equal(unknown.timelineDescription, null, "unknown não cria evento de timeline");
assert.equal((unknown.data.lastStatusPayload as { outcome?: string }).outcome, "unknown", "unknown grava só a conferência");

const forcedUnknown = buildErpOrderStatusReconciliation(attempt, {
  response: { PEDIDO_ID_IMPORTACAO: attempt.pedidoIdImportacao, SITUACAO_PEDIDO: "FINALIZADO" },
  classification: { outcome: "unknown", matched: true, erpOrderNumber: null, orderStatus: null },
  expected: { pedidoIdImportacao: attempt.pedidoIdImportacao, numPedido: null, erpOrderId: null, erpOrderNumber: null },
  queries: [attempt.pedidoIdImportacao],
  correlationId: "corr-2",
  reconciledAt: new Date("2026-01-03T10:00:00Z"),
});
assert.equal("operationalStatusRaw" in forcedUnknown.data, false, "outcome unknown nunca grava situação, mesmo com registro");
assert.equal(forcedUnknown.timelineDescription, null);

const confirmedByKey = reconcile(attempt, { data: [{ PEDIDO_ID_IMPORTACAO: attempt.pedidoIdImportacao, NUM_PEDIDO: "900500", SITUACAO_PEDIDO: "FINALIZADO" }] });
assert.equal(confirmedByKey.located, true);
assert.equal((confirmedByKey.data as Record<string, unknown>).status, ErpOrderSyncStatus.sent);
assert.equal((confirmedByKey.data as Record<string, unknown>).orderStatus, "entregue");
assert.equal((confirmedByKey.data as Record<string, unknown>).operationalStatusRaw, "FINALIZADO");
assert.equal((confirmedByKey.data as Record<string, unknown>).operationalOrderStatus, "FINALIZADO");
assert.equal(confirmedByKey.history?.operationalStatusRaw, "FINALIZADO");
assert.equal(confirmedByKey.timelineDescription, "Pedido ERP 900500: situação atualizada para FINALIZADO.");

const otherOrderFirst = reconcile(attempt, { data: [
  { PEDIDO_ID_IMPORTACAO: "outra-chave", NUM_PEDIDO: "777", SITUACAO_PEDIDO: "FINALIZADO" },
  { PEDIDO_ID_IMPORTACAO: attempt.pedidoIdImportacao, NUM_PEDIDO: "900500", SITUACAO_PEDIDO: "ACEITO" },
] });
assert.equal((otherOrderFirst.data as Record<string, unknown>).operationalStatusRaw, "ACEITO", "situação vem do registro casado, não do primeiro da lista");
assert.equal(otherOrderFirst.timelineDescription, "Pedido ERP 900500: situação atualizada para ACEITO.");

const unchanged = reconcile(
  { ...attempt, orderStatus: "entregue", operationalStatusRaw: "FINALIZADO" },
  { PEDIDO_ID_IMPORTACAO: attempt.pedidoIdImportacao, NUM_PEDIDO: "900500", SITUACAO_PEDIDO: "FINALIZADO" },
);
assert.equal(unchanged.history, null, "sem mudança não grava histórico");
assert.equal(unchanged.timelineDescription, null, "sem mudança não repete evento de timeline");

const postRejected: StatusSyncAttempt = {
  ...attempt,
  status: ErpOrderSyncStatus.error,
  erpOrderNumber: null,
  erpResponse: { status: 400, endpoint: "/orders", message: "UltraFV3 rejeitou POST /orders (status 400): violation of FOREIGN KEY constraint" },
};
assert.deepEqual(planErpOrderStatusLookup(postRejected), { skip: true, reason: "definitive_rejection" }, "recusa definitiva no POST não é consultada");
assert.equal(planErpOrderStatusLookup({ ...postRejected, erpResponse: { status: 200, endpoint: "/orders", message: "UltraFV3 retornou erro funcional no POST /orders: campo inválido" } }).skip, true, "erro funcional também é definitivo");

const postTimeout: StatusSyncAttempt = { ...postRejected, erpResponse: { status: 504, endpoint: "/orders", message: "UltraFV3 rejeitou POST /orders (status 504): timeout" } };
const timeoutPlan = planErpOrderStatusLookup(postTimeout);
assert.deepEqual(timeoutPlan, {
  skip: false,
  queries: [attempt.pedidoIdImportacao],
  expected: { pedidoIdImportacao: attempt.pedidoIdImportacao, numPedido: null, erpOrderId: null, erpOrderNumber: null },
}, "erro incerto é consultado só pela chave de importação");
const sameNumberOtherOrder = reconcile(postTimeout, { NUM_PEDIDO: "900500", PARCEIRO: 1, SITUACAO_PEDIDO: "FINALIZADO" });
assert.equal(sameNumberOtherOrder.located, false, "erro incerto não casa pelo número");
assert.equal("operationalStatusRaw" in sameNumberOtherOrder.data, false);

const rejected = reconcile(postTimeout, { PEDIDO_ID_IMPORTACAO: attempt.pedidoIdImportacao, STATUS: "REJEITADO" });
assert.equal(rejected.located, true);
assert.equal("erpResponse" in rejected.data, false, "rejected não sobrescreve o erpResponse original");
assert.equal((rejected.data.lastStatusPayload as { outcome?: string }).outcome, "rejected");
assert.match(JSON.stringify(rejected.data.syncErrors), /confirmou a recusa/, "recusa confirmada continua visível ao bloqueio de reenvio");
assert.doesNotMatch(JSON.stringify(rejected.data.syncErrors), /timeout|"status":504/i, "recusa confirmada não pode parecer resultado incerto");

assert.equal(formatOrderStatusSyncWarning({ orderStatusNotFound: 0, orderStatusCallFailures: 0 }), null);
assert.equal(formatOrderStatusSyncWarning(undefined), null);
const notFoundOnly = formatOrderStatusSyncWarning({ orderStatusNotFound: 3, orderStatusCallFailures: 0, nonCriticalOrderStatusErrors: 3 }) ?? "";
assert.match(notFoundOnly, /3 pedido\(s\) não localizado\(s\) no ERP/);
assert.doesNotMatch(notFoundOnly, /falha|falharam/);
const both = formatOrderStatusSyncWarning({ orderStatusNotFound: 2, orderStatusCallFailures: 1 }) ?? "";
assert.match(both, /2 pedido\(s\) não localizado\(s\) no ERP; 1 consulta\(s\) com falha na chamada ao ERP/);

const service = fs.readFileSync(new URL("./erpOrderService.ts", import.meta.url), "utf8");
const syncSource = service.slice(service.indexOf("export async function syncErpOrderStatuses"));
assert.match(syncSource, /if \(reconciliation\.located\) syncedCount \+= 1;\s*else notFoundCount \+= 1;/, "não localizado conta separado");
assert.match(syncSource, /catch \(error\) \{\s*callFailedCount \+= 1;/, "falha de chamada conta separado");
assert.match(syncSource, /orderStatusNotFound: notFoundCount,\s*orderStatusCallFailures: callFailedCount/);
for (const file of ["../jobs/erpSyncScheduler.ts", "./ultraFv3SyncService.ts"]) {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  assert.doesNotMatch(source, /consulta\(s\) de status de pedidos falharam/, `${file} deve usar o aviso separado`);
  assert.match(source, /formatOrderStatusSyncWarning/);
}

console.log("ERP order reconciliation tests passed");
