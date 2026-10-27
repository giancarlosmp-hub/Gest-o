import assert from "node:assert/strict";
import { prisma } from "../config/prisma.js";
import { lastInvoiceAmount, lastInvoiceDayKey, loadClientEstimatedValues, recentLastInvoiceValue } from "./clientEstimatedValue.js";
import { loadLastVisitByClient } from "./clientLastVisit.js";

// Valor estimado do cliente (maior entre ganhos do CRM em 365 dias e a última fatura do ERP desses 365 dias) e última
// visita (check-out de parada ou atividade presencial realizada). Clientes, oportunidades e pedidos fictícios; Prisma
// simulado.
type Row = Record<string, any>;
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);
const results: string[] = [];

const TODAY = "2026-10-27";

// Formatos do perfil do ERP.
assert.equal(lastInvoiceDayKey("2026-01-10T03:00:00.000Z"), "2026-01-10");
assert.equal(lastInvoiceDayKey("2026-01-10T02:00:00.000Z"), "2026-01-09", "dia de Brasília");
assert.equal(lastInvoiceDayKey("2026-01-10"), "2026-01-10");
assert.equal(lastInvoiceDayKey("10/01/2026"), null);
assert.equal(lastInvoiceDayKey(null), null);
assert.equal(lastInvoiceAmount(21400), 21400);
assert.equal(lastInvoiceAmount("21.400,50"), 21400.5);
assert.equal(lastInvoiceAmount("abc"), null);
assert.equal(lastInvoiceAmount(null), null);
results.push("erp_profile_formats=PASS");

// (b) só vale com a última fatura nos 365 dias (de 2025-10-28 a 2026-10-27).
assert.equal(recentLastInvoiceValue({ DATA_ULTFATURA: "2025-10-28", VALOR_ULTFATURA: 9000 }, TODAY), 9000, "primeiro dia da janela");
assert.equal(recentLastInvoiceValue({ DATA_ULTFATURA: "2025-10-27", VALOR_ULTFATURA: 9000 }, TODAY), 0, "fora da janela");
assert.equal(recentLastInvoiceValue({ DATA_ULTFATURA: "2026-10-28", VALOR_ULTFATURA: 9000 }, TODAY), 0, "data futura");
assert.equal(recentLastInvoiceValue({ DATA_ULTFATURA: "2026-05-01" }, TODAY), 0, "sem valor");
assert.equal(recentLastInvoiceValue(null, TODAY), 0);
results.push("last_invoice_window=PASS");

// (a) ganhos efetivos do CRM na janela; pedido cancelado zera o ganho. Valor estimado = maior entre (a) e (b).
{
  let wonWhere: Row | null = null;
  setModel("opportunity", {
    findMany: async ({ where }: any) => {
      wonWhere = where;
      return [
        { id: "opp-1", clientId: "cli-a", value: 12000, client: { tenantId: "tenant-a" } },
        { id: "opp-2", clientId: "cli-a", value: 3000, client: { tenantId: "tenant-a" } },
        { id: "opp-cancelada", clientId: "cli-b", value: 50000, client: { tenantId: "tenant-a" } },
        { id: "opp-3", clientId: "cli-c", value: 4000, client: { tenantId: "tenant-a" } },
      ];
    },
  });
  setModel("erpOrderSync", {
    findMany: async () => [
      { id: "order-1", opportunityId: "opp-cancelada", tenantId: "tenant-a", status: "sent", operationalOrderStatus: "CANCELADO", erpOrderId: "1", erpOrderNumber: null, pedidoIdImportacao: "imp-1", supersedesErpOrderSyncId: null, payloadSent: {} },
    ],
  });
  const values = await loadClientEstimatedValues([
    { id: "cli-a", financialProfile: { DATA_ULTFATURA: "2026-09-01T03:00:00.000Z", VALOR_ULTFATURA: 8000 } },
    { id: "cli-b", financialProfile: null },
    { id: "cli-c", financialProfile: { DATA_ULTFATURA: "2026-09-01T03:00:00.000Z", VALOR_ULTFATURA: "6.500,00" } },
    { id: "cli-d", financialProfile: { DATA_ULTFATURA: "2024-01-01T03:00:00.000Z", VALOR_ULTFATURA: 90000 } },
  ], TODAY);
  assert.equal(values.get("cli-a"), 15000, "ganhos do CRM maiores que a última fatura");
  assert.equal(values.get("cli-b"), 0, "ganho com pedido cancelado não conta");
  assert.equal(values.get("cli-c"), 6500, "última fatura maior que os ganhos");
  assert.equal(values.get("cli-d"), 0, "última fatura antiga não conta");
  assert.equal(wonWhere!.stage, "ganho");
  assert.deepEqual(wonWhere!.clientId, { in: ["cli-a", "cli-b", "cli-c", "cli-d"] });
  assert.deepEqual(wonWhere!.client, { isArchived: false });
  assert.equal(wonWhere!.OR[0].closedAt.gte.toISOString(), "2025-10-28T03:00:00.000Z", "365 dias de Brasília");
  assert.equal(wonWhere!.OR[1].expectedCloseDate.gte.toISOString(), "2025-10-28T00:00:00.000Z");
  assert.deepEqual(await loadClientEstimatedValues([], TODAY), new Map(), "sem clientes não consulta");
  results.push("estimated_value_max_a_b=PASS");
}

// Última visita: o mais recente entre check-out de parada e atividade presencial realizada (data ou, sem ela, vencimento).
{
  const calls: Row[] = [];
  setModel("agendaStop", {
    groupBy: async (args: any) => {
      calls.push({ model: "agendaStop", ...args });
      return [
        { clientId: "cli-a", _max: { checkOutAt: new Date("2026-09-10T15:00:00.000Z") } },
        { clientId: "cli-b", _max: { checkOutAt: new Date("2026-05-10T15:00:00.000Z") } },
      ];
    },
  });
  setModel("activity", {
    groupBy: async (args: any) => {
      calls.push({ model: "activity", ...args });
      return args.where.date === null
        ? [{ clientId: "cli-c", _max: { dueDate: new Date("2026-04-01T15:00:00.000Z") } }]
        : [{ clientId: "cli-a", _max: { date: new Date("2026-08-01T15:00:00.000Z") } }, { clientId: "cli-b", _max: { date: new Date("2026-07-01T15:00:00.000Z") } }];
    },
  });
  const lastVisit = await loadLastVisitByClient(["cli-a", "cli-b", "cli-c", "cli-d"]);
  assert.equal(lastVisit.get("cli-a")?.toISOString(), "2026-09-10T15:00:00.000Z", "check-out mais recente");
  assert.equal(lastVisit.get("cli-b")?.toISOString(), "2026-07-01T15:00:00.000Z", "atividade mais recente");
  assert.equal(lastVisit.get("cli-c")?.toISOString(), "2026-04-01T15:00:00.000Z", "atividade sem data usa o vencimento");
  assert.equal(lastVisit.has("cli-d"), false, "nunca visitado");
  const stopCall = calls.find((call) => call.model === "agendaStop")!;
  assert.deepEqual(stopCall.where, { clientId: { in: ["cli-a", "cli-b", "cli-c", "cli-d"] }, checkOutAt: { not: null } });
  for (const call of calls.filter((item) => item.model === "activity")) {
    assert.equal(call.where.done, true, "só realizada");
    assert.deepEqual(call.where.type, { in: ["visita", "visita_tecnica", "reuniao_presencial"] }, "só presencial");
  }
  assert.deepEqual(await loadLastVisitByClient([]), new Map());
  results.push("last_visit=PASS");
}

console.log(results.join("\n"));
