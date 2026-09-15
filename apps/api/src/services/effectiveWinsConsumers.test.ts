import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { effectiveWonContribution } from "./effectiveWins.js";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => fs.readFileSync(new URL(path, root), "utf8");

test("dashboard, opportunities, reports and CSV consume the shared effective projection", () => {
  const dashboard = read("api/src/routes/dashboardRoutes.ts");
  const crud = read("api/src/routes/crudRoutes.ts");
  const reports = read("web/src/pages/ReportsPage.tsx");
  assert.match(dashboard, /loadEffectiveWonContributions/);
  assert.match(crud, /loadEffectiveWonTotals/);
  assert.match(crud, /withEffectiveWin/);
  assert.match(reports, /effectiveWin\?\.value/);
  assert.match(reports, /Observação ERP/);
});

test("conversion formula is unchanged except for cancelled won participation", () => {
  const won = effectiveWonContribution({ tenantId: "t", value: 100 });
  const cancelled = effectiveWonContribution({ tenantId: "t", value: 100, erpOrderSyncs: [{ id: "o", tenantId: "t", operationalOrderStatus: "CANCELADO", pedidoIdImportacao: "i" }] });
  const lost = 1;
  assert.equal((won.count / (won.count + lost)) * 100, 50);
  assert.equal(cancelled.count + lost > 0 ? (cancelled.count / (cancelled.count + lost)) * 100 : 0, 0);
});

test("preview contains representative synthetic cancelled and finalized orders", () => {
  const seed = read("api/prisma/seedPreview.ts");
  for (const order of ["900169-PREVIEW", "900033-PREVIEW", "900051-PREVIEW", "900071-PREVIEW"]) assert.match(seed, new RegExp(order));
  assert.match(seed, /SITUACAO_PEDIDO: fixture\.status/);
});
