import test from "node:test";
import assert from "node:assert/strict";
import { CommercialPriorityService, calculateCommercialPriority, COMMERCIAL_PRIORITY_WEIGHTS } from "./commercialPriorityService.js";
import { WORKFLOW_INACTIVE_CLIENT_ORIGIN } from "./commercialAutomationsService.js";

test("calcula prioridade urgente com follow-up vencido, inatividade e oportunidade alta", () => {
  const result = calculateCommercialPriority({
    now: new Date("2026-07-09T12:00:00.000Z"),
    client: {
      lastPurchaseDate: new Date("2025-06-01T12:00:00.000Z"),
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
  assert.ok(result.reasons.includes("Inativo recente: sem comprar há mais de 12 meses (última compra em 01/06/2025)"));
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
      financialProfile: { DATA_ULTFATURA: "2025-09-15T12:00:00.000Z", overdueTitlesTotal: 2 },
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

  assert.equal(result.score, 45);
  assert.equal(result.level, "normal");
  assert.ok(result.reasons.includes("Esfriando: ativo sem comprar há mais de 9 meses (última compra em 15/09/2025)"));
  assert.ok(result.reasons.includes("Cliente com 2 títulos vencidos"));
  assert.ok(result.reasons.includes("Oportunidade criada automaticamente"));
  assert.ok(!result.reasons.some((reason) => reason.includes("Sem contato")), "timeline recente evita duplicar alerta de contato parado");
});

test("expõe pesos em constantes para ajuste simples", () => {
  assert.equal(COMMERCIAL_PRIORITY_WEIGHTS.overdueFollowUp, 30);
  assert.equal(COMMERCIAL_PRIORITY_WEIGHTS.highValueOpportunity, 20);
  assert.equal(COMMERCIAL_PRIORITY_WEIGHTS.workflowInactiveClient, 15);
  assert.equal(COMMERCIAL_PRIORITY_WEIGHTS.inactiveRecentClient, 30);
  assert.equal(COMMERCIAL_PRIORITY_WEIGHTS.coolingActiveClient, 20);
  assert.equal(COMMERCIAL_PRIORITY_WEIGHTS.exClient, 10);
});

// Regra oficial da carteira (dados fictícios). Agora: 09/07/2026 12h em Brasília.
const portfolioNow = new Date("2026-07-09T15:00:00.000Z");
const purchaseScore = (client: { lastPurchaseDate?: Date | null; lastSentCrmOrderDate?: Date | null; financialProfile?: Record<string, unknown> | null }) =>
  calculateCommercialPriority({ now: portfolioNow, client: { ownerSellerId: "seller-1", ...client } });

test("pontua a situação oficial da carteira: inativo recente 30, esfriando 20, ex-cliente 10, ativo e prospect 0", () => {
  const inactiveRecent = purchaseScore({ lastPurchaseDate: new Date("2025-03-10T15:00:00.000Z") });
  assert.equal(inactiveRecent.score, 30);
  assert.deepEqual(inactiveRecent.reasons, ["Inativo recente: sem comprar há mais de 12 meses (última compra em 10/03/2025)"]);
  assert.equal(inactiveRecent.nextAction, "Reativar cliente com oferta consultiva");

  const cooling = purchaseScore({ lastPurchaseDate: new Date("2025-09-20T15:00:00.000Z") });
  assert.equal(cooling.score, 20);
  assert.deepEqual(cooling.reasons, ["Esfriando: ativo sem comprar há mais de 9 meses (última compra em 20/09/2025)"]);

  const exClient = purchaseScore({ lastPurchaseDate: new Date("2023-05-02T15:00:00.000Z") });
  assert.equal(exClient.score, 10);
  assert.deepEqual(exClient.reasons, ["Ex-cliente: sem comprar há mais de 24 meses (última compra em 02/05/2023)"]);

  assert.deepEqual(purchaseScore({ lastPurchaseDate: new Date("2026-02-01T15:00:00.000Z") }).reasons, []);
  assert.deepEqual(purchaseScore({ lastPurchaseDate: null }).reasons, []);
  assert.equal(purchaseScore({ lastPurchaseDate: null }).score, 0);
});

test("bordas no dia de Brasília: exatamente 9 meses não esfria; exatamente 12 meses ainda é ativo e esfria", () => {
  assert.deepEqual(purchaseScore({ lastPurchaseDate: new Date("2025-10-09T15:00:00.000Z") }).reasons, []);
  assert.equal(purchaseScore({ lastPurchaseDate: new Date("2025-10-08T15:00:00.000Z") }).score, 20);
  assert.equal(purchaseScore({ lastPurchaseDate: new Date("2025-07-09T15:00:00.000Z") }).score, 20);
  const pastTwelve = purchaseScore({ lastPurchaseDate: new Date("2025-07-08T15:00:00.000Z") });
  assert.equal(pastTwelve.score, 30);
  assert.ok(pastTwelve.reasons[0].startsWith("Inativo recente"));
  // 10/10/2025 00:30 em UTC ainda é 09/10/2025 em Brasília: exatamente 9 meses, não esfria.
  assert.deepEqual(purchaseScore({ lastPurchaseDate: new Date("2025-10-10T00:30:00.000Z") }).reasons, []);
});

test("pedido sent do CRM mais recente que o ERP define a última compra; DATA_ULTFATURA é o fallback do ERP", () => {
  const byCrmOrder = purchaseScore({ lastPurchaseDate: new Date("2024-01-10T15:00:00.000Z"), lastSentCrmOrderDate: new Date("2025-09-01T15:00:00.000Z") });
  assert.equal(byCrmOrder.score, 20);
  assert.deepEqual(byCrmOrder.reasons, ["Esfriando: ativo sem comprar há mais de 9 meses (última compra em 01/09/2025)"]);

  assert.deepEqual(purchaseScore({ lastPurchaseDate: new Date("2023-01-10T15:00:00.000Z"), lastSentCrmOrderDate: new Date("2026-06-01T15:00:00.000Z") }).reasons, []);
  // Prospect no ERP, mas com pedido sent: não é mais prospect.
  assert.equal(purchaseScore({ lastPurchaseDate: null, lastSentCrmOrderDate: new Date("2025-05-01T15:00:00.000Z") }).score, 30);
  assert.equal(purchaseScore({ lastPurchaseDate: null, financialProfile: { DATA_ULTFATURA: "2025-04-01T15:00:00.000Z" } }).score, 30);
});

test("workflow de cliente sem compra só pontua quando o chamador informa que está ligado e elegível", () => {
  assert.ok(!purchaseScore({ lastPurchaseDate: null }).reasons.includes("Workflow de cliente sem compra ativo"));
  const withWorkflow = calculateCommercialPriority({ now: portfolioNow, client: { ownerSellerId: "seller-1", lastPurchaseDate: new Date("2025-03-10T15:00:00.000Z") }, workflow: { inactiveClient: true } });
  assert.ok(withWorkflow.reasons.includes("Workflow de cliente sem compra ativo"));
});
