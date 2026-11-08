import assert from "node:assert/strict";
import { prisma } from "../../config/prisma.js";
import { createWhatsAppConversationsTestDb } from "../whatsappMessages/whatsappConversationsTestDb.js";
import { INACTIVE_RECENT_AUTOMATION_ORIGIN } from "../commercialAutomationsService.js";
import { brazilDayKeyOf, loadDailySummaryData } from "./dailySummaryData.js";

// WhatsApp Fase D: o que entra no resumo de um vendedor. Prisma em memória, só dados fictícios.
const { tables } = createWhatsAppConversationsTestDb(prisma);

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
} finally {
  await prisma.$disconnect().catch(() => undefined);
}

console.log("dailySummaryData.test.ts: ok");
