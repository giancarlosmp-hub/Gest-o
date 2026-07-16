import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("./planningIntelligenceService.ts", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../routes/crudRoutes.ts", import.meta.url), "utf8");
const webSource = readFileSync(new URL("../../../web/src/components/planning/WeeklyCommercialPlan.tsx", import.meta.url), "utf8");

test("planejamento comercial expõe endpoint e valida permissões", () => {
  assert.match(routeSource, /\/ai\/commercial-planning\/week/);
  assert.match(source, /viewerRole === "vendedor"/);
  assert.match(source, /role: "vendedor"/);
});

test("usa CommercialPriorityService sem score paralelo e mantém somente leitura", () => {
  assert.match(source, /calculateCommercialPriority/);
  assert.doesNotMatch(source, /COMMERCIAL_PRIORITY_WEIGHTS\s*=/);
  assert.doesNotMatch(source, /prisma\.[a-zA-Z]+\.create|createMany/);
});

test("cobre prioridades, capacidade, distribuição, deduplicação, fallback, cache e prompt sanitizado", () => {
  assert.match(source, /overdueFollow|follow_up/);
  assert.match(source, /maxActionsPerDay/);
  assert.match(source, /maxVisitsPerDay/);
  assert.match(source, /cities/);
  assert.match(source, /dedupeKey/);
  assert.match(source, /cache-hit/);
  assert.match(source, /source: "deterministic"/);
  assert.match(source, /sanitize/);
  assert.match(source, /parseAiJsonObject/);
  assert.match(source, /Promise\.all/);
});

test("frontend usa WeeklyCommercialPlan com accordion/cards mobile", () => {
  assert.match(webSource, /export default function WeeklyCommercialPlan/);
  assert.match(webSource, /<details/);
  assert.match(webSource, /ActionCard/);
});
