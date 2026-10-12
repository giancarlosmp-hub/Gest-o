import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_FINANCIAL_PROFILE_ALLOWED_KEYS,
  CLIENT_PARTNER_TITLE_ALLOWED_KEYS,
  buildClientCreditAlert,
  projectClientFinancialProfile,
  projectClientForResponse,
  projectClientPartnerTitles
} from "./clientErpProjection.js";

// Dados fictícios: nenhum valor real de cliente.
const rawFinancialProfile = {
  DIAS_MEDIAATRASO: 4,
  DIAS_MAIORATRASO_AB: 0,
  QTD_CHEQUES_DEV: 0,
  VALOR_MEDIO: 1500.5,
  DATA_PRIMFATURA: "2020-01-10T03:00:00.000Z",
  DATA_ULTFATURA: "2026-01-10T03:00:00.000Z",
  VALOR_ULTFATURA: 900,
  LIMITE_CREDITO: 50000,
  CPF_CNPJ: "synthetic-document",
  RAZAO_SOCIAL: "synthetic-name",
  OBS_FINANCEIRO: "synthetic-note",
  NESTED: { anything: "synthetic" }
};

const rawTitle = {
  FATURAS_RECEBER_ID: 1,
  DOCTO: 123,
  PARCELA: "1/3",
  DATA_VENCIMENTO: "2026-05-13T03:00:00.000Z",
  DSCFORMA: "BOLETO",
  VALOR: 1000,
  SALDO_CAPITAL: 400,
  NOSSO_NUMERO: "synthetic-bank-id",
  PARCEIRO: "synthetic-partner",
  CPF_CNPJ: "synthetic-document"
};

test("financialProfile projection keeps only allowlisted keys", () => {
  const projected = projectClientFinancialProfile(rawFinancialProfile)!;
  assert.deepEqual(Object.keys(projected).sort(), [...CLIENT_FINANCIAL_PROFILE_ALLOWED_KEYS].sort());
  for (const key of Object.keys(projected)) assert.ok((CLIENT_FINANCIAL_PROFILE_ALLOWED_KEYS as readonly string[]).includes(key));
  assert.doesNotMatch(JSON.stringify(projected), /synthetic|LIMITE_CREDITO|NESTED/);
  assert.equal(projectClientFinancialProfile(null), null);
  assert.equal(projectClientFinancialProfile([rawFinancialProfile]), null);
  assert.deepEqual(projectClientFinancialProfile({ DIAS_MEDIAATRASO: { nested: true } }), {});
});

test("partnerTitles projection keeps only allowlisted keys", () => {
  const projected = projectClientPartnerTitles([rawTitle, "lixo", null, { DOCTO: 9, EXTRA: "synthetic" }]);
  assert.equal(projected.length, 2);
  for (const title of projected) {
    for (const key of Object.keys(title)) assert.ok((CLIENT_PARTNER_TITLE_ALLOWED_KEYS as readonly string[]).includes(key), key);
  }
  assert.deepEqual(Object.keys(projected[0]).sort(), [...CLIENT_PARTNER_TITLE_ALLOWED_KEYS].sort());
  assert.doesNotMatch(JSON.stringify(projected), /synthetic|FATURAS_RECEBER_ID|NOSSO_NUMERO/);
  assert.deepEqual(projectClientPartnerTitles(null), []);
  assert.deepEqual(projectClientPartnerTitles({ DOCTO: 1 }), []);
});

test("client response projection replaces raw ERP payload and adds creditAlert", () => {
  const response = projectClientForResponse({
    id: "client-fake",
    name: "Cliente Fictício",
    overdueTitlesTotal: 0,
    financialProfile: rawFinancialProfile,
    partnerTitles: [rawTitle]
  });
  assert.equal(response.id, "client-fake");
  assert.doesNotMatch(JSON.stringify(response), /synthetic|LIMITE_CREDITO|NOSSO_NUMERO|FATURAS_RECEBER_ID/);
  assert.deepEqual(response.creditAlert, { level: "atencao", reasons: ["Atraso médio de 4 dias"] });
});

// Regra antiga do web (ClientDetailsPage), copiada como referência para provar que os limites não mudaram.
const legacyNumberFromErp = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
const legacyBadge = (financial: Record<string, unknown>) => {
  const averageDelay = legacyNumberFromErp(financial.DIAS_MEDIAATRASO);
  const openDelay = legacyNumberFromErp(financial.DIAS_MAIORATRASO_AB);
  const bouncedChecks = legacyNumberFromErp(financial.QTD_CHEQUES_DEV);
  return averageDelay === 0 && openDelay === 0 && bouncedChecks === 0
    ? "Verde"
    : (averageDelay ?? 0) > 15 || (openDelay ?? 0) > 0 || (bouncedChecks ?? 0) > 0
      ? "Vermelho"
      : "Amarelo";
};
const levelByLegacyBadge = { Verde: "ok", Amarelo: "atencao", Vermelho: "risco" } as const;

test("creditAlert matches the legacy web rule when there are no overdue titles", () => {
  const profiles: Record<string, unknown>[] = [
    { DIAS_MEDIAATRASO: 0, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 },
    {},
    { DIAS_MEDIAATRASO: "0", DIAS_MAIORATRASO_AB: null, QTD_CHEQUES_DEV: "" },
    { DIAS_MEDIAATRASO: 1, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 },
    { DIAS_MEDIAATRASO: 15, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 },
    { DIAS_MEDIAATRASO: "abc", DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 },
    { DIAS_MEDIAATRASO: -2, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 },
    { DIAS_MEDIAATRASO: 16, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 },
    { DIAS_MEDIAATRASO: 0, DIAS_MAIORATRASO_AB: 3, QTD_CHEQUES_DEV: 0 },
    { DIAS_MEDIAATRASO: 0, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 1 },
    { DIAS_MEDIAATRASO: "20,5", DIAS_MAIORATRASO_AB: "10", QTD_CHEQUES_DEV: "2" }
  ];
  const seen = new Set<string>();
  for (const profile of profiles) {
    const expected = levelByLegacyBadge[legacyBadge(profile)];
    seen.add(expected);
    const alert = buildClientCreditAlert({ financialProfile: profile, overdueTitlesTotal: 0 });
    assert.equal(alert.level, expected, JSON.stringify(profile));
    assert.equal(alert.reasons.length === 0, expected === "ok", JSON.stringify(profile));
  }
  assert.deepEqual([...seen].sort(), ["atencao", "ok", "risco"]);
});

test("creditAlert reasons are clear for the seller", () => {
  assert.deepEqual(buildClientCreditAlert({ financialProfile: { DIAS_MEDIAATRASO: 20, DIAS_MAIORATRASO_AB: 5, QTD_CHEQUES_DEV: 1 } }), {
    level: "risco",
    reasons: ["Atraso médio de 20 dias", "Maior atraso em aberto: 5 dias", "1 cheque devolvido"]
  });
  assert.deepEqual(buildClientCreditAlert({ financialProfile: { DIAS_MEDIAATRASO: 1, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 } }), {
    level: "atencao",
    reasons: ["Atraso médio de 1 dia"]
  });
});

test("creditAlert considers overdueTitlesTotal as risk", () => {
  const withoutProfile = buildClientCreditAlert({ financialProfile: null, overdueTitlesTotal: 1234.56 });
  assert.equal(withoutProfile.level, "risco");
  assert.equal(withoutProfile.reasons.length, 1);
  assert.equal(withoutProfile.reasons[0].replace(/\s/g, " "), "Cliente com títulos vencidos: R$ 1.234,56");

  const greenProfile = buildClientCreditAlert({ financialProfile: { DIAS_MEDIAATRASO: 0, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 }, overdueTitlesTotal: 10 });
  assert.equal(greenProfile.level, "risco");

  const yellowProfile = buildClientCreditAlert({ financialProfile: { DIAS_MEDIAATRASO: 5, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 }, overdueTitlesTotal: 10 });
  assert.equal(yellowProfile.level, "risco");
  assert.equal(yellowProfile.reasons.length, 2);

  assert.deepEqual(buildClientCreditAlert({ financialProfile: null, overdueTitlesTotal: 0 }), { level: "ok", reasons: [] });
  assert.deepEqual(buildClientCreditAlert({}), { level: "ok", reasons: [] });
});
