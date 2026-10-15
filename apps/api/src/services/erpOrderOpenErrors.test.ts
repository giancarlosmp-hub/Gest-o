import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { findOpenErpOrderErrorOpportunityIds, hasErpOperationalAlert, type ErpOrderAttemptForOpenError } from "@salesforce-pro/shared";
import { buildErpHealthcheckResponse, countOpenErpOrderErrors, getErpOrderOperationalSummary } from "./erpOrderOperationalSummary.js";

// Dados fictícios: oportunidades e datas inventadas, sem relação com pedidos reais.
type FakeAttempt = { opportunityId: string; status: "pending" | "sent" | "error"; createdAt: Date; orderStatus: string | null; manualResolution: { id: string } | null };
const day = (value: number) => new Date(Date.UTC(2026, 6, value, 12));
const attempt = (opportunityId: string, status: FakeAttempt["status"], createdAt: Date, extra: Partial<FakeAttempt> = {}): FakeAttempt => ({ opportunityId, status, createdAt, orderStatus: null, manualResolution: null, ...extra });
const asRule = (rows: FakeAttempt[]): ErpOrderAttemptForOpenError[] => rows.map((row) => ({ opportunityId: row.opportunityId, status: row.status, createdAt: row.createdAt, hasManualResolution: Boolean(row.manualResolution) }));

// Simula erpOrderSync.findMany/count/findFirst para os filtros usados: status, opportunityId in e orderStatus not null.
const fakeDb = (rows: FakeAttempt[]) => {
  const matches = (where: any = {}) => rows
    .filter((row) => !where.status || row.status === where.status)
    .filter((row) => !where.opportunityId?.in || where.opportunityId.in.includes(row.opportunityId))
    .filter((row) => !where.orderStatus || row.orderStatus !== null);
  return { erpOrderSync: {
    findMany: async ({ where }: any) => matches(where),
    count: async ({ where }: any) => matches(where).length,
    findFirst: async () => rows.length ? { updatedAt: rows[0].createdAt, sentAt: null, statusSyncedAt: null } : null,
  } } as any;
};

const scenarios: Array<{ name: string; rows: FakeAttempt[]; open: number }> = [
  { name: "erro com sent posterior na mesma oportunidade não conta", rows: [attempt("op-a", "error", day(1)), attempt("op-a", "sent", day(2))], open: 0 },
  { name: "erro sem nenhum sent conta", rows: [attempt("op-b", "error", day(1))], open: 1 },
  { name: "erro com resolução manual não conta", rows: [attempt("op-c", "error", day(1), { manualResolution: { id: "res-1" } })], open: 0 },
  { name: "dois erros na mesma oportunidade sem sent contam 1 oportunidade", rows: [attempt("op-d", "error", day(1)), attempt("op-d", "error", day(3))], open: 1 },
  { name: "erro depois de um sent continua em aberto", rows: [attempt("op-e", "sent", day(1)), attempt("op-e", "error", day(2))], open: 1 },
  { name: "sent de outra oportunidade não encerra o erro", rows: [attempt("op-f", "error", day(1)), attempt("op-g", "sent", day(2))], open: 1 },
];
const ruleMatchesScenarios = (rule: typeof findOpenErpOrderErrorOpportunityIds) => scenarios.every((scenario) => rule(asRule(scenario.rows)).length === scenario.open);

for (const scenario of scenarios) test(scenario.name, async () => {
  assert.equal(findOpenErpOrderErrorOpportunityIds(asRule(scenario.rows)).length, scenario.open);
  assert.equal(await countOpenErpOrderErrors(fakeDb(scenario.rows)), scenario.open);
});

test("mutante que conta todo status error falha nos cenários", () => {
  const countEveryError: typeof findOpenErpOrderErrorOpportunityIds = (attempts) => attempts.filter((item) => item.status === "error").map((item) => item.opportunityId);
  assert.equal(ruleMatchesScenarios(findOpenErpOrderErrorOpportunityIds), true);
  assert.equal(ruleMatchesScenarios(countEveryError), false);
});

test("resumo operacional separa erro em aberto do histórico", async () => {
  const rows = [
    attempt("op-a", "error", day(1)), attempt("op-a", "sent", day(2), { orderStatus: "faturado" }),
    attempt("op-b", "error", day(3)), attempt("op-b", "error", day(4)),
    attempt("op-c", "error", day(5), { manualResolution: { id: "res-1" } }),
  ];
  const summary = await getErpOrderOperationalSummary(fakeDb(rows));
  assert.equal(summary.errorOrders, 4);
  assert.equal(summary.openErrorOrders, 1);
  assert.equal(summary.sentOrders, 1);
  assert.equal(summary.syncedOrders, 1);
});

test("Sincronizados conta só pedido válido (sent); tentativa recusada com situação falsa não entra", async () => {
  const rows = [
    attempt("op-h", "error", day(1), { orderStatus: "entregue" }),
    attempt("op-i", "pending", day(2), { orderStatus: "pendente" }),
    attempt("op-j", "sent", day(3), { orderStatus: "entregue" }),
  ];
  const summary = await getErpOrderOperationalSummary(fakeDb(rows));
  assert.equal(summary.syncedOrders, 1);
  // Mutante: contar orderStatus preenchido sem filtrar status daria 3.
  assert.equal(rows.filter((row) => row.orderStatus !== null).length, 3);
});

test("banner apaga sem erro em aberto e sem falha de sincronização", () => {
  assert.equal(hasErpOperationalAlert({ scopeErrors: 0, openErrorOrders: 0 }), false);
  assert.equal(hasErpOperationalAlert({ scopeErrors: 0, openErrorOrders: 1 }), true);
  assert.equal(hasErpOperationalAlert({ scopeErrors: 1, openErrorOrders: 0 }), true);
});

test("healthcheck responde 200 sem erro em aberto e 207 com erro em aberto", async () => {
  const status = { partners: { status: "success" }, products: { status: "success" } };
  const integration = { isConfigured: true };
  const historyOnly = await getErpOrderOperationalSummary(fakeDb([attempt("op-a", "error", day(1)), attempt("op-a", "sent", day(2))]));
  const closed = buildErpHealthcheckResponse(status, integration, historyOnly);
  assert.equal(historyOnly.errorOrders, 1);
  assert.equal(closed.httpStatus, 200);
  assert.equal(closed.body.ok, true);
  const open = buildErpHealthcheckResponse(status, integration, await getErpOrderOperationalSummary(fakeDb([attempt("op-b", "error", day(1))])));
  assert.equal(open.httpStatus, 207);
  assert.equal(open.body.ok, false);
  assert.equal(buildErpHealthcheckResponse({ ...status, products: { status: "error" } }, integration, historyOnly).httpStatus, 207);
});

test("os 4 consumidores usam a mesma regra, sem cópia na web", () => {
  const route = readFileSync(new URL("../routes/crudRoutes.ts", import.meta.url), "utf8");
  const health = readFileSync(new URL("./platformHealthService.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../../web/src/components/settings/ErpIntegrationPanel.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../../../web/src/pages/PlatformHealthPage.tsx", import.meta.url), "utf8");
  assert.match(route, /buildErpHealthcheckResponse\(status, integration, operational\)/);
  assert.doesNotMatch(route, /operational\.errorOrders > 0/);
  assert.match(health, /ordersError: erpOrders\.openErrorOrders/);
  assert.match(health, /ordersSynced: erpOrders\.syncedOrders/);
  assert.match(panel, /hasErpOperationalAlert\(\{ scopeErrors: summary\.errors, openErrorOrders: data\?\.operational\?\.openErrorOrders/);
  assert.match(panel, /label: "Erro", value: data\?\.operational\?\.openErrorOrders/);
  assert.match(panel, /no histórico/);
  assert.match(page, /ordersErrorHistory\}? no histórico/);
  for (const source of [panel, page]) assert.doesNotMatch(source, /hasManualResolution|status === "sent"/);
});
