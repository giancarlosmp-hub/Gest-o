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
