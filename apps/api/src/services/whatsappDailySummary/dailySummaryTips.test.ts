import assert from "node:assert/strict";
import { env } from "../../config/env.js";
import type { AiChatRequest } from "../ai/aiProvider.js";
import { AiService } from "../ai/aiService.js";
import { AiUsageLimiter } from "../ai/aiUsageLimiter.js";
import { groqTextConfig } from "../ai/groqTextConfig.js";
import { OpenAICompatibleProvider } from "../ai/openAiCompatibleProvider.js";
import type { DailySummaryData, DailySummaryItem, DailySummaryTipFacts } from "./dailySummaryFormat.js";
import {
  buildDailySummaryTipsInput,
  createDailySummaryTipsRound,
  DAILY_SUMMARY_TIPS_SYSTEM_PROMPT,
  DAILY_SUMMARY_TIPS_USAGE_BUCKET,
  dailySummaryTipsAi,
  dailySummaryTipsUserMessage,
  generateDailySummaryTips,
  MAX_TIP_CODES,
  validateDailySummaryTips
} from "./dailySummaryTips.js";

// Resumo diário: dados anonimizados e conferência das dicas do gerente comercial. Só dados fictícios.

// 10/11/2026 (terça), 07:30 em Brasília = 10:30 UTC.
const now = new Date("2026-11-10T10:30:00.000Z");
const day = (dayKey: string) => new Date(`${dayKey}T00:00:00.000Z`);
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

let sequence = 0;
const item = (name: string, extra: Partial<DailySummaryItem> = {}, facts: Partial<DailySummaryTipFacts> = {}): DailySummaryItem => ({
  clientName: name,
  city: "Cidade Ficticia Secreta",
  state: "pr",
  stage: "proposta",
  followUpDate: day("2026-11-07"),
  isNew: false,
  tipFacts: {
    opportunityId: `opp-${++sequence}`,
    value: 48_000.4,
    lastContactAt: daysAgo(9),
    stageSince: daysAgo(12),
    crop: "Aveia",
    products: ["Aveia Preta Ficticia", "Aveia Preta Ficticia", ""],
    lastPurchaseDate: day("2026-03-15"),
    ...facts
  },
  ...extra
});

const overdue = item("Agropecuaria Ficticia Alfa Ltda");
const reactivation = item("Produtor Ficticio Beta", { stage: "prospeccao", state: "SC", followUpDate: day("2026-11-12") }, { value: 0, lastContactAt: null, crop: null, products: [] });
const data: DailySummaryData = {
  sellerName: "Vendedor Ficticio",
  dayKey: "2026-11-10",
  sections: {
    reactivations: { total: 1, newCount: 0, items: [reactivation] },
    overdueFollowUps: { total: 1, newCount: 0, items: [overdue] },
    // A mesma oportunidade em duas seções recebe um código só.
    todayFollowUps: { total: 2, newCount: 0, items: [{ ...overdue }, item("Revenda Ficticia Gama", { stage: "negociacao", followUpDate: day("2026-11-10"), state: "Mato Grosso do Sul" }, { crop: "milho", products: [] })] }
  }
};

// 1) Anonimização: códigos na ordem do resumo, só os campos permitidos, sem nome, cidade, região nem ids.
const input = buildDailySummaryTipsInput(data, now)!;
assert.deepEqual([...input.names.entries()], [
  ["C1", "Produtor Ficticio Beta"],
  ["C2", "Agropecuaria Ficticia Alfa Ltda"],
  ["C3", "Revenda Ficticia Gama"]
]);
assert.deepEqual(input.payload, {
  hoje: "2026-11-10",
  mes: "novembro",
  ufs: ["PR", "SC"],
  oportunidades: [
    { codigo: "C1", secao: "reativacao", etapa: "prospeccao", diasNaEtapa: 12, ultimaCompra: "2026-03-15", uf: "SC" },
    {
      codigo: "C2",
      secao: "follow_up_vencido",
      etapa: "proposta",
      valor: 48_000,
      diasFollowUpVencido: 3,
      diasSemContato: 9,
      diasNaEtapa: 12,
      cultura: "Aveia",
      produtos: ["Aveia Preta Ficticia"],
      uf: "PR"
    },
    { codigo: "C3", secao: "follow_up_hoje", etapa: "negociacao", valor: 48_000, diasSemContato: 9, diasNaEtapa: 12, cultura: "milho" }
  ]
}, "última compra só na reativação; UF inválida fica de fora");
const message = dailySummaryTipsUserMessage(input);
assert.doesNotMatch(message, /Ficticia Alfa|Ficticio Beta|Ficticia Gama|Cidade Ficticia|Secreta|opp-\d|Vendedor/);
assert.doesNotMatch(DAILY_SUMMARY_TIPS_SYSTEM_PROMPT, /Ficticio|Ficticia/);
assert.match(DAILY_SUMMARY_TIPS_SYSTEM_PROMPT, /Claude, gerente comercial/);
assert.deepEqual([...input.cultures].sort(), ["aveia", "milho"]);

// Sem dados das dicas (ou sem itens): nada a pedir.
assert.equal(buildDailySummaryTipsInput({ ...data, sections: { reactivations: { total: 1, newCount: 0, items: [{ ...reactivation, tipFacts: undefined }] } } }, now), null);
assert.equal(buildDailySummaryTipsInput({ ...data, sections: {} }, now), null);

// Compra com horário: dia de Brasília (01:00 UTC do dia 16 ainda é dia 15 em Brasília).
const timed = buildDailySummaryTipsInput({ ...data, sections: { reactivations: { total: 1, newCount: 0, items: [item("Cliente Ficticio", {}, { lastPurchaseDate: new Date("2026-03-16T01:00:00.000Z") })] } } }, now)!;
assert.equal(timed.payload.oportunidades[0].ultimaCompra, "2026-03-15");

// No máximo 12 códigos.
const crowded = buildDailySummaryTipsInput(
  { ...data, sections: { overdueFollowUps: { total: 10, newCount: 0, items: Array.from({ length: 10 }, (_, index) => item(`Cliente Ficticio ${index}`)) }, todayFollowUps: { total: 10, newCount: 0, items: Array.from({ length: 10 }, (_, index) => item(`Cliente Ficticio Hoje ${index}`)) } } },
  now
)!;
assert.equal(crowded.payload.oportunidades.length, MAX_TIP_CODES);
assert.equal(crowded.names.size, MAX_TIP_CODES);

// 2) Resposta válida: códigos trocados pelos nomes (também em cerca de markdown e com o código em minúscula).
const answer = (tips: unknown) => JSON.stringify({ dicas: tips });
const valid = validateDailySummaryTips(
  "```json\n" + answer(["Comece por C2: proposta parada há 12 dias. Ligue e retome a necessidade de aveia.", "c3 está em negociação e o follow-up é hoje: confirme o volume de milho.", "Com C1, faça contato de relacionamento antes de oferecer."]) + "\n```",
  input
);
assert.deepEqual(valid, {
  ok: true,
  tips: [
    "Comece por Agropecuaria Ficticia Alfa Ltda: proposta parada há 12 dias. Ligue e retome a necessidade de aveia.",
    "Revenda Ficticia Gama está em negociação e o follow-up é hoje: confirme o volume de milho.",
    "Com Produtor Ficticio Beta, faça contato de relacionamento antes de oferecer."
  ]
});
assert.deepEqual(validateDailySummaryTips(answer(["Uma dica\ncom quebra de linha, sem código."]), input), { ok: true, tips: ["Uma dica com quebra de linha, sem código."] });

// 3) Qualquer falha descarta tudo.
const reason = (content: string) => {
  const result = validateDailySummaryTips(content, input);
  return result.ok ? "ok" : result.reason;
};
assert.equal(reason("texto livre sem JSON"), "invalid_format");
assert.equal(reason(JSON.stringify(["lista solta"])), "invalid_format");
assert.equal(reason(JSON.stringify({ dicas: "uma só" })), "invalid_format");
assert.equal(reason(JSON.stringify({ dicas: ["ok"], extra: true })), "invalid_format");
assert.equal(reason(answer(["ok", 3])), "invalid_format");
assert.equal(reason(answer([])), "empty");
assert.equal(reason(answer(["ok", "  "])), "empty");
assert.equal(reason(answer(["a", "b", "c", "d"])), "too_many");
assert.equal(reason(answer(["x".repeat(251)])), "too_long");
assert.equal(reason(answer(["x".repeat(250)])), "ok");
assert.equal(reason(answer(["Ligue para C4 hoje."])), "unknown_code", "código que não existe");
assert.equal(reason(answer(["Ligue para C02 hoje."])), "unknown_code");
assert.equal(reason(answer(["Boa dica para C1.", "Ligue para C13."])), "unknown_code", "uma dica ruim descarta todas");
for (const forbidden of ["Ofereça 5% a C2.", "Feche C2 por R$ 40 mil.", "Mostre o preço de tabela.", "Dê um desconto a C2.", "Aproveite a promoção.", "Proponha parcelamento.", "Negocie o prazo com C2.", "Ofereça condição de pagamento especial.", "Ofereça brinde.", "Fale em 40 mil reais."]) {
  assert.equal(reason(answer([forbidden])), "forbidden_term", forbidden);
}
assert.equal(reason(answer(["Lembre C3 do plantio de soja."])), "culture_not_in_data", "soja não está nos dados");
assert.equal(reason(answer(["Ofereça sorgo a C1."])), "culture_not_in_data");
assert.equal(reason(answer(["Confirme as aveias de C2 e o milho de C3."])), "ok", "plural e culturas dos dados");
assert.equal(reason(""), "invalid_format");

// 4) Chamada da IA (IA falsa): prompt próprio, balde do resumo, JSON; disjuntor por rodada; log sem conteúdo.
{
  const requests: Array<{ request: AiChatRequest; userId: string | null | undefined }> = [];
  let status = { enabled: true, configured: true };
  let reply: (() => Promise<{ content: string } | null>) = async () => ({ content: answer(["Ligue hoje para C2 e retome a aveia."]) });
  const ai = {
    getStatus: () => status as ReturnType<AiService["getStatus"]>,
    chat: async (request: AiChatRequest, options: { userId?: string | null } = {}) => {
      requests.push({ request, userId: options.userId });
      const result = await reply();
      return result ? ({ ...result, model: "modelo-ficticio", elapsedMs: 1, provider: "ficticio" } as Awaited<ReturnType<AiService["chat"]>>) : null;
    }
  };
  const logs: string[] = [];
  const log = (level: string, message: string, meta: Record<string, unknown>) => void logs.push(JSON.stringify({ level, message, meta }));
  const run = (round = createDailySummaryTipsRound()) => generateDailySummaryTips(data, now, { round, usageKey: DAILY_SUMMARY_TIPS_USAGE_BUCKET }, ai, log);

  assert.deepEqual(await run(), { status: "ok", tips: ["Ligue hoje para Agropecuaria Ficticia Alfa Ltda e retome a aveia."] });
  const sent = requests[0];
  assert.equal(sent.userId, "resumo-diario");
  assert.equal(sent.request.system, DAILY_SUMMARY_TIPS_SYSTEM_PROMPT);
  assert.equal(sent.request.responseFormat, "json_object");
  assert.equal(sent.request.maxTokens, 600);
  assert.equal(sent.request.messages[0].content, message);

  // Resposta reprovada: descartada, sem desligar a rodada.
  reply = async () => ({ content: answer(["Ofereça desconto a C9."]) });
  const round = createDailySummaryTipsRound();
  assert.deepEqual(await run(round), { status: "discarded", tips: [] });
  assert.equal(round.aiDown, false);

  // Falha da IA (null): sem dicas e o disjuntor desliga a rodada; o próximo vendedor nem chama a IA.
  reply = async () => null;
  assert.deepEqual(await run(round), { status: "ai_failed", tips: [] });
  assert.equal(round.aiDown, true);
  const before = requests.length;
  reply = async () => ({ content: answer(["Ligue para C1."]) });
  assert.deepEqual(await run(round), { status: "round_skipped", tips: [] });
  assert.equal(requests.length, before, "rodada desligada não chama a IA");
  // Rodada nova volta a tentar.
  assert.equal((await run()).status, "ok");

  // Erro inesperado: sem dicas, nunca lança.
  reply = async () => Promise.reject(new TypeError("falha ficticia"));
  assert.deepEqual(await run(), { status: "ai_failed", tips: [] });

  // IA desligada ou não configurada: nem chama.
  status = { enabled: false, configured: true };
  const calls = requests.length;
  assert.deepEqual(await run(), { status: "ai_unavailable", tips: [] });
  assert.equal(requests.length, calls);

  // Sem itens com dados: nada a pedir, sem log.
  const quiet = logs.length;
  assert.deepEqual(await generateDailySummaryTips({ ...data, sections: {} }, now, { round: createDailySummaryTipsRound(), usageKey: "x" }, ai, log), { status: "no_summary", tips: [] });
  assert.equal(logs.length, quiet);

  const all = logs.join("\n");
  assert.match(all, /\[whatsapp daily summary\] tips/);
  assert.match(all, /"reason":"unknown_code"/);
  assert.match(all, /"codes":3/);
  assert.doesNotMatch(all, /Ficticia|Ficticio|Ligue|aveia|desconto|C2|48000/i, "log só com situação, motivo e contagens");
}

// 5) Provedor das dicas: Groq quando a chave existe (modelo da configuração), senão a IA do CRM. fetch falso: nada
// sai da máquina. Chave e endereço fictícios.
{
  env.aiChatEnabled = true;
  const crmAi = new AiService(
    () => new OpenAICompatibleProvider({ providerName: "openrouter", baseUrl: "https://crm-ficticio.test/v1", apiKey: "chave-crm-ficticia", model: "fornecedor/modelo-ficticio:free", timeoutMs: 1_000, defaultTemperature: 0.2, defaultMaxTokens: 512 }),
    new AiUsageLimiter(async () => 1_000)
  );
  const groq = { baseUrl: "https://groq-ficticio.test/openai/v1", apiKey: "chave-groq-ficticia" };

  // Sem chave da Groq: as dicas usam a IA do CRM, como antes.
  assert.equal(dailySummaryTipsAi("openai/gpt-oss-120b", { groq: null, fallback: crmAi }), crmAi);
  assert.equal(groqTextConfig({ whatsappTranscriptionBaseUrl: "https://groq-ficticio.test/openai/v1", whatsappTranscriptionApiKey: "" }), null);
  assert.equal(groqTextConfig({ whatsappTranscriptionBaseUrl: "", whatsappTranscriptionApiKey: "chave-groq-ficticia" }), null);
  assert.deepEqual(groqTextConfig({ whatsappTranscriptionBaseUrl: " https://groq-ficticio.test/openai/v1 ", whatsappTranscriptionApiKey: " chave-groq-ficticia " }), groq);

  // Com chave: Groq, modelo da configuração (padrão 120b), mesmo teto diário da IA do CRM.
  const groqDefault = dailySummaryTipsAi(undefined, { groq, fallback: crmAi });
  assert.notEqual(groqDefault, crmAi);
  assert.deepEqual([groqDefault.getStatus().provider, groqDefault.getStatus().model], ["groq", "openai/gpt-oss-120b"]);
  assert.equal(groqDefault.usageLimiter, crmAi.usageLimiter);
  assert.equal(dailySummaryTipsAi("openai/gpt-oss-120b", { groq, fallback: crmAi }), groqDefault, "um serviço por modelo");
  assert.equal(dailySummaryTipsAi("openai/gpt-oss-20b", { groq, fallback: crmAi }).getStatus().model, "openai/gpt-oss-20b");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  let respond: () => Response = () => Response.json({ choices: [{ message: { role: "assistant", content: answer(["Ligue hoje para C2."]) }, finish_reason: "stop" }] });
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return respond();
  }) as typeof fetch;
  const logs: string[] = [];
  const log = (level: string, message: string, meta: Record<string, unknown>) => void logs.push(JSON.stringify({ level, message, meta }));
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.info = console.warn = console.error = () => undefined;
  try {
    // Dicas pela Groq: endereço e corpo da Groq, conteúdo conferido como sempre.
    const groq20b = dailySummaryTipsAi("openai/gpt-oss-20b", { groq, fallback: crmAi });
    const ok = await generateDailySummaryTips(data, now, { round: createDailySummaryTipsRound(), usageKey: DAILY_SUMMARY_TIPS_USAGE_BUCKET, model: "openai/gpt-oss-20b" }, groq20b, log);
    assert.deepEqual(ok, { status: "ok", tips: ["Ligue hoje para Agropecuaria Ficticia Alfa Ltda."] });
    assert.equal(calls[0].url, "https://groq-ficticio.test/openai/v1/chat/completions");
    assert.equal(calls[0].body.model, "openai/gpt-oss-20b");
    assert.equal(calls[0].body.reasoning_effort, "low");
    assert.equal(calls[0].body.include_reasoning, false);
    assert.equal(calls[0].body.max_completion_tokens, 600);
    assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
    assert.equal("reasoning" in calls[0].body, false);
    assert.match(logs.at(-1)!, /"provider":"groq","model":"openai\/gpt-oss-20b"/);

    // 429 da Groq: uma chamada só (sem nova tentativa), sem dicas e a rodada desligada; o resumo sai sem o bloco.
    respond = () => new Response(JSON.stringify({ error: { message: "limite ficticio" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } });
    const round = createDailySummaryTipsRound();
    const before = calls.length;
    assert.deepEqual(await generateDailySummaryTips(data, now, { round, usageKey: DAILY_SUMMARY_TIPS_USAGE_BUCKET }, groq20b, log), { status: "ai_failed", tips: [] });
    assert.equal(calls.length - before, 1, "429 não tenta de novo");
    assert.equal(round.aiDown, true);
    assert.equal(groq20b.getStatus().lastError, "http_429");
    assert.match(logs.at(-1)!, /"result":"ai_failed".*"provider":"groq"/);

    // Sem chave: a chamada vai ao provedor do CRM, com o corpo do OpenRouter de sempre.
    respond = () => Response.json({ choices: [{ message: { role: "assistant", content: answer(["Ligue hoje para C2."]) }, finish_reason: "stop" }] });
    const viaCrm = await generateDailySummaryTips(data, now, { round: createDailySummaryTipsRound(), usageKey: DAILY_SUMMARY_TIPS_USAGE_BUCKET }, dailySummaryTipsAi("openai/gpt-oss-120b", { groq: null, fallback: crmAi }), log);
    assert.equal(viaCrm.status, "ok");
    const last = calls.at(-1)!;
    assert.equal(last.url, "https://crm-ficticio.test/v1/chat/completions");
    assert.equal(last.body.model, "fornecedor/modelo-ficticio:free");
    assert.equal(last.body.max_tokens, 600);
    assert.equal("reasoning_effort" in last.body, false);
    assert.match(logs.at(-1)!, /"provider":"openrouter"/);

    assert.doesNotMatch(logs.join("\n"), /chave-|Agropecuaria|Produtor|Revenda|Ligue|limite ficticio/i, "log só com códigos e números");
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

console.log("dailySummaryTips.test.ts: ok");
