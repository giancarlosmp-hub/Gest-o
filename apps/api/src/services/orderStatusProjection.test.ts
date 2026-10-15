import assert from "node:assert/strict";
import test from "node:test";
import { serializeOrderAttempt, summarizeOrders } from "./orderStatusProjection.js";

// Dados fictícios: clientes, oportunidades, números e valores inventados.
const opportunity = { id: "opp-1", title: "Oportunidade fictícia", stage: "ganho", value: 500, client: { id: "cli-1", code: "C-TESTE", name: "Cliente Fictício", fantasyName: null } };
const attempt = (id: string, status: "pending" | "sent" | "error", extra: Record<string, unknown> = {}) => ({
  id, status, numPedido: `T-${id}`, erpOrderId: null, erpOrderNumber: null, pedidoIdImportacao: `imp-${id}`, createdAt: new Date("2026-07-29T12:00:00Z"),
  statusSyncedAt: null, operationalOrderStatus: "UNKNOWN", requestAuthorizationStatus: "UNKNOWN", orderStatus: null, operationalStatusRaw: null,
  payloadSent: { VALOR_LIQUIDO: 500, QTD_PEDIDO: 10 }, erpResponse: null, lastStatusPayload: null, syncErrors: null,
  seller: { id: "seller-1", name: "Vendedor Fictício" }, opportunity, ...extra,
});
// Tentativa recusada que recebeu situação FINALIZADO falsa na conferência de status.
const rejectedWithFakeFinal = attempt("err-1", "error", {
  operationalStatusRaw: "FINALIZADO", operationalOrderStatus: "FINALIZADO", orderStatus: "entregue",
  lastStatusPayload: { data: [{ SITUACAO_PEDIDO: "FINALIZADO", QTD_FATURADO: 10, QTD_EXPEDIDO: 10 }] },
  syncErrors: [{ message: "Cliente bloqueado para faturamento no ERP fictício" }],
});
const rejectedCancelled = attempt("err-2", "error", { operationalStatusRaw: "CANCELADO", orderStatus: "cancelado", syncErrors: [{ message: "Recusa fictícia" }] });
const accepted = attempt("ok-1", "sent", { operationalStatusRaw: "FINALIZADO", orderStatus: "entregue", lastStatusPayload: { data: [{ SITUACAO_PEDIDO: "FINALIZADO", QTD_FATURADO: 10 }] } });

test("tentativa recusada com FINALIZADO falso aparece como recusada, sem situação nem quantidades do ERP", () => {
  const item = serializeOrderAttempt(rejectedWithFakeFinal);
  assert.equal(item.statusGroup, "error");
  assert.equal(item.operationalStatus, null);
  assert.equal(item.fulfillmentStatus, null);
  assert.equal(item.operationalOrderStatus, "UNKNOWN");
  assert.equal(item.quantities.billed, null); assert.equal(item.quantities.shipped, null);
  assert.equal(item.rejectionMessage, "Cliente bloqueado para faturamento no ERP fictício");
  assert.ok(serializeOrderAttempt(attempt("err-3", "error", { syncErrors: [{ message: "x".repeat(400) }] })).rejectionMessage!.length <= 160);
});

test("tentativas recusadas não somam em nenhum card; só no card de erro", () => {
  const summary = summarizeOrders([rejectedWithFakeFinal, rejectedCancelled].map(serializeOrderAttempt));
  assert.deepEqual(summary, { count: 0, totalValue: 0, pending: 0, processing: 0, partial: 0, finished: 0, cancelled: 0, error: 2 });
});

test("pedido sent continua igual", () => {
  const item = serializeOrderAttempt(accepted);
  assert.equal(item.statusGroup, "finished"); assert.equal(item.operationalStatus, "FINALIZADO"); assert.equal(item.quantities.billed, 10); assert.equal(item.rejectionMessage, null);
  assert.deepEqual(summarizeOrders([item]), { count: 1, totalValue: 500, pending: 0, processing: 0, partial: 0, finished: 1, cancelled: 0, error: 0 });
});

test("oportunidade com tentativa recusada e depois aceita conta 1 pedido", () => {
  const summary = summarizeOrders([rejectedWithFakeFinal, accepted].map(serializeOrderAttempt));
  assert.equal(summary.count, 1); assert.equal(summary.totalValue, 500); assert.equal(summary.finished, 1); assert.equal(summary.error, 1);
});

test("tentativa pending fica só em Aguardando, fora de Pedidos e Valor total", () => {
  const summary = summarizeOrders([serializeOrderAttempt(attempt("pend-1", "pending"))]);
  assert.equal(summary.count, 0); assert.equal(summary.totalValue, 0); assert.equal(summary.pending, 1);
});

test("mutante que conta toda tentativa falha", () => {
  const items = [rejectedWithFakeFinal, rejectedCancelled, accepted].map(serializeOrderAttempt);
  const countEveryAttempt = (rows: typeof items) => rows.reduce((acc, item) => ({ count: acc.count + 1, totalValue: acc.totalValue + item.totalValue }), { count: 0, totalValue: 0 });
  const real = summarizeOrders(items);
  const mutant = countEveryAttempt(items);
  assert.notEqual(mutant.count, real.count); assert.notEqual(mutant.totalValue, real.totalValue);
  assert.equal(real.count, 1); assert.equal(real.totalValue, 500);
});
