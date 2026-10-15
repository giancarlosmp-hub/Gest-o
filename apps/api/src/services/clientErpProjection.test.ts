import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_FINANCIAL_PROFILE_ALLOWED_KEYS,
  CLIENT_PARTNER_TITLE_ALLOWED_KEYS,
  ERP_AVERAGE_DELAY_TOLERANCE_DAYS,
  buildClientCreditAlert,
  buildClientDelayMetrics,
  parseErpDueDay,
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
  DATA_VENCIMENTO: "2099-05-13T03:00:00.000Z",
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
  // DIAS_MEDIAATRASO 4 fica dentro de ERP_AVERAGE_DELAY_TOLERANCE_DAYS: sem aviso.
  assert.deepEqual(response.creditAlert, { level: "ok", reasons: [] });
  assert.deepEqual(response.delayMetrics, { openDelayDays: 0, overdueTitlesCount: 0, oldestOverdueDueDate: null, unparseableDueDates: 0 });
});

// Regra antiga do web (ClientDetailsPage), copiada como referência para provar que os limites não mudaram.
const legacyNumberFromErp = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
// O maior atraso em aberto agora vem dos títulos: sem títulos ele é 0, e o DIAS_MAIORATRASO_AB do ERP é ignorado.
const legacyBadge = (financial: Record<string, unknown>, openDelay = 0) => {
  const averageDelay = legacyNumberFromErp(financial.DIAS_MEDIAATRASO);
  const bouncedChecks = legacyNumberFromErp(financial.QTD_CHEQUES_DEV);
  return averageDelay === 0 && openDelay === 0 && bouncedChecks === 0
    ? "Verde"
    : (averageDelay ?? 0) > 15 || (openDelay ?? 0) > 0 || (bouncedChecks ?? 0) > 0
      ? "Vermelho"
      : "Amarelo";
};
const levelByLegacyBadge = { Verde: "ok", Amarelo: "atencao", Vermelho: "risco" } as const;

test("creditAlert matches the legacy web rule (open delay from titles) when there are no overdue titles", () => {
  const profiles: Record<string, unknown>[] = [
    { DIAS_MEDIAATRASO: 0, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 },
    {},
    { DIAS_MEDIAATRASO: "0", DIAS_MAIORATRASO_AB: null, QTD_CHEQUES_DEV: "" },
    // Média até ERP_AVERAGE_DELAY_TOLERANCE_DAYS saiu da regra antiga de propósito (teste próprio abaixo).
    { DIAS_MEDIAATRASO: 5, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 },
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
  const now = new Date("2026-01-09T15:00:00.000Z");
  const titleFiveDaysLate = { DATA_VENCIMENTO: "2026-01-04T03:00:00.000Z", SALDO_CAPITAL: 100 };
  assert.deepEqual(buildClientCreditAlert({ financialProfile: { DIAS_MEDIAATRASO: 20, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 1 }, partnerTitles: [titleFiveDaysLate] }, now), {
    level: "risco",
    reasons: ["Atraso médio de 20 dias", "Maior atraso em aberto: 5 dias", "1 cheque devolvido"]
  });
  assert.deepEqual(buildClientCreditAlert({ financialProfile: { DIAS_MEDIAATRASO: 5, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 } }), {
    level: "atencao",
    reasons: ["Atraso médio de 5 dias"]
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

test("creditAlert tolerates the ERP average delay up to ERP_AVERAGE_DELAY_TOLERANCE_DAYS", () => {
  assert.equal(ERP_AVERAGE_DELAY_TOLERANCE_DAYS, 4);
  const now = new Date("2026-01-09T15:00:00.000Z");
  const profile = (average: unknown) => ({ DIAS_MEDIAATRASO: average, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 });
  const hasAverageReason = (reasons: string[]) => reasons.some((reason) => reason.startsWith("Atraso médio"));

  for (const average of [0, 2, 4, "4", "4,0"]) {
    assert.deepEqual(buildClientCreditAlert({ financialProfile: profile(average), overdueTitlesTotal: 0 }, now), { level: "ok", reasons: [] }, String(average));
  }
  assert.deepEqual(buildClientCreditAlert({ financialProfile: profile(4.1) }, now), { level: "atencao", reasons: ["Atraso médio de 4,1 dias"] });
  assert.deepEqual(buildClientCreditAlert({ financialProfile: profile("4,5") }, now), { level: "atencao", reasons: ["Atraso médio de 4,5 dias"] });
  assert.deepEqual(buildClientCreditAlert({ financialProfile: profile(5) }, now), { level: "atencao", reasons: ["Atraso médio de 5 dias"] });

  // Título vencido e maior atraso em aberto pelos títulos continuam sem tolerância.
  const withOverdue = buildClientCreditAlert({ financialProfile: profile(2), overdueTitlesTotal: 100 }, now);
  assert.equal(withOverdue.level, "risco");
  assert.equal(withOverdue.reasons.length, 1);
  assert.match(withOverdue.reasons[0], /^Cliente com títulos vencidos/);
  const titleOneDayLate = { DATA_VENCIMENTO: "2026-01-08T03:00:00.000Z", SALDO_CAPITAL: 100 };
  assert.deepEqual(buildClientCreditAlert({ financialProfile: profile(2), partnerTitles: [titleOneDayLate] }, now), {
    level: "risco",
    reasons: ["Maior atraso em aberto: 1 dia"]
  });

  // Média ausente (sem perfil, chave ausente ou vazia): nenhum aviso por média.
  assert.deepEqual(buildClientCreditAlert({ financialProfile: null }, now), { level: "ok", reasons: [] });
  for (const average of [undefined, null, ""]) {
    const missingAverage = buildClientCreditAlert({ financialProfile: profile(average) }, now);
    assert.equal(hasAverageReason(missingAverage.reasons), false, String(average));
  }

  // Selo verde (level ok) quando não sobra nenhum motivo.
  assert.equal(buildClientCreditAlert({ financialProfile: profile(3), partnerTitles: [{ DATA_VENCIMENTO: "2026-02-01T03:00:00.000Z", SALDO_CAPITAL: 100 }], overdueTitlesTotal: 0 }, now).level, "ok");
});

// ---------------------------------------------------------------------------------------------
// Atraso em aberto calculado pelos títulos (dados fictícios; "agora" fixo)
// ---------------------------------------------------------------------------------------------

// 09/01/2026 12:00 em São Paulo.
const NOW = new Date("2026-01-09T15:00:00.000Z");
const title = (dueDate: unknown, saldo: unknown = 100) => ({ DOCTO: 1, PARCELA: "1", DATA_VENCIMENTO: dueDate, SALDO_CAPITAL: saldo });

test("parseErpDueDay reads ISO as the São Paulo calendar day and accepts dd/mm and dd.mm", () => {
  assert.equal(parseErpDueDay("2025-12-10T03:00:00.000Z"), "2025-12-10", "meia-noite local");
  assert.equal(parseErpDueDay("2025-12-10T02:59:59.000Z"), "2025-12-09", "ainda é o dia anterior em São Paulo");
  assert.equal(parseErpDueDay("2025-12-10"), "2025-12-10");
  assert.equal(parseErpDueDay("10/12/2025"), "2025-12-10");
  assert.equal(parseErpDueDay("10.12.2025"), "2025-12-10");
  assert.equal(parseErpDueDay(" 10/12/2025 "), "2025-12-10");
  for (const invalid of ["31/02/2025", "2025-13-01", "abc", "", "12/2025", 20251210, null, undefined]) {
    assert.equal(parseErpDueDay(invalid), null, String(invalid));
  }
});

test("delay metrics: null without titles, 0 without overdue titles", () => {
  assert.equal(buildClientDelayMetrics(null, NOW).openDelayDays, null);
  assert.equal(buildClientDelayMetrics([], NOW).openDelayDays, null);
  assert.equal(buildClientDelayMetrics({ DOCTO: 1 }, NOW).openDelayDays, null);
  assert.deepEqual(buildClientDelayMetrics([title("2026-02-01T03:00:00.000Z")], NOW), {
    openDelayDays: 0, overdueTitlesCount: 0, oldestOverdueDueDate: null, unparseableDueDates: 0,
  });
  // Título pago (saldo 0) não é atraso.
  assert.equal(buildClientDelayMetrics([title("2025-01-01T03:00:00.000Z", 0)], NOW).openDelayDays, 0);
});

test("delay metrics: oldest due date with balance, in calendar days", () => {
  const metrics = buildClientDelayMetrics(
    [
      title("2025-12-10T03:00:00.000Z"),
      title("2025-12-10T03:00:00.000Z", "1.234,56"),
      title("2025-12-20T03:00:00.000Z"),
      title("2025-11-01T03:00:00.000Z", "0,00"), // mais antigo, mas pago
      title("2026-03-01T03:00:00.000Z"), // a vencer
    ],
    NOW
  );
  assert.deepEqual(metrics, { openDelayDays: 30, overdueTitlesCount: 3, oldestOverdueDueDate: "2025-12-10", unparseableDueDates: 0 });
});

test("delay metrics: due at local midnight, due today counts 0 days", () => {
  assert.deepEqual(buildClientDelayMetrics([title("2026-01-09T03:00:00.000Z")], NOW), {
    openDelayDays: 0, overdueTitlesCount: 1, oldestOverdueDueDate: "2026-01-09", unparseableDueDates: 0,
  });
  const due = [title("2026-01-08T03:00:00.000Z")];
  assert.equal(buildClientDelayMetrics(due, new Date("2026-01-09T02:59:00.000Z")).openDelayDays, 0, "23:59 do dia 08 em São Paulo");
  assert.equal(buildClientDelayMetrics(due, new Date("2026-01-09T03:00:00.000Z")).openDelayDays, 1, "00:00 do dia 09 em São Paulo");
});

test("delay metrics: ISO, dd/mm and dd.mm give the same result; unreadable dates are counted", () => {
  for (const due of ["2025-12-10T03:00:00.000Z", "2025-12-10", "10/12/2025", "10.12.2025"]) {
    assert.equal(buildClientDelayMetrics([title(due)], NOW).openDelayDays, 30, due);
  }
  assert.deepEqual(buildClientDelayMetrics([title("sem data")], NOW), {
    openDelayDays: null, overdueTitlesCount: 0, oldestOverdueDueDate: null, unparseableDueDates: 1,
  });
  const mixed = buildClientDelayMetrics([title("sem data"), title("2025-12-10T03:00:00.000Z")], NOW);
  assert.equal(mixed.openDelayDays, 30);
  assert.equal(mixed.unparseableDueDates, 1);
});

test("creditAlert uses the delay computed from titles, not DIAS_MAIORATRASO_AB", () => {
  const erpSaysZero = { DIAS_MEDIAATRASO: 0, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0 };
  const overdueSince = [title("2025-12-10T03:00:00.000Z"), title("2025-12-10T03:00:00.000Z"), title("2025-12-10T03:00:00.000Z")];
  const alert = buildClientCreditAlert({ financialProfile: erpSaysZero, partnerTitles: overdueSince, overdueTitlesTotal: 300 }, NOW);
  assert.equal(alert.level, "risco");
  assert.equal(alert.reasons.length, 2);
  assert.match(alert.reasons[0], /^Cliente com títulos vencidos: /);
  assert.equal(alert.reasons[1], "Maior atraso em aberto: 30 dias");

  // Total vencido ainda zerado (sincronização antiga), mas o título já venceu: o atraso calculado basta.
  assert.deepEqual(buildClientCreditAlert({ financialProfile: erpSaysZero, partnerTitles: overdueSince, overdueTitlesTotal: 0 }, NOW), {
    level: "risco",
    reasons: ["Maior atraso em aberto: 30 dias"],
  });

  // O campo do ERP sozinho não acende mais o alerta.
  assert.deepEqual(buildClientCreditAlert({ financialProfile: { ...erpSaysZero, DIAS_MAIORATRASO_AB: 12 }, partnerTitles: [] }, NOW), { level: "ok", reasons: [] });

  // Vencimento ilegível com saldo: atenção, nunca verde.
  assert.deepEqual(buildClientCreditAlert({ financialProfile: erpSaysZero, partnerTitles: [title("sem data")] }, NOW), {
    level: "atencao",
    reasons: ["1 título(s) com vencimento ilegível no ERP; confira com o financeiro"],
  });
});

test("allowlist and delayMetrics shape are unchanged by the computed delay", () => {
  assert.deepEqual([...CLIENT_FINANCIAL_PROFILE_ALLOWED_KEYS], [
    "DIAS_MEDIAATRASO", "DIAS_MAIORATRASO_AB", "QTD_CHEQUES_DEV", "VALOR_MEDIO", "DATA_PRIMFATURA", "DATA_ULTFATURA", "VALOR_ULTFATURA",
  ]);
  const response = projectClientForResponse({ id: "client-fake", financialProfile: rawFinancialProfile, partnerTitles: [rawTitle, title("2025-12-10T03:00:00.000Z")] });
  assert.deepEqual(Object.keys(response.delayMetrics).sort(), ["oldestOverdueDueDate", "openDelayDays", "overdueTitlesCount", "unparseableDueDates"]);
  assert.doesNotMatch(JSON.stringify(response), /synthetic|LIMITE_CREDITO|NOSSO_NUMERO|FATURAS_RECEBER_ID/);
});
