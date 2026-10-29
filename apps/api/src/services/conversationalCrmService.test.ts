import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("./conversationalCrmService.ts", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../routes/conversationalCrmRoutes.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
const webSource = readFileSync(new URL("../../../web/src/pages/CrmAssistantPage.tsx", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("../../../web/src/layouts/AppLayout.tsx", import.meta.url), "utf8");

test("CRM conversacional expõe endpoint autenticado e página dedicada", () => {
  assert.match(routeSource, /router\.use\(authMiddleware\)/);
  assert.match(routeSource, /router\.post\("\/crm-assistant\/query"/);
  assert.match(appSource, /app\.use\("\/ai", conversationalCrmRoutes\)/);
  assert.doesNotMatch(webSource, /CRM Assistant|catálogo seguro/);
  assert.match(webSource, /Assistente Comercial/);
  assert.match(layoutSource, /Assistente Comercial/);
});

test("catálogo fechado, schema validation, limites e recusa maliciosa", () => {
  assert.match(source, /CRM_QUERY_CAPABILITIES/);
  assert.match(source, /z\.enum\(CRM_QUERY_CAPABILITIES\)/);
  assert.match(source, /MAX_LIMIT = 50/);
  assert.match(source, /\.strict\(\)/);
  assert.match(source, /isMalicious/);
  assert.doesNotMatch(source, /\$queryRawUnsafe|\$executeRawUnsafe/);
  assert.doesNotMatch(source, /SELECT .* FROM|INSERT |UPDATE |DELETE /);
});

test("permissões, cache por usuário e serviços reutilizados", () => {
  assert.match(source, /viewer\.role === "vendedor"/);
  assert.match(source, /Vendedor não pode consultar outro vendedor/);
  assert.match(source, /viewer\.id, viewer\.role, plan\.capability/);
  assert.match(source, /calculateCommercialPriority/);
  assert.match(source, /getCommercialInsights/);
  assert.match(source, /planningIntelligenceService/);
  assert.match(source, /agendaIntelligenceService/);
  assert.match(source, /calculateTodayPriorities/);
});

test("privacidade, observabilidade, fallback e resposta estruturada", () => {
  assert.match(source, /\[crm-assistant\] query-started/);
  assert.match(source, /\[crm-assistant\] query-planned/);
  assert.match(source, /\[crm-assistant\] query-completed/);
  assert.match(source, /\[crm-assistant\] fallback/);
  assert.match(source, /safe\(/);
  assert.match(source, /filtersApplied/);
  assert.match(source, /source: "deterministic"/);
  assert.match(source, /Não posso exibir credenciais/);
});

test("frontend mobile usa cards e histórico curto, sem tabela", () => {
  assert.match(webSource, /slice\(0, 5\)/);
  assert.match(webSource, /rounded-2xl border border-slate-100 bg-slate-50/);
  // Barra de pergunta fixa acima da barra de ações rápidas do celular (antes ficava por baixo dela).
  assert.match(webSource, /fixed inset-x-0 bottom-\[calc\(var\(--mobile-action-bar-height\)\+env\(safe-area-inset-bottom\)\)\]/);
  assert.doesNotMatch(webSource, /<table|overflow-x/);
});
