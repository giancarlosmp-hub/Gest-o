import assert from "node:assert/strict";
import { env } from "../config/env.js";
import { AiService } from "../services/ai/aiService.js";
import { parseAiTextResponse } from "../services/ai/aiResponseParser.js";
import { getDemetraMasterPrompt } from "../services/ai/demetraMasterPrompt.js";
import { generateClientSuggestion } from "../services/clientSuggestion.js";
import { generateDeterministicSalesMessage, generateSalesMessage, type SalesMessageOpportunityInput } from "../services/opportunitySalesMessage.js";
import type { ClientAiContextPayload } from "../services/clientAiContext.js";

const originalFetch = globalThis.fetch;
const smokeProvider = "test-provider";
const smokeBaseUrl = "https://ai-provider.test/api/v1";
const smokeModel = "provider/model-a";

const okJson = {
  choices: [
    {
      message: {
        content: JSON.stringify({ status: "ativo", summary: "ok", recommendation: "ok", nextAction: "Agendar contato", riskLevel: "baixo" })
      }
    }
  ],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
};

const invalidJson = {
  choices: [{ message: { content: "não é json" } }]
};

const setFetch = (handler: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = handler as typeof fetch;
};

const baseEnv = () => {
  env.aiChatEnabled = true;
  env.aiProvider = smokeProvider;
  env.aiBaseUrl = smokeBaseUrl;
  env.aiApiKey = "test-key";
  env.aiModel = smokeModel;
  env.aiTimeoutMs = 50;
  env.aiMaxOutputTokens = 64;
  env.aiTemperature = 0.4;
};


const assertNoRawAiArtifacts = (value: string) => {
  assert.ok(!value.includes("```json"), "mensagem não deve exibir fence markdown json");
  assert.ok(!value.includes("```") , "mensagem não deve exibir fence markdown");
  assert.ok(!value.includes('{"message"'), "mensagem não deve exibir JSON bruto");
  assert.ok(!/stack trace/i.test(value), "mensagem não deve exibir stack trace");
};

const runAiResponseParserSmoke = () => {
  assert.equal(parseAiTextResponse("Bom dia.\nEstou entrando em contato...")?.text, "Bom dia.\nEstou entrando em contato...");
  assert.equal(parseAiTextResponse('{"message":"Bom dia..."}')?.text, "Bom dia...");
  assert.equal(parseAiTextResponse('```json\n{\n  "message":"Bom dia..."\n}\n```')?.text, "Bom dia...");
  assert.equal(parseAiTextResponse('```json\n{bad}\n```'), null);
  assert.equal(parseAiTextResponse('{"summary":"sem message"}'), null);
  console.info("[ai-smoke] parser de resposta da IA: ok");
};

const opportunityContext: SalesMessageOpportunityInput = {
  clientName: "João",
  title: "Proposta sorgo",
  crop: "sorgo",
  productOffered: "Semente premium",
  stage: "proposta",
  city: "Rio Verde",
  state: "GO",
  sellerName: "Vendedor Teste",
  value: 12000,
  probability: 70,
  notes: "Cliente avaliando volumes",
  followUpDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  lastContactAt: new Date(),
  createdAt: new Date(),
  timelineEvents: [{ description: "Cliente pediu proposta de sorgo", createdAt: new Date() }],
  activities: [{ createdAt: new Date(), notes: "Alinhar condições finais", product: "Semente premium" }]
};

const assertOpportunityMessagePayload = (payload: unknown) => {
  assert.equal(typeof payload, "object", "payload deve ser objeto");
  assert.equal(Object.keys(payload as Record<string, unknown>).length, 1, "payload deve manter apenas message");
  assert.equal(typeof (payload as { message?: unknown }).message, "string", "message deve ser string");
};

const clientContext: ClientAiContextPayload = {
  client: { id: "client-1", name: "Cliente Teste", fantasyName: null, city: "Cidade", state: "GO", region: "Centro", potentialHa: null },
  commercialSummary: {
    openOpportunitiesCount: 0,
    totalCompletedActivities: 0,
    lastActivityAt: null,
    lastPurchaseDate: null,
    lastPurchaseValue: null
  },
  recentActivities: [],
  recentOpportunities: [],
  latestObservation: null
};

const runChatScenario = async (name: string, setup: () => void, expectFallback: boolean) => {
  setup();
  const service = new AiService();
  const result = await service.chat({ messages: [{ role: "user", content: "prompt de teste" }] });
  assert.equal(result == null, expectFallback, `${name}: fallback esperado=${expectFallback}`);
  console.info(`[ai-smoke] ${name}: ok`);
};

const assertUsesMasterPrompt = (init?: RequestInit) => {
  const payload = JSON.parse(String(init?.body));
  const systemMessage = payload.messages?.find((message: { role?: string }) => message.role === "system");
  assert.equal(systemMessage?.content, getDemetraMasterPrompt());
  assert.equal(payload.messages.filter((message: { role?: string }) => message.role === "system").length, 1);
  return payload;
};

try {
  runAiResponseParserSmoke();

  await runChatScenario("IA desabilitada", () => {
    baseEnv();
    env.aiChatEnabled = false;
    setFetch(async () => Response.json(okJson));
  }, true);

  await runChatScenario("IA habilitada", () => {
    baseEnv();
    setFetch(async () => Response.json(okJson));
  }, false);

  await runChatScenario("Provider OpenAI-compatible respondendo", () => {
    baseEnv();
    setFetch(async (input, init) => {
      assert.equal(String(input), `${smokeBaseUrl}/chat/completions`);
      const payload = assertUsesMasterPrompt(init);
      assert.equal(payload.model, smokeModel);
      return Response.json(okJson);
    });
  }, false);

  await runChatScenario("Prompt Mestre padrão em futuras integrações", () => {
    baseEnv();
    setFetch(async (_input, init) => {
      assertUsesMasterPrompt(init);
      return Response.json(okJson);
    });
  }, false);

  baseEnv();
  setFetch(async (_input, init) => {
    assertUsesMasterPrompt(init);
    return Response.json(okJson);
  });
  assert.equal((await generateClientSuggestion(clientContext)).source, "ai");
  console.info("[ai-smoke] clientSuggestion utiliza Prompt Mestre: ok");

  await runChatScenario("Timeout", () => {
    baseEnv();
    setFetch(async () => {
      throw new DOMException("timeout", "TimeoutError");
    });
  }, true);

  await runChatScenario("Provider indisponível", () => {
    baseEnv();
    env.aiApiKey = "";
    setFetch(async () => Response.json(okJson));
  }, true);

  baseEnv();
  setFetch(async () => Response.json({ choices: [] }));
  assert.equal((await generateClientSuggestion(clientContext)).source, "deterministic");
  console.info("[ai-smoke] Resposta inválida: ok");

  baseEnv();
  setFetch(async () => Response.json(invalidJson));
  assert.equal((await generateClientSuggestion(clientContext)).source, "deterministic");
  console.info("[ai-smoke] JSON inválido: ok");



  baseEnv();
  setFetch(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ message: "Olá João. Separei sua proposta de sorgo para alinharmos os próximos passos com objetividade." }) } }] }));
  const aiMessage = await generateSalesMessage(opportunityContext);
  assert.match(aiMessage, /Separei sua proposta/);
  assertNoRawAiArtifacts(aiMessage);
  assertOpportunityMessagePayload({ message: aiMessage });
  console.info("[ai-smoke] GET /ai/opportunity-message com IA habilitada: ok");

  baseEnv();
  setFetch(async () => Response.json({ choices: [{ message: { content: "{" } }] }));
  const invalidSalesMessage = await generateSalesMessage(opportunityContext);
  assert.equal(invalidSalesMessage, "Não foi possível gerar a mensagem comercial.");
  assertNoRawAiArtifacts(invalidSalesMessage);
  console.info("[ai-smoke] JSON inválido na mensagem comercial usa mensagem controlada: ok");

  const deterministicSalesMessage = generateDeterministicSalesMessage(opportunityContext);
  assert.ok(!deterministicSalesMessage.startsWith(`${opportunityContext.sellerName},`), "mensagem comercial não deve iniciar com nome do vendedor");
  assert.ok(!deterministicSalesMessage.startsWith(`${opportunityContext.sellerName}!`), "mensagem comercial não deve iniciar com nome do vendedor");
  assert.match(deterministicSalesMessage, /^(Bom dia!|Boa tarde!|Olá!)/);
  assertNoRawAiArtifacts(deterministicSalesMessage);
  console.info("[ai-smoke] mensagem comercial não inicia com vendedor: ok");

  await runChatScenario("Fallback determinístico", () => {
    baseEnv();
    setFetch(async () => Response.json({ error: { message: "redacted" } }, { status: 429 }));
  }, true);

  baseEnv();
  const status = new AiService().getStatus();
  assert.deepEqual(
    {
      enabled: status.enabled,
      provider: status.provider,
      configured: status.configured,
      model: status.model,
      fallback: status.fallback
    },
    {
      enabled: true,
      provider: smokeProvider,
      configured: true,
      model: smokeModel,
      fallback: false
    }
  );
  console.info("[ai-smoke] GET /ai/status: ok");
} finally {
  globalThis.fetch = originalFetch;
}
