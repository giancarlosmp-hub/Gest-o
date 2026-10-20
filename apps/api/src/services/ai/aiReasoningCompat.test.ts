import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../../config/env.js";
import { prisma } from "../../config/prisma.js";
import { generateClientSuggestion } from "../clientSuggestion.js";
import type { ClientAiContextPayload } from "../clientAiContext.js";
import { parseAiJsonObject, parseAiTextResponse } from "./aiResponseParser.js";
import { aiService, AiService } from "./aiService.js";
import { AiUsageLimiter } from "./aiUsageLimiter.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { OPENROUTER_REASONING, OpenAICompatibleProvider } from "./openAiCompatibleProvider.js";

// Provedor falso: fetch simulado, nenhuma chamada sai da máquina. Dados fictícios.
const originalFetch = globalThis.fetch;
const sentBodies: Record<string, any>[] = [];
let nextReply: Record<string, unknown> = {};
globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
  sentBodies.push(JSON.parse(String(init?.body)));
  return Response.json(nextReply);
}) as typeof fetch;

// Sem banco: a Base de Conhecimento responde vazia.
(prisma as any).knowledgeDocument.findMany = async () => [];

const openRouter = () => new OpenAICompatibleProvider({
  providerName: "openrouter",
  baseUrl: "https://provedor-ficticio.test/api/v1",
  apiKey: "chave-ficticia",
  model: "fornecedor/modelo-ficticio:free",
  timeoutMs: 1_000,
  defaultTemperature: 0.2,
  defaultMaxTokens: 512
});

const reply = (message: Record<string, unknown>, finishReason = "stop", usage?: Record<string, unknown>) => ({
  choices: [{ message: { role: "assistant", ...message }, finish_reason: finishReason }],
  usage: usage ?? { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180, completion_tokens_details: { reasoning_tokens: 30 } }
});

const SUGGESTION = { status: "acompanhamento", summary: "Resumo ficticio", recommendation: "Recomendacao ficticia", nextAction: "Ligar para o cliente ficticio", riskLevel: "medio" };

const clientContext: ClientAiContextPayload = {
  client: { id: "cliente-ficticio-1", name: "Cliente Ficticio", fantasyName: null, isArchived: false, archiveReason: null, city: "Cidade Ficticia", state: "GO", region: "Centro", potentialHa: null },
  commercialSummary: { openOpportunitiesCount: 0, totalCompletedActivities: 0, lastActivityAt: null, lastPurchaseDate: null, lastPurchaseValue: null },
  portfolio: { status: "prospect", cooling: false, approach: "primeiraVenda", lastPurchase: null },
  recentActivities: [],
  recentOpportunities: [],
  latestObservation: null
};

(aiService as any).provider = openRouter();
(aiService as any).usageLimiter = new AiUsageLimiter(async () => 1_000);
env.aiChatEnabled = true;

test("resposta cortada (finish_reason length) vai para o fallback com ai_truncated", async () => {
  nextReply = reply({ content: '{"status":"acompanhamento","summary":"Resumo cor' }, "length", { prompt_tokens: 100, completion_tokens: 512, total_tokens: 612, completion_tokens_details: { reasoning_tokens: 480 } });
  const suggestion = await generateClientSuggestion(clientContext, { userId: "usuario-ficticio" });
  assert.equal(suggestion.source, "deterministic");
  assert.equal(aiService.getStatus().lastError, "ai_truncated");
});

test("resposta cortada com objeto interno válido também vai para o fallback", async () => {
  nextReply = reply({ content: '{"summary":"x","changes":[{"description":"y","evidence":[]}],"risks":["corta' }, "length");
  const service = new AiService(openRouter, new AiUsageLimiter(async () => 1_000));
  const logged: any[] = [];
  const originalInfo = console.info;
  console.info = (payload: unknown) => { logged.push(payload); };
  try {
    assert.equal(await service.chat({ messages: [{ role: "user", content: "pedido ficticio" }] }), null);
  } finally {
    console.info = originalInfo;
  }
  assert.equal(service.getStatus().lastError, "ai_truncated");
  const success = logged.find((entry) => entry?.message === "[AI] chat-success");
  assert.equal(success.meta.finishReason, "length");
  assert.equal(success.meta.completionUsage, 80);
  assert.equal(success.meta.reasoningUsage, 30);
  assert.equal(success.meta.fallback, true);
  assert.equal(success.meta.error, "ai_truncated");
  assert(!JSON.stringify(logged).includes("corta"), "log sem conteúdo da resposta");
  assert(!JSON.stringify(logged).includes("pedido ficticio"), "log sem conteúdo do pedido");
});

test("resposta com <think> antes do JSON é aproveitada", async () => {
  nextReply = reply({ content: `<think>Raciocinio ficticio com {chaves} soltas.</think>\n${JSON.stringify(SUGGESTION)}` });
  const suggestion = await generateClientSuggestion(clientContext, { userId: "usuario-ficticio" });
  assert.equal(suggestion.source, "ai");
  assert.equal(suggestion.nextAction, SUGGESTION.nextAction);
});

test("JSON dentro de cerca ```json é aproveitado", async () => {
  nextReply = reply({ content: `Segue a resposta:\n\`\`\`json\n${JSON.stringify(SUGGESTION, null, 2)}\n\`\`\`\nFim.` });
  const suggestion = await generateClientSuggestion(clientContext, { userId: "usuario-ficticio" });
  assert.equal(suggestion.source, "ai");
  assert.equal(suggestion.summary, SUGGESTION.summary);
});

test("campo reasoning separado é ignorado e o JSON do content é aproveitado", async () => {
  nextReply = reply({
    content: JSON.stringify(SUGGESTION),
    reasoning: "Raciocinio ficticio que nao deve ser lido {\"status\":\"parado\"}",
    reasoning_details: [{ type: "reasoning.text", text: "detalhe ficticio" }]
  });
  const suggestion = await generateClientSuggestion(clientContext, { userId: "usuario-ficticio" });
  assert.equal(suggestion.source, "ai");
  assert.equal(suggestion.status, "acompanhamento");
});

test("payload ao openrouter leva reasoning e response_format; ao ollama, nenhum dos dois", async () => {
  nextReply = reply({ content: JSON.stringify(SUGGESTION) });
  sentBodies.length = 0;
  const result = await openRouter().chat({ messages: [{ role: "user", content: "pedido ficticio" }], maxTokens: 900, responseFormat: "json_object" });
  assert.deepEqual(sentBodies[0].reasoning, OPENROUTER_REASONING);
  assert.deepEqual(sentBodies[0].reasoning, { effort: "low", exclude: true });
  assert.deepEqual(sentBodies[0].response_format, { type: "json_object" });
  assert.equal(sentBodies[0].max_tokens, 900);
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage?.completionTokens, 80);
  assert.equal(result.usage?.reasoningTokens, 30);

  await openRouter().chat({ messages: [{ role: "user", content: "pedido ficticio" }] });
  assert.deepEqual(sentBodies[1].reasoning, OPENROUTER_REASONING);
  assert.equal("response_format" in sentBodies[1], false, "texto livre não pede modo JSON");

  const ollama = new OllamaProvider({ baseUrl: "http://ollama-ficticio.test:11434", model: "modelo-ficticio", timeoutMs: 1_000, defaultTemperature: 0.2, defaultMaxTokens: 512 });
  await ollama.chat({ messages: [{ role: "user", content: "pedido ficticio" }], responseFormat: "json_object" });
  assert.equal("reasoning" in sentBodies[2], false);
  assert.equal("response_format" in sentBodies[2], false);

  const otherProvider = new OpenAICompatibleProvider({ providerName: "outro-provedor", baseUrl: "https://outro.test/v1", apiKey: "chave-ficticia", model: "modelo-ficticio", timeoutMs: 1_000, defaultTemperature: 0.2, defaultMaxTokens: 512 });
  await otherProvider.chat({ messages: [{ role: "user", content: "pedido ficticio" }], responseFormat: "json_object" });
  assert.equal("reasoning" in sentBodies[3], false);
  assert.equal("response_format" in sentBodies[3], false);
});

test("leitor de resposta: <think>, cerca e primeiro objeto JSON válido", () => {
  assert.deepEqual(parseAiJsonObject('<think>pensando {"a":1}</think>{"b":2}'), { parsed: { b: 2 }, mode: "direct_json" });
  assert.deepEqual(parseAiJsonObject('raciocinio sem abertura</think>\n{"b":2}'), { parsed: { b: 2 }, mode: "direct_json" });
  assert.equal(parseAiJsonObject("<think>raciocinio cortado sem fim {\"b\":2}"), null);
  assert.deepEqual(parseAiJsonObject('```json\n{"b":2}\n```'), { parsed: { b: 2 }, mode: "fenced_json" });
  assert.deepEqual(parseAiJsonObject('Resposta {invalido} e depois {"b":"tem } dentro"} e {"c":3}'), { parsed: { b: "tem } dentro" }, mode: "embedded_json" });
  assert.equal(parseAiJsonObject('{"b":"cortado'), null);
  assert.equal(parseAiTextResponse('<think>pensando</think>{"message":"Bom dia ficticio"}')?.text, "Bom dia ficticio");
  assert.equal(parseAiTextResponse("<think>pensando</think>Bom dia ficticio")?.text, "Bom dia ficticio");
  assert.equal(parseAiTextResponse('```json\n{bad}\n```'), null);
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
