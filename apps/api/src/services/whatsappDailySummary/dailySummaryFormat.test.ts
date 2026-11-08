import assert from "node:assert/strict";
import { MAX_SEND_TEXT_LENGTH } from "../whatsappConnection/evolutionClient.js";
import { formatDailySummary, plainText, type DailySummaryData, type DailySummaryItem } from "./dailySummaryFormat.js";

// WhatsApp Fase D: texto do resumo diário. Só dados fictícios.
const item = (name: string, extra: Partial<DailySummaryItem> = {}): DailySummaryItem => ({
  clientName: name,
  city: "Cidade Ficticia",
  state: "uf",
  stage: "prospeccao",
  followUpDate: new Date("2026-11-10T00:00:00.000Z"),
  isNew: false,
  ...extra
});
const many = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => item(`${prefix} ${index + 1}`));

const data: DailySummaryData = {
  sellerName: "Vendedor Ficticio da Silva",
  dayKey: "2026-11-09",
  sections: {
    reactivations: { total: 2, newCount: 1, items: [item("Cliente Exemplo A", { isNew: true }), item("Cliente Exemplo B")] },
    newOpportunities: { total: 1, newCount: 0, items: [item("Cliente Exemplo C", { stage: "negociacao" })] },
    overdueFollowUps: { total: 13, newCount: 0, items: many("Cliente Vencido", 12) },
    todayFollowUps: { total: 0, newCount: 0, items: [] }
  }
};

// 1) Texto completo: cabeçalho, seções com total, "NOVA" só nas reativações, máximo 10 itens + "+N no CRM",
//    seção vazia some, links do CRM.
const text = formatDailySummary(data, { crmUrl: "https://crm.exemplo.invalid/" });
assert.equal(
  text,
  [
    "Bom dia, Vendedor! Resumo da sua carteira – 09/11",
    "",
    "*Reativações abertas* (2, 1 nova nas últimas 24 h)",
    "• NOVA – Cliente Exemplo A – Cidade Ficticia/UF – Prospecção – follow-up 10/11",
    "• Cliente Exemplo B – Cidade Ficticia/UF – Prospecção – follow-up 10/11",
    "",
    "*Oportunidades lançadas nas últimas 24 h* (1)",
    "• Cliente Exemplo C – Cidade Ficticia/UF – Negociação – follow-up 10/11",
    "",
    "*Follow-ups vencidos* (13)",
    ...Array.from({ length: 10 }, (_, index) => `• Cliente Vencido ${index + 1} – Cidade Ficticia/UF – Prospecção – follow-up 10/11`),
    "+3 no CRM",
    "",
    "Ver no CRM: https://crm.exemplo.invalid/oportunidades",
    "Vencidos: https://crm.exemplo.invalid/oportunidades?overdue=true"
  ].join("\n")
);
assert.doesNotMatch(text!, /Follow-ups de hoje/, "seção vazia não aparece");

// 2) Vendedor sem nada (ou só seções desligadas): null = não envia, mesmo com dicas.
const empty: DailySummaryData = { sellerName: "Vendedor Ficticio", dayKey: "2026-11-09", sections: { todayFollowUps: { total: 0, newCount: 0, items: [] } } };
assert.equal(formatDailySummary(empty, { crmUrl: null, managerTips: ["Dica ficticia"] }), null);
assert.equal(formatDailySummary({ ...empty, sections: {} }, { crmUrl: null }), null);

// 3) Sem endereço do CRM (ou inválido): sem link. "NOVA" não aparece fora das reativações.
const noLink = formatDailySummary({ ...data, sections: { newOpportunities: { total: 1, newCount: 1, items: [item("Cliente Exemplo D", { isNew: true })] } } }, { crmUrl: "" })!;
assert.doesNotMatch(noLink, /Ver no CRM|https?:/);
assert.doesNotMatch(noLink, /NOVA/);
assert.doesNotMatch(formatDailySummary(data, { crmUrl: "javascript:alert(1)" })!, /Ver no CRM/);

// 4) Ponto de extensão "Dicas do gerente comercial": antes dos links, no máximo 3, uma linha cada.
const withTips = formatDailySummary(data, { crmUrl: "https://crm.exemplo.invalid", managerTips: ["Dica *um*\ncom quebra", "", "Dica dois", "Dica três", "Dica quatro"] })!;
assert.match(withTips, /\*Dicas do gerente comercial\*\n• Dica um com quebra\n• Dica dois\n• Dica três\n\nVer no CRM/);
assert.doesNotMatch(withTips, /Dica quatro/);
assert.doesNotMatch(formatDailySummary(data, { crmUrl: null })!, /Dicas do gerente/, "sem dicas, sem bloco");

// 5) Texto de cadastro: sem marcação do WhatsApp, numa linha, com limite; cidade ou UF ausentes.
assert.equal(plainText("  Nome *com*   _marcas_\n e ~quebra~ `x` "), "Nome com marcas e quebra x");
assert.equal(plainText("A".repeat(80)).length, 60);
const partial = formatDailySummary(
  { ...data, sections: { todayFollowUps: { total: 1, newCount: 0, items: [item("", { city: null, state: "SP", stage: "desconhecida", followUpDate: null })] } } },
  { crmUrl: null }
)!;
assert.match(partial, /• Cliente sem nome – SP – desconhecida$/m);

// 6) Pior caso (4 seções cheias, nomes e cidades longos, 3 dicas longas): cabe no limite do envio.
const longItem = item("N".repeat(200), { city: "C".repeat(200), state: "UF", stage: "negociacao", isNew: true });
const full = { total: 999, newCount: 999, items: Array.from({ length: 30 }, () => longItem) };
const worst = formatDailySummary(
  { sellerName: "V".repeat(200), dayKey: "2026-11-09", sections: { reactivations: full, newOpportunities: full, overdueFollowUps: full, todayFollowUps: full } },
  { crmUrl: `https://${"c".repeat(100)}.invalid`, managerTips: ["D".repeat(1_000), "D".repeat(1_000), "D".repeat(1_000)] }
)!;
assert(worst.length < MAX_SEND_TEXT_LENGTH, `pior caso com ${worst.length} caracteres`);

console.log("dailySummaryFormat.test.ts: ok");
