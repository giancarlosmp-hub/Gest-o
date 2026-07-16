import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { __commercialInsightsInternals } from "./commercialInsightsService.js";

const serviceSource = readFileSync(new URL("./commercialInsightsService.ts", import.meta.url), "utf8");
const homeSource = readFileSync(new URL("../../../web/src/pages/HomePage.tsx", import.meta.url), "utf8");
const routesSource = readFileSync(new URL("../routes/crudRoutes.ts", import.meta.url), "utf8");

test("CommercialInsightsService usa calculateCommercialPriority como fonte oficial sem fórmula paralela", () => {
  assert.match(serviceSource, /import \{ calculateCommercialPriority/);
  assert.match(serviceSource, /calculateCommercialPriority\(input\)/);
  assert.doesNotMatch(serviceSource, /score \+=|priorityScore \+=|follow-up.*[+][0-9]/i);
});

test("ranking executivo é ordenado pelo score oficial e inclui motivo e próxima ação", () => {
  assert.match(serviceSource, /sort\(\(a, b\) => b\.score - a\.score\)/);
  const fallback = __commercialInsightsInternals.deterministicSummary([
    { entityType: "client", entityId: "c1", title: "Cliente A", score: 20, level: "baixa", reason: "Cliente sem compra há 100 dias", recommendedAction: "Reativar em até 24h" },
    { entityType: "opportunity", entityId: "o1", title: "Cliente B · Venda", score: 87, level: "urgente", reason: "Follow-up vencido", recommendedAction: "Ligar hoje" }
  ], { clients: { total: 2 }, opportunities: { open: 1 } });
  assert.equal(fallback.highPriority[0].score, 87);
  assert.match(fallback.highPriority[0].detail, /Follow-up vencido.*Ligar hoje/);
});

test("IA inválida retorna null para acionar fallback sem JSON bruto", () => {
  const parsed = __commercialInsightsInternals.parseAiPayload("{ invalid json", []);
  assert.equal(parsed, null);
});

test("cache concorrente, refresh e logs seguros estão documentados no serviço", () => {
  assert.match(serviceSource, /CACHE_TTL_MS = 6 \* 60 \* 60 \* 1000/);
  assert.match(serviceSource, /if \(!inFlight\) inFlight = buildFreshInsights/);
  assert.match(serviceSource, /if \(options\.refresh\) inFlight = null/);
  assert.match(serviceSource, /cacheHit.*aiUsed.*fallbackUsed.*knowledgeContextUsed/s);
  assert.doesNotMatch(serviceSource, /phone|email|cnpj/i);
});

test("permissões do endpoint executivo bloqueiam vendedor e mantêm diretor/gerente", () => {
  assert.match(routesSource, /router\.get\("\/ai\/commercial-insights", authorize\("diretor", "gerente"\)/);
});

test("Minha IA Comercial continua usando todayPriorities[0] e sem novo card mobile estrutural", () => {
  assert.match(homeSource, /const topTodayPriority = todayPriorities\[0\]/);
  assert.match(homeSource, /Comece por esta ação/);
  assert.doesNotMatch(homeSource, /<MobileActionBar[^>]*\/>[\s\S]*<MobileActionBar/);
  assert.doesNotMatch(homeSource, /api\.post<.*commercial-insights|generateCommercial/i);
});
