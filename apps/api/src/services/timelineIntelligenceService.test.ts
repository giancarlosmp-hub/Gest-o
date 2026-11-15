import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(new URL("./timelineIntelligenceService.ts", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../routes/crudRoutes.ts", import.meta.url), "utf8");
const clientPage = readFileSync(new URL("../../../web/src/pages/ClientDetailsPage.tsx", import.meta.url), "utf8");
const opportunityPage = readFileSync(new URL("../../../web/src/pages/OpportunityDetailsPage.tsx", import.meta.url), "utf8");
const cardSource = readFileSync(new URL("../../../web/src/components/TimelineIntelligenceCard.tsx", import.meta.url), "utf8");

test("endpoints aplicam sellerWhere para vendedor e preservam escopo gerente/diretor", () => {
  assert.match(routeSource, /\/ai\/timeline-intelligence\/client\/:clientId/);
  assert.match(routeSource, /\/ai\/timeline-intelligence\/opportunity\/:opportunityId/);
  assert.match(routeSource, /scope: sellerWhere\(req\)/);
});

test("serviço usa CommercialPriorityService sem score paralelo", () => {
  assert.match(serviceSource, /import \{ calculateCommercialPriority/);
  assert.match(serviceSource, /calculateCommercialPriority\(/);
  assert.doesNotMatch(serviceSource, /let score\s*=|const score\s*=/);
});

test("limita dados, ordena cronologicamente e evita N+1", () => {
  assert.match(serviceSource, /const MAX_EVENTS = 30/);
  assert.match(serviceSource, /const MAX_ACTIVITIES = 20/);
  assert.match(serviceSource, /eventsDesc\.reverse\(\)/);
  assert.match(serviceSource, /Promise\.all\(\[/);
});

test("identifica follow-up vencido, ausência de contato e progressão", () => {
  assert.match(serviceSource, /overdueFollowUp/);
  assert.match(serviceSource, /Sem contato há/);
  assert.match(serviceSource, /progressed/);
});

test("fallback, IA inválida e parser centralizado não expõem JSON bruto", () => {
  assert.match(serviceSource, /buildDeterministicResult/);
  assert.match(serviceSource, /parseAiJsonObject/);
  assert.match(serviceSource, /return null/);
  assert.doesNotMatch(serviceSource, /```/);
});

test("cache invalida por último evento e refresh força nova análise", () => {
  assert.match(serviceSource, /TTL_MS = 30 \* 60 \* 1000/);
  assert.match(serviceSource, /lastRelevantEventAt/);
  assert.match(routeSource, /refresh: req\.query\.refresh === "true"/);
});

test("DTO da IA sanitiza dados sensíveis", () => {
  assert.match(serviceSource, /sanitizeText/);
  assert.doesNotMatch(serviceSource, /select: \{[^}]*(cnpj|phone|email|authorization|password)/i);
});

test("frontend é responsivo e mantém timeline cronológica", () => {
  assert.match(cardSource, /md:grid-cols-3/);
  assert.match(cardSource, /Ver detalhes/);
  assert.match(clientPage, /<TimelineIntelligenceCard clientId=\{id\}/);
  assert.match(clientPage, /<TimelineEventList/);
  assert.match(opportunityPage, /<TimelineIntelligenceCard opportunityId=\{id\}/);
  assert.match(opportunityPage, /events\.map/);
});

test("UltraFV3 não foi tocado pelo serviço de timeline", () => {
  assert.doesNotMatch(serviceSource, /UltraFV3|ultraFv3/i);
});

test("mensagem enviada pelo WhatsApp conta como contato no resumo e renova o cache", async () => {
  const { TimelineIntelligenceService } = await import("./timelineIntelligenceService.js");
  const service = new TimelineIntelligenceService();
  // Contexto fictício do cliente, sem atividades nem eventos (sem banco).
  const base = {
    entityType: "client" as const,
    client: { id: "client-ficticio", lastPurchaseDate: null, lastPurchaseValue: null, ownerSellerId: "seller-ficticio", financialProfile: null, openTitlesTotal: null, overdueTitlesTotal: null, lastSentCrmOrderDate: null },
    portfolio: { status: "prospect", cooling: false, approach: "primeiraVenda", lastPurchase: null },
    opportunity: null,
    events: [],
    activities: [],
    changeLogs: [],
    latestErpOrder: null
  };
  const input = { clientId: "client-ficticio", viewerUserId: "seller-ficticio", viewerRole: "vendedor" };

  const without = { ...base, lastWhatsAppSentAt: null } as any;
  const withoutSignals = service.analyzeDeterministically(without);
  assert.equal(withoutSignals.lastContactAt, null);
  assert.match(service.buildDeterministicResult(without, withoutSignals).summary, /sem contato registrado/);

  const sentAt = new Date(Date.now() - 2 * 86_400_000 - 60_000);
  const withWhatsApp = { ...base, lastWhatsAppSentAt: sentAt } as any;
  const signals = service.analyzeDeterministically(withWhatsApp);
  assert.equal(signals.lastContactAt?.getTime(), sentAt.getTime());
  const summary = service.buildDeterministicResult(withWhatsApp, signals).summary;
  assert.doesNotMatch(summary, /sem contato registrado/);
  assert.match(summary, /último contato há [23] dias/);

  // "hoje"/"ontem" pelo calendário de Brasília (agora fixo: 10h de 15/11 em Brasília).
  const fixedNow = new Date("2026-11-15T13:00:00.000Z");
  const summaryAt = (lastContactAt: Date | null, opportunityCreatedAt?: Date) => {
    const context = { ...without, opportunity: opportunityCreatedAt ? { stage: "proposta", followUpDate: new Date("2026-11-30T12:00:00.000Z"), createdAt: opportunityCreatedAt, closedAt: null } : null } as any;
    const fixedSignals = { ...service.analyzeDeterministically(context), now: fixedNow, lastContactAt, noRecentContactDays: lastContactAt ? 0 : null };
    return service.buildDeterministicResult(context, fixedSignals).summary;
  };
  assert.match(summaryAt(new Date("2026-11-15T11:00:00.000Z")), /, último contato hoje\./);
  assert.match(summaryAt(new Date("2026-11-14T21:00:00.000Z")), /, último contato ontem\./, "18h de ontem, menos de 24 h");
  assert.match(summaryAt(new Date("2026-11-13T23:00:00.000Z")), /, último contato há 2 dias\./);
  assert.match(summaryAt(null, new Date("2026-11-15T03:00:00.000Z")), /^Oportunidade aberta hoje, /);
  assert.match(summaryAt(null, new Date("2026-11-15T02:59:00.000Z")), /^Oportunidade aberta ontem, /);
  assert.match(summaryAt(null, new Date("2026-11-10T12:00:00.000Z")), /^Oportunidade aberta há 5 dias, /);
  for (const text of [summaryAt(new Date("2026-11-15T11:00:00.000Z"), new Date("2026-11-15T12:00:00.000Z")), summaryAt(new Date("2026-11-14T12:00:00.000Z"))]) {
    assert.doesNotMatch(text, /há [01] dias?/);
  }
  // Conversa nova muda a chave do cache: o resumo antigo ("sem contato") não volta.
  assert.notEqual(
    service.buildCacheKey(withWhatsApp, input, signals.lastRelevantEventAt),
    service.buildCacheKey(without, input, withoutSignals.lastRelevantEventAt)
  );
});
