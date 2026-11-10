import assert from "node:assert/strict";
import type { DailySummaryData, DailySummaryItem, DailySummaryTipFacts } from "./dailySummaryFormat.js";
import {
  buildDailySummaryTipsInput,
  DAILY_SUMMARY_TIPS_SYSTEM_PROMPT,
  dailySummaryTipsUserMessage,
  MAX_TIP_CODES,
  validateDailySummaryTips
} from "./dailySummaryTips.js";

// Resumo diário: dados anonimizados e conferência das dicas do gerente comercial. Só dados fictícios.

// 10/11/2026 (terça), 07:30 em Brasília = 10:30 UTC.
const now = new Date("2026-11-10T10:30:00.000Z");
const day = (dayKey: string) => new Date(`${dayKey}T00:00:00.000Z`);
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

let sequence = 0;
const item = (name: string, extra: Partial<DailySummaryItem> = {}, facts: Partial<DailySummaryTipFacts> = {}): DailySummaryItem => ({
  clientName: name,
  city: "Cidade Ficticia Secreta",
  state: "pr",
  stage: "proposta",
  followUpDate: day("2026-11-07"),
  isNew: false,
  tipFacts: {
    opportunityId: `opp-${++sequence}`,
    value: 48_000.4,
    lastContactAt: daysAgo(9),
    stageSince: daysAgo(12),
    crop: "Aveia",
    products: ["Aveia Preta Ficticia", "Aveia Preta Ficticia", ""],
    lastPurchaseDate: day("2026-03-15"),
    ...facts
  },
  ...extra
});

const overdue = item("Agropecuaria Ficticia Alfa Ltda");
const reactivation = item("Produtor Ficticio Beta", { stage: "prospeccao", state: "SC", followUpDate: day("2026-11-12") }, { value: 0, lastContactAt: null, crop: null, products: [] });
const data: DailySummaryData = {
  sellerName: "Vendedor Ficticio",
  dayKey: "2026-11-10",
  sections: {
    reactivations: { total: 1, newCount: 0, items: [reactivation] },
    overdueFollowUps: { total: 1, newCount: 0, items: [overdue] },
    // A mesma oportunidade em duas seções recebe um código só.
    todayFollowUps: { total: 2, newCount: 0, items: [{ ...overdue }, item("Revenda Ficticia Gama", { stage: "negociacao", followUpDate: day("2026-11-10"), state: "Mato Grosso do Sul" }, { crop: "milho", products: [] })] }
  }
};

// 1) Anonimização: códigos na ordem do resumo, só os campos permitidos, sem nome, cidade, região nem ids.
const input = buildDailySummaryTipsInput(data, now)!;
assert.deepEqual([...input.names.entries()], [
  ["C1", "Produtor Ficticio Beta"],
  ["C2", "Agropecuaria Ficticia Alfa Ltda"],
  ["C3", "Revenda Ficticia Gama"]
]);
assert.deepEqual(input.payload, {
  hoje: "2026-11-10",
  mes: "novembro",
  ufs: ["PR", "SC"],
  oportunidades: [
    { codigo: "C1", secao: "reativacao", etapa: "prospeccao", diasNaEtapa: 12, ultimaCompra: "2026-03-15", uf: "SC" },
    {
      codigo: "C2",
      secao: "follow_up_vencido",
      etapa: "proposta",
      valor: 48_000,
      diasFollowUpVencido: 3,
      diasSemContato: 9,
      diasNaEtapa: 12,
      cultura: "Aveia",
      produtos: ["Aveia Preta Ficticia"],
      uf: "PR"
    },
    { codigo: "C3", secao: "follow_up_hoje", etapa: "negociacao", valor: 48_000, diasSemContato: 9, diasNaEtapa: 12, cultura: "milho" }
  ]
}, "última compra só na reativação; UF inválida fica de fora");
const message = dailySummaryTipsUserMessage(input);
assert.doesNotMatch(message, /Ficticia Alfa|Ficticio Beta|Ficticia Gama|Cidade Ficticia|Secreta|opp-\d|Vendedor/);
assert.doesNotMatch(DAILY_SUMMARY_TIPS_SYSTEM_PROMPT, /Ficticio|Ficticia/);
assert.match(DAILY_SUMMARY_TIPS_SYSTEM_PROMPT, /Claude, gerente comercial/);
assert.deepEqual([...input.cultures].sort(), ["aveia", "milho"]);

// Sem dados das dicas (ou sem itens): nada a pedir.
assert.equal(buildDailySummaryTipsInput({ ...data, sections: { reactivations: { total: 1, newCount: 0, items: [{ ...reactivation, tipFacts: undefined }] } } }, now), null);
assert.equal(buildDailySummaryTipsInput({ ...data, sections: {} }, now), null);

// Compra com horário: dia de Brasília (01:00 UTC do dia 16 ainda é dia 15 em Brasília).
const timed = buildDailySummaryTipsInput({ ...data, sections: { reactivations: { total: 1, newCount: 0, items: [item("Cliente Ficticio", {}, { lastPurchaseDate: new Date("2026-03-16T01:00:00.000Z") })] } } }, now)!;
assert.equal(timed.payload.oportunidades[0].ultimaCompra, "2026-03-15");

// No máximo 12 códigos.
const crowded = buildDailySummaryTipsInput(
  { ...data, sections: { overdueFollowUps: { total: 10, newCount: 0, items: Array.from({ length: 10 }, (_, index) => item(`Cliente Ficticio ${index}`)) }, todayFollowUps: { total: 10, newCount: 0, items: Array.from({ length: 10 }, (_, index) => item(`Cliente Ficticio Hoje ${index}`)) } } },
  now
)!;
assert.equal(crowded.payload.oportunidades.length, MAX_TIP_CODES);
assert.equal(crowded.names.size, MAX_TIP_CODES);

// 2) Resposta válida: códigos trocados pelos nomes (também em cerca de markdown e com o código em minúscula).
const answer = (tips: unknown) => JSON.stringify({ dicas: tips });
const valid = validateDailySummaryTips(
  "```json\n" + answer(["Comece por C2: proposta parada há 12 dias. Ligue e retome a necessidade de aveia.", "c3 está em negociação e o follow-up é hoje: confirme o volume de milho.", "Com C1, faça contato de relacionamento antes de oferecer."]) + "\n```",
  input
);
assert.deepEqual(valid, {
  ok: true,
  tips: [
    "Comece por Agropecuaria Ficticia Alfa Ltda: proposta parada há 12 dias. Ligue e retome a necessidade de aveia.",
    "Revenda Ficticia Gama está em negociação e o follow-up é hoje: confirme o volume de milho.",
    "Com Produtor Ficticio Beta, faça contato de relacionamento antes de oferecer."
  ]
});
assert.deepEqual(validateDailySummaryTips(answer(["Uma dica\ncom quebra de linha, sem código."]), input), { ok: true, tips: ["Uma dica com quebra de linha, sem código."] });

// 3) Qualquer falha descarta tudo.
const reason = (content: string) => {
  const result = validateDailySummaryTips(content, input);
  return result.ok ? "ok" : result.reason;
};
assert.equal(reason("texto livre sem JSON"), "invalid_format");
assert.equal(reason(JSON.stringify(["lista solta"])), "invalid_format");
assert.equal(reason(JSON.stringify({ dicas: "uma só" })), "invalid_format");
assert.equal(reason(JSON.stringify({ dicas: ["ok"], extra: true })), "invalid_format");
assert.equal(reason(answer(["ok", 3])), "invalid_format");
assert.equal(reason(answer([])), "empty");
assert.equal(reason(answer(["ok", "  "])), "empty");
assert.equal(reason(answer(["a", "b", "c", "d"])), "too_many");
assert.equal(reason(answer(["x".repeat(251)])), "too_long");
assert.equal(reason(answer(["x".repeat(250)])), "ok");
assert.equal(reason(answer(["Ligue para C4 hoje."])), "unknown_code", "código que não existe");
assert.equal(reason(answer(["Ligue para C02 hoje."])), "unknown_code");
assert.equal(reason(answer(["Boa dica para C1.", "Ligue para C13."])), "unknown_code", "uma dica ruim descarta todas");
for (const forbidden of ["Ofereça 5% a C2.", "Feche C2 por R$ 40 mil.", "Mostre o preço de tabela.", "Dê um desconto a C2.", "Aproveite a promoção.", "Proponha parcelamento.", "Negocie o prazo com C2.", "Ofereça condição de pagamento especial.", "Ofereça brinde.", "Fale em 40 mil reais."]) {
  assert.equal(reason(answer([forbidden])), "forbidden_term", forbidden);
}
assert.equal(reason(answer(["Lembre C3 do plantio de soja."])), "culture_not_in_data", "soja não está nos dados");
assert.equal(reason(answer(["Ofereça sorgo a C1."])), "culture_not_in_data");
assert.equal(reason(answer(["Confirme as aveias de C2 e o milho de C3."])), "ok", "plural e culturas dos dados");
assert.equal(reason(""), "invalid_format");

console.log("dailySummaryTips.test.ts: ok");
