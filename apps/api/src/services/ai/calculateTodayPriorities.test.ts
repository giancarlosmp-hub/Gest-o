import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateTodayPriorities, __todayPrioritiesTestUtils, type TodayPriorityInput } from "./calculateTodayPriorities.js";
import { COMMERCIAL_PRIORITY_THRESHOLDS, COMMERCIAL_PRIORITY_WEIGHTS } from "../commercialPriorityService.js";
import { WORKFLOW_INACTIVE_CLIENT_ORIGIN } from "../commercialAutomationsService.js";

const todayStart = new Date("2026-07-16T00:00:00.000Z");

const makeOpportunity = (overrides: Partial<TodayPriorityInput> = {}): TodayPriorityInput => ({
  id: overrides.id || "opp-1",
  title: overrides.title || "Oportunidade",
  stage: overrides.stage || "prospeccao",
  value: overrides.value ?? 1000,
  followUpDate: overrides.followUpDate ?? new Date("2026-07-20T00:00:00.000Z"),
  createdAt: overrides.createdAt || new Date("2026-07-10T00:00:00.000Z"),
  lastContactAt: overrides.lastContactAt ?? new Date("2026-07-15T00:00:00.000Z"),
  notes: overrides.notes,
  clientId: overrides.clientId || "client-1",
  ownerSellerId: overrides.ownerSellerId || "seller-1",
  client: overrides.client ?? {
    id: "client-1",
    name: "Cliente A",
    ownerSellerId: "seller-1",
    lastPurchaseDate: new Date("2026-07-01T00:00:00.000Z"),
    lastPurchaseValue: 1000,
    financialProfile: null,
    openTitlesTotal: 0,
    overdueTitlesTotal: 0
  },
  activities: overrides.activities ?? [],
  timelineEvents: overrides.timelineEvents ?? []
});

test("usa CommercialPriorityService para follow-up vencido, alto valor, inatividade, títulos, automação e contrato", () => {
  const [item] = calculateTodayPriorities([
    makeOpportunity({
      followUpDate: new Date("2026-07-15T00:00:00.000Z"),
      value: COMMERCIAL_PRIORITY_THRESHOLDS.highOpportunityValue,
      notes: `Criada por ${WORKFLOW_INACTIVE_CLIENT_ORIGIN} de cliente sem compra`,
      client: {
        id: "client-1",
        name: "Cliente A",
        ownerSellerId: "seller-1",
        lastPurchaseDate: new Date("2025-12-01T00:00:00.000Z"),
        lastPurchaseValue: 1000,
        financialProfile: null,
        openTitlesTotal: 0,
        overdueTitlesTotal: 1
      }
    })
  ], todayStart);

  assert.equal(item.priorityScore, 100);
  assert.equal(item.priorityLevel, "urgente");
  assert.equal(item.priorityColor, "red");
  assert.equal(item.risk, "alto");
  assert.equal(item.suggestedAction, "Ligar hoje");
  assert.ok(item.reason.includes("Follow-up vencido"));
  assert.ok(item.priorityReasons.includes("Follow-up vencido"));
  assert.ok(item.priorityReasons.includes(`Oportunidade acima de R$ ${COMMERCIAL_PRIORITY_THRESHOLDS.highOpportunityValue.toLocaleString("pt-BR")}`));
  assert.ok(item.priorityReasons.some((reason) => reason.includes("Cliente sem compra")));
  assert.ok(item.priorityReasons.includes("Cliente com título vencido"));
  assert.ok(item.priorityReasons.includes("Oportunidade criada automaticamente"));
  assert.ok(item.priorityScore >= 0 && item.priorityScore <= 100);
  assert.ok("priorityScore" in item && "risk" in item && "reason" in item && "suggestedAction" in item);
  assert.ok("priorityLevel" in item && "priorityColor" in item && "priorityReasons" in item);
});

test("atividade recente evita motivo incorreto de falta de contato", () => {
  const [item] = calculateTodayPriorities([
    makeOpportunity({
      lastContactAt: new Date("2026-06-01T00:00:00.000Z"),
      activities: [{ createdAt: new Date("2026-07-15T00:00:00.000Z"), date: new Date("2026-07-15T00:00:00.000Z"), notes: "Contato recente" }]
    })
  ], todayStart);

  assert.ok(!item.priorityReasons.some((reason) => reason.includes("Sem contato")));
});

test("ordenação determinística respeita score, follow-up antigo, valor e criação antiga", () => {
  const items = calculateTodayPriorities([
    makeOpportunity({ id: "created-old", value: 1000, followUpDate: new Date("2026-07-18T00:00:00.000Z"), createdAt: new Date("2026-07-01T00:00:00.000Z") }),
    makeOpportunity({ id: "high-score", value: COMMERCIAL_PRIORITY_THRESHOLDS.mediumOpportunityValue, followUpDate: new Date("2026-07-19T00:00:00.000Z") }),
    makeOpportunity({ id: "followup-old", value: 1000, followUpDate: new Date("2026-07-17T00:00:00.000Z") }),
    makeOpportunity({ id: "value-high", value: 2000, followUpDate: new Date("2026-07-18T00:00:00.000Z"), createdAt: new Date("2026-07-02T00:00:00.000Z") })
  ], todayStart);

  assert.deepEqual(items.map((item) => item.opportunityId), ["high-score", "followup-old", "value-high", "created-old"]);
});

test("mapeia risco legado sem mudar níveis oficiais", () => {
  assert.equal(__todayPrioritiesTestUtils.mapPriorityLevelToLegacyRisk("urgente"), "alto");
  assert.equal(__todayPrioritiesTestUtils.mapPriorityLevelToLegacyRisk("alta"), "alto");
  assert.equal(__todayPrioritiesTestUtils.mapPriorityLevelToLegacyRisk("normal"), "medio");
  assert.equal(__todayPrioritiesTestUtils.mapPriorityLevelToLegacyRisk("baixa"), "baixo");
});

test("calculateTodayPriorities não mantém fórmula paralela de score", () => {
  const source = readFileSync(new URL("./calculateTodayPriorities.ts", import.meta.url), "utf8");
  assert.equal(source.includes("priorityScore +="), false);
  assert.equal(source.includes("score +="), false);
  assert.equal(source.includes("followUpOverdueWeight"), false);
  assert.equal(source.includes("getOpportunityValueScore"), false);
  assert.ok(source.includes("calculateCommercialPriority"));
  assert.equal(COMMERCIAL_PRIORITY_WEIGHTS.overdueFollowUp, 30);
});


test("HomePage mantém Minha IA Comercial usando todayPriorities[0] sem recalcular score", () => {
  const source = readFileSync(new URL("../../../../web/src/pages/HomePage.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("const topTodayPriority = todayPriorities[0];"));
  assert.ok(source.includes("reason: topTodayPriority.reason"));
  assert.ok(source.includes("suggestedAction: topTodayPriority.suggestedAction"));
  assert.ok(!source.includes("priorityScore +="));
});

test("rota mantém filtro de carteira do vendedor e não altera gates existentes", () => {
  const source = readFileSync(new URL("../../routes/crudRoutes.ts", import.meta.url), "utf8");
  assert.ok(source.includes('router.get("/ai/today-priorities"'));
  assert.ok(source.includes("ownerSellerId: req.user.id"));
  assert.ok(source.includes("stage: { notIn: [...CLOSED_STAGE_VALUES] }"));
});
