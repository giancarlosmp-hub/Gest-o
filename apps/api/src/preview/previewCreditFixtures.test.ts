import assert from "node:assert/strict";
import test from "node:test";
import { buildClientCreditAlert, projectClientForResponse } from "../services/clientErpProjection.js";
import { PREVIEW_CREDIT_OUT_OF_ALLOWLIST_KEY, buildPreviewCreditClientFixtures } from "./previewCreditFixtures.js";

const fixtures = buildPreviewCreditClientFixtures(new Date());

test("preview credit fixtures hit each creditAlert level", () => {
  assert.deepEqual(fixtures.map((fixture) => fixture.level).sort(), ["atencao", "ok", "risco"]);
  for (const fixture of fixtures) {
    assert.equal(buildClientCreditAlert(fixture).level, fixture.level, fixture.code);
  }
  const risk = buildClientCreditAlert(fixtures.find((fixture) => fixture.level === "risco")!);
  assert.equal(risk.reasons[0].replace(/\s/g, " "), "Cliente com títulos vencidos: R$ 4.350,00");
});

test("preview credit fixtures keep totals coherent with titles", () => {
  const now = Date.now();
  for (const fixture of fixtures) {
    const open = fixture.partnerTitles.reduce((sum, title) => sum + Number(title.SALDO_CAPITAL), 0);
    const overdue = fixture.partnerTitles.filter((title) => new Date(String(title.DATA_VENCIMENTO)).getTime() < now).reduce((sum, title) => sum + Number(title.SALDO_CAPITAL), 0);
    assert.equal(open, fixture.openTitlesTotal, fixture.code);
    assert.equal(overdue, fixture.overdueTitlesTotal, fixture.code);
  }
  assert.ok(fixtures.some((fixture) => fixture.sellerEmail.startsWith("ana.")) && fixtures.some((fixture) => fixture.sellerEmail.startsWith("bruno.")));
});

test("out-of-allowlist proof key is in the fixture but never in the response projection", () => {
  for (const fixture of fixtures) {
    assert.ok(PREVIEW_CREDIT_OUT_OF_ALLOWLIST_KEY in fixture.financialProfile);
    assert.doesNotMatch(JSON.stringify(projectClientForResponse(fixture)), new RegExp(PREVIEW_CREDIT_OUT_OF_ALLOWLIST_KEY));
  }
});
