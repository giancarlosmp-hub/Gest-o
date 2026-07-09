import test from "node:test";
import assert from "node:assert/strict";
import { CommercialPriorityService, calculateCommercialPriority, COMMERCIAL_PRIORITY_WEIGHTS } from "./commercialPriorityService.js";
import { WORKFLOW_INACTIVE_CLIENT_ORIGIN } from "./commercialAutomationsService.js";

test("calcula prioridade urgente com follow-up vencido, inatividade e oportunidade alta", () => {
  const result = calculateCommercialPriority({
    now: new Date("2026-07-09T12:00:00.000Z"),
    client: {
      lastPurchaseDate: new Date("2026-03-19T12:00:00.000Z"),
      ownerSellerId: "seller-1",
      overdueTitles: []
    },
    opportunity: {
      stage: "negociacao",
      value: 50000,
      followUpDate: new Date("2026-07-08T12:00:00.000Z"),
      lastContactAt: new Date("2026-07-01T12:00:00.000Z")
    },
    activities: [{ dueDate: new Date("2026-07-07T12:00:00.000Z"), status: "pending" }]
  });

  assert.equal(result.score, 100);
  assert.equal(result.level, "urgente");
  assert.equal(result.color, "red");
  assert.ok(result.reasons.includes("Follow-up vencido"));
  assert.ok(result.reasons.includes("Cliente sem compra há 112 dias"));
  assert.ok(result.reasons.includes("Oportunidade acima de R$ 45.000"));
  assert.equal(result.nextAction, "Ligar hoje");
});

test("mantém prioridade baixa quando não há sinais comerciais relevantes", () => {
  const result = calculateCommercialPriority({
    now: new Date("2026-07-09T12:00:00.000Z"),
    client: { lastPurchaseDate: new Date("2026-07-01T12:00:00.000Z"), ownerSellerId: "seller-1" },
    opportunity: { stage: "prospeccao", value: 1000, followUpDate: new Date("2026-07-10T12:00:00.000Z"), lastContactAt: new Date("2026-07-08T12:00:00.000Z") },
    activities: []
  });

  assert.deepEqual(result, {
    score: 0,
    level: "baixa",
    color: "green",
    reasons: [],
    nextAction: "Manter acompanhamento planejado"
  });
});

test("usa sinais existentes de financialProfile, timeline e origem da automação comercial", () => {
  const result = new CommercialPriorityService().calculate({
    now: new Date("2026-07-09T12:00:00.000Z"),
    client: {
      financialProfile: { DATA_ULTFATURA: "2026-01-01", overdueTitlesTotal: 2 },
      ownerSellerId: "seller-1"
    },
    opportunity: {
      stage: "prospeccao",
      value: 0,
      createdAt: new Date("2026-06-01T12:00:00.000Z"),
      notes: `${WORKFLOW_INACTIVE_CLIENT_ORIGIN}\nCliente sem compra.`
    },
    timelineEvents: [{ createdAt: new Date("2026-07-08T12:00:00.000Z"), description: "Contato recente" }],
    activities: [{ dueDate: new Date("2026-07-07T12:00:00.000Z"), done: true }]
  });

  assert.equal(result.score, 55);
  assert.equal(result.level, "alta");
  assert.ok(result.reasons.includes("Cliente sem compra há 189 dias"));
  assert.ok(result.reasons.includes("Cliente com 2 títulos vencidos"));
  assert.ok(result.reasons.includes("Oportunidade criada automaticamente"));
  assert.ok(!result.reasons.some((reason) => reason.includes("Sem contato")), "timeline recente evita duplicar alerta de contato parado");
});

test("expõe pesos em constantes para ajuste simples", () => {
  assert.equal(COMMERCIAL_PRIORITY_WEIGHTS.overdueFollowUp, 30);
  assert.equal(COMMERCIAL_PRIORITY_WEIGHTS.highValueOpportunity, 20);
  assert.equal(COMMERCIAL_PRIORITY_WEIGHTS.workflowInactiveClient, 15);
});
