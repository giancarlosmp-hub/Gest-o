import assert from "node:assert/strict";
import { prisma } from "../../config/prisma.js";
import { createWhatsAppConversationsTestDb } from "../whatsappMessages/whatsappConversationsTestDb.js";
import { INACTIVE_RECENT_AUTOMATION_ORIGIN } from "../commercialAutomationsService.js";
import { DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG } from "@salesforce-pro/shared";
import { brazilDayKeyOf, buildDailySummaryMessage, loadDailySummaryData } from "./dailySummaryData.js";
import type { DailySummaryData } from "./dailySummaryFormat.js";
import { createDailySummaryTipsRound, type generateDailySummaryTips } from "./dailySummaryTips.js";

// WhatsApp Fase D: o que entra no resumo de um vendedor. Prisma em memória, só dados fictícios.
const { tables, calls } = createWhatsAppConversationsTestDb(prisma);

// 09/11/2026 (segunda), 07:30 em Brasília = 10:30 UTC.
const now = new Date("2026-11-09T10:30:00.000Z");
assert.equal(brazilDayKeyOf(now), "2026-11-09");
assert.equal(brazilDayKeyOf(new Date("2026-11-10T02:00:00.000Z")), "2026-11-09", "23h em Brasília ainda é o dia 9");

tables.client.push(
  { id: "client-a", name: "Cliente Ficticio A", city: "Cidade A", state: "SP", isArchived: false },
  { id: "client-b", name: "Cliente Ficticio B", city: "Cidade B", state: "PR", isArchived: false },
  { id: "client-archived", name: "Cliente Arquivado", city: "Cidade C", state: "MG", isArchived: true }
);
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const day = (dayKey: string) => new Date(`${dayKey}T00:00:00.000Z`);
let sequence = 0;
const opp = (extra: Record<string, unknown>) =>
  tables.opportunity.push({
    id: `opp-${++sequence}`,
    clientId: "client-a",
    ownerSellerId: "seller-a",
    stage: "prospeccao",
    origin: null,
    notes: null,
    createdAt: hoursAgo(72),
    followUpDate: day("2026-11-20"),
    ...extra
  });

// Reativações: uma nova (2 h), uma antiga, uma fechada, uma de cliente arquivado e uma de outro vendedor.
opp({ id: "react-new", origin: INACTIVE_RECENT_AUTOMATION_ORIGIN, createdAt: hoursAgo(2) });
opp({ id: "react-old", origin: INACTIVE_RECENT_AUTOMATION_ORIGIN, clientId: "client-b", createdAt: hoursAgo(48) });
opp({ id: "react-won", origin: INACTIVE_RECENT_AUTOMATION_ORIGIN, stage: "ganho", createdAt: hoursAgo(3) });
opp({ id: "react-archived", origin: INACTIVE_RECENT_AUTOMATION_ORIGIN, clientId: "client-archived", createdAt: hoursAgo(3) });
opp({ id: "react-other-seller", origin: INACTIVE_RECENT_AUTOMATION_ORIGIN, ownerSellerId: "seller-b", createdAt: hoursAgo(3) });
// Lançadas nas últimas 24 h: uma manual (conta), uma de 25 h (fora).
opp({ id: "manual-new", stage: "negociacao", createdAt: hoursAgo(5) });
opp({ id: "manual-25h", createdAt: hoursAgo(25) });
// Follow-ups: vencido (dia 8), de hoje (dia 9), de amanhã (fora), vencido mas perdido (fora).
opp({ id: "follow-overdue", stage: "proposta", followUpDate: day("2026-11-08") });
opp({ id: "follow-today", followUpDate: day("2026-11-09") });
opp({ id: "follow-tomorrow", followUpDate: day("2026-11-10") });
opp({ id: "follow-lost", stage: "perdido", followUpDate: day("2026-11-01") });

const seller = { id: "seller-a", name: "Vendedor Ficticio A" };
const all = { reactivations: true, newOpportunities: true, overdueFollowUps: true, todayFollowUps: true };

try {
  const data = await loadDailySummaryData(seller, all, now);
  assert.equal(data.dayKey, "2026-11-09");
  assert.equal(data.sellerName, "Vendedor Ficticio A");

  const reactivations = data.sections.reactivations!;
  assert.equal(reactivations.total, 2, "abertas, do vendedor, de cliente não arquivado");
  assert.equal(reactivations.newCount, 1);
  assert.deepEqual(
    reactivations.items.map((row) => [row.clientName, row.city, row.state, row.isNew]),
    [["Cliente Ficticio A", "Cidade A", "SP", true], ["Cliente Ficticio B", "Cidade B", "PR", false]],
    "mais nova primeiro"
  );

  const created = data.sections.newOpportunities!;
  assert.equal(created.total, 1, "sem as da automação e sem as de mais de 24 h");
  assert.equal(created.items[0].stage, "negociacao");

  assert.equal(data.sections.overdueFollowUps!.total, 1);
  assert.equal(data.sections.overdueFollowUps!.items[0].stage, "proposta");
  assert.equal(data.sections.todayFollowUps!.total, 1);
  assert.equal(data.sections.todayFollowUps!.items[0].followUpDate?.toISOString(), "2026-11-09T00:00:00.000Z");

  // Seções desligadas não são lidas.
  const only = await loadDailySummaryData(seller, { ...all, reactivations: false, newOpportunities: false }, now);
  assert.deepEqual(Object.keys(only.sections), ["overdueFollowUps", "todayFollowUps"]);

  // Limite de itens por seção, com o total completo.
  for (let index = 0; index < 14; index += 1) opp({ ownerSellerId: "seller-c", followUpDate: day("2026-11-02") });
  const crowded = await loadDailySummaryData({ id: "seller-c", name: "Vendedor Ficticio C" }, all, now);
  assert.equal(crowded.sections.overdueFollowUps!.total, 14);
  assert.equal(crowded.sections.overdueFollowUps!.items.length, 10);

  // Sem dicas: nada de tipFacts e nenhuma leitura de itens ou histórico.
  assert.equal(data.sections.overdueFollowUps!.items[0].tipFacts, undefined);
  assert.equal(calls.filter((call) => call.model === "opportunityItem" || call.model === "opportunityChangeLog").length, 0);

  // Com dicas: valor, último contato, cultura, produtos (ofertado + itens), última compra e última troca de etapa.
  tables.client.push({ id: "client-tips", name: "Cliente Ficticio Dicas", city: "Cidade D", state: "PR", isArchived: false, lastPurchaseDate: null, financialProfile: { DATA_ULTFATURA: "2026-03-15" } });
  opp({ id: "tips-opp", ownerSellerId: "seller-d", clientId: "client-tips", stage: "proposta", followUpDate: day("2026-11-05"), value: 30_000, lastContactAt: hoursAgo(100), crop: "Aveia", productOffered: "Aveia Ficticia Ofertada" });
  tables.opportunityItem.push(
    { id: "line-2", opportunityId: "tips-opp", lineNumber: 2, productNameSnapshot: "Produto Ficticio Dois" },
    { id: "line-1", opportunityId: "tips-opp", lineNumber: 1, productNameSnapshot: "Produto Ficticio Um" },
    { id: "line-other", opportunityId: "react-new", lineNumber: 1, productNameSnapshot: "Produto De Outra" }
  );
  tables.opportunityChangeLog.push(
    { id: "log-1", opportunityId: "tips-opp", field: "stage", createdAt: hoursAgo(200) },
    { id: "log-2", opportunityId: "tips-opp", field: "stage", createdAt: hoursAgo(50) },
    { id: "log-3", opportunityId: "tips-opp", field: "value", createdAt: hoursAgo(1) }
  );
  const withTips = await loadDailySummaryData({ id: "seller-d", name: "Vendedor Ficticio D" }, all, now, prisma, { tipFacts: true });
  assert.deepEqual(withTips.sections.overdueFollowUps!.items[0].tipFacts, {
    opportunityId: "tips-opp",
    value: 30_000,
    lastContactAt: hoursAgo(100),
    stageSince: hoursAgo(50),
    crop: "Aveia",
    products: ["Aveia Ficticia Ofertada", "Produto Ficticio Um", "Produto Ficticio Dois"],
    lastPurchaseDate: new Date("2026-03-15")
  });
  // Sem troca de etapa registrada: vale a criação.
  const noLog = await loadDailySummaryData(seller, all, now, prisma, { tipFacts: true });
  assert.deepEqual(noLog.sections.overdueFollowUps!.items[0].tipFacts!.stageSince, hoursAgo(72));

  // Mensagem: dicas desligadas não chamam a IA; ligadas entram no texto; sem itens, sem IA; sem dicas, texto igual.
  const config = { ...DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG, enabled: true };
  const context = { round: createDailySummaryTipsRound(), usageKey: "resumo-diario" };
  const generated: Array<DailySummaryData> = [];
  let tipsResult: Awaited<ReturnType<typeof generateDailySummaryTips>> = { status: "ok", tips: ["Dica ficticia"] };
  const generateTips: typeof generateDailySummaryTips = async (summary) => (generated.push(summary), tipsResult);

  const off = await buildDailySummaryMessage(seller, config, now, context, { generateTips });
  assert.equal(off.tips, "off");
  assert.doesNotMatch(off.text!, /Dicas do gerente/);
  assert.equal(generated.length, 0);

  const on = await buildDailySummaryMessage(seller, { ...config, managerTips: true }, now, context, { generateTips });
  assert.equal(on.tips, "ok");
  assert.match(on.text!, /\*Dicas do gerente comercial\*\n• Dica ficticia\n— Claude, gerente comercial/);
  assert(generated[0].sections.overdueFollowUps!.items[0].tipFacts, "a IA recebe os dados das dicas");

  tipsResult = { status: "ai_failed", tips: [] };
  const failed = await buildDailySummaryMessage(seller, { ...config, managerTips: true }, now, context, { generateTips });
  assert.deepEqual(failed, { text: off.text, tips: "ai_failed" }, "sem dicas, o resumo sai igual");

  const nothing = await buildDailySummaryMessage({ id: "seller-sem-nada", name: "Vendedor Ficticio Vazio" }, { ...config, managerTips: true }, now, context, { generateTips });
  assert.deepEqual(nothing, { text: null, tips: "no_summary" });
  assert.equal(generated.length, 2, "sem itens, a IA não é chamada");
} finally {
  await prisma.$disconnect().catch(() => undefined);
}

console.log("dailySummaryData.test.ts: ok");
