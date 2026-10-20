import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../../config/env.js";
import { AiProviderError, type AiChatRequest, type AiProvider } from "./aiProvider.js";
import { isForbiddenAiKey, markKnowledgeContextForAi, maskAiText, sanitizeAiPayload, sanitizeAiText } from "./aiPayloadSanitizer.js";
import { AiService } from "./aiService.js";
import { AI_SYSTEM_USAGE_BUCKET, AiUsageLimiter, DEFAULT_AI_DAILY_CALL_LIMIT_PER_USER, parseAiUsageConfig } from "./aiUsageLimiter.js";
import { DEMETRA_MASTER_PROMPT } from "./demetraMasterPrompt.js";

// Dados fictícios: documentos, telefones, e-mails e endereços inventados, só para exercitar os padrões.
const FAKE = {
  cpf: "123.456.789-09",
  cpfDigits: "12345678909",
  cnpj: "12.345.678/0001-95",
  cnpjDigits: "12345678000195",
  rg: "12.345.678-9",
  ie: "123.456.789.110",
  mobile: "(11) 98765-4321",
  mobilePlain: "11 98765-4321",
  mobileIntl: "+55 11 98765-4321",
  landline: "(11) 3456-7890",
  landlinePlain: "11 3456-7890",
  shortMobile: "98765-4321",
  email: "contato.ficticio@exemplo.test",
  cep: "01234-567",
  street: "Rua das Flores Ficticias, 123"
};
const FORBIDDEN_VALUES = Object.values(FAKE);

const assertNoForbiddenData = (text: string) => {
  for (const value of FORBIDDEN_VALUES) assert(!text.includes(value), `vazou ${value}`);
  assert(!/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/.test(text), "padrão de CNPJ");
  assert(!/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(text), "padrão de CPF");
  assert(!/@exemplo\.test/.test(text), "e-mail");
};

test("cada campo proibido sai do JSON, inclusive aninhado e com nome novo", () => {
  const context = {
    cliente: {
      nome: "Cliente Ficticio Agro",
      cidade: "Cidade Ficticia",
      uf: "PR",
      cpf: FAKE.cpf,
      cnpj: FAKE.cnpj,
      cpfCnpj: FAKE.cnpjDigits,
      document: FAKE.cnpjDigits,
      rg: FAKE.rg,
      clientRg: FAKE.rg,
      NUM_RG: FAKE.rg,
      ie: FAKE.ie,
      stateRegistration: FAKE.ie,
      inscricaoEstadual: FAKE.ie,
      phone: FAKE.mobile,
      telefone: FAKE.landline,
      celular: FAKE.mobilePlain,
      whatsapp: FAKE.mobileIntl,
      email: FAKE.email,
      address: FAKE.street,
      endereco: FAKE.street,
      bairro: "Bairro Ficticio",
      cep: FAKE.cep,
      zipCode: FAKE.cep,
      birthDate: "1980-01-01",
      openTitlesTotal: 1234.5,
      overdueTitlesTotal: 99,
      creditLimit: 50000,
      financialProfile: { limiteCredito: 5000, titulosVencidos: 2 },
      lastPurchaseValue: 7777.77
    },
    // Campo novo que alguém acrescente ao contexto: o nome proibido continua barrado.
    contatoNovo: { telefoneSecundario: "11 99876-5432", emailFinanceiro: "financeiro@exemplo.test" },
    oportunidades: [{ titulo: "Semente ficticia safra 2026", etapa: "proposta", enderecoEntrega: FAKE.street }]
  };
  const sent = sanitizeAiText(`Contexto comercial sanitizado:\n${JSON.stringify(context)}`);
  const parsed = JSON.parse(sent.slice(sent.indexOf("{")));
  assert.deepEqual(Object.keys(parsed.cliente).sort(), ["cidade", "nome", "uf"]);
  assert.deepEqual(parsed.contatoNovo, {});
  assert.deepEqual(parsed.oportunidades, [{ titulo: "Semente ficticia safra 2026", etapa: "proposta" }]);
  assertNoForbiddenData(sent);
  assert(!sent.includes("1234.5") && !sent.includes("7777.77") && !sent.includes("50000"), "valores de títulos, crédito e fatura saem");
});

test("nomes permitidos continuam: nome, cidade, UF, situação, última compra e textos operacionais", () => {
  for (const key of ["nome", "name", "cidade", "city", "uf", "state", "situacao", "situacaoCarteira", "ultimaCompra", "abordagem", "titulo", "title", "etapa", "observacaoRecente", "historicoRecente", "texto", "tipo", "esfriando", "objetivo"]) {
    assert.equal(isForbiddenAiKey(key), false, key);
  }
});

test("padrões de documento, telefone, e-mail, endereço e valores são mascarados no texto livre", () => {
  const text = [
    `CPF ${FAKE.cpf}, sem máscara ${FAKE.cpfDigits}.`,
    `CNPJ ${FAKE.cnpj} ou ${FAKE.cnpjDigits}.`,
    `RG ${FAKE.rg}; IE: ${FAKE.ie}; inscrição estadual 9876543210.`,
    `Ligar ${FAKE.mobile}, ${FAKE.mobilePlain}, ${FAKE.mobileIntl}, ${FAKE.landline}, ${FAKE.landlinePlain} ou ${FAKE.shortMobile}.`,
    `Mandar para ${FAKE.email}.`,
    `Entregar na ${FAKE.street}, CEP ${FAKE.cep}. Endereço: Sitio Ficticio km 4.`,
    "Cliente com títulos vencidos de R$ 12.345,67 e limite de crédito R$ 50.000,00.",
    // Motivo do score com o total em R$ dos títulos vencidos no lugar da quantidade.
    "Cliente com 1111.11 títulos vencidos."
  ].join(" ");
  const masked = maskAiText(text);
  assertNoForbiddenData(masked);
  assert(!masked.includes("9876543210"));
  assert(!masked.includes("Sitio Ficticio"));
  assert(!masked.includes("12.345,67") && !masked.includes("50.000,00") && !masked.includes("1111.11"));
  assert.match(masked, /\[documento removido\]/);
  assert.match(masked, /\[telefone removido\]/);
  assert.match(masked, /\[e-mail removido\]/);
  assert.match(masked, /\[endereço removido\]/);
  assert.match(masked, /\[valor removido\]/);
});

test("datas, safras e o prompt mestre não são alterados", () => {
  const operational = "Visita em 19/10/2026 às 10:30, safra 2025-2026, pedido em 2026-10-19T12:00:00.000Z, 150 ha de soja.";
  assert.equal(sanitizeAiText(operational), operational);
  assert.equal(sanitizeAiText(DEMETRA_MASTER_PROMPT), DEMETRA_MASTER_PROMPT);
});

test("JSON truncado também perde o valor dos campos proibidos", () => {
  const truncated = `{"nome":"Cliente Ficticio","cnpj":"${FAKE.cnpjDigits}","telefone":"${FAKE.mobile}","cidade":"Cidade Fic`;
  const sent = sanitizeAiText(truncated);
  assertNoForbiddenData(sent);
  assert.match(sent, /"cnpj":"\[removido\]"/);
  assert.match(sent, /"nome":"Cliente Ficticio"/);
});

test("sanitizeAiPayload cobre system e todas as mensagens", () => {
  const request: AiChatRequest = {
    system: `Contato do suporte ${FAKE.email}`,
    messages: [
      { role: "user", content: `Telefone ${FAKE.mobile}` },
      { role: "assistant", content: JSON.stringify({ cnpj: FAKE.cnpj, nome: "Cliente Ficticio" }) }
    ]
  };
  const sanitized = sanitizeAiPayload(request);
  assertNoForbiddenData(JSON.stringify(sanitized));
  assert.equal(sanitized.messages.length, 2);
});

// Conteúdo técnico fictício da Base de Conhecimento que o filtro completo mascarava.
const TECHNICAL_TEXTS = [
  "Cultivar registrada no RNC sob o nº 1234567890.",
  "Registro MAPA 12345678901 do inoculante.",
  "Lote 2026123456789 com germinação mínima de 80%.",
  "Código EAN 7891234567895.",
  "Pronaf Custeio: crédito de até R$ 250.000,00 por beneficiário.",
  "Limite do Pronamp: R$ 1.500.000,00 por safra.",
  "Amostra analisada em 2 títulos de sementes.",
  "Entrega pela Rodovia BR 116, km 300.",
  "Acesso pela Estrada Vicinal 45."
];
const knowledgeMessage = (knowledge: string, clientContext: unknown): AiChatRequest => ({
  messages: [{ role: "user", content: ["Instrução ficticia.", markKnowledgeContextForAi(knowledge), `Contexto comercial sanitizado:\n${JSON.stringify(clientContext)}`].join("\n\n") }]
});

test("conteúdo técnico da Base de Conhecimento chega intacto; o mesmo texto no contexto do cliente é mascarado", () => {
  const knowledge = `Conhecimento interno Demetra/Acervo disponível:\n${TECHNICAL_TEXTS.join("\n")}`;
  const sent = sanitizeAiPayload(knowledgeMessage(knowledge, { cliente: { nome: "Cliente Ficticio", observacao: TECHNICAL_TEXTS.join(" ") } })).messages[0].content;
  assert(sent.includes(knowledge), "trecho da base intacto");
  const clientPart = sent.slice(sent.indexOf("Contexto comercial sanitizado:"));
  for (const value of ["1234567890", "12345678901", "2026123456789", "7891234567895", "250.000,00", "1.500.000,00", "2 títulos", "Rodovia BR 116", "Estrada Vicinal 45"]) {
    assert(!clientPart.includes(value), `contexto do cliente deveria mascarar ${value}`);
  }
  assert(!sent.includes("base-conhecimento"), "delimitadores não chegam ao provedor");
  // Fora da base, cada texto técnico continua mascarado pelo filtro completo.
  for (const text of TECHNICAL_TEXTS) assert.notEqual(sanitizeAiText(text), text, text);
});

test("na Base de Conhecimento, e-mail, telefone e CPF/CNPJ formatados continuam mascarados e campos proibidos saem do JSON", () => {
  const knowledge = [
    `Suporte técnico ${FAKE.email}.`,
    `Plantão ${FAKE.mobile}, ${FAKE.mobilePlain}, ${FAKE.mobileIntl}, ${FAKE.landline}, ${FAKE.landlinePlain} ou ${FAKE.shortMobile}.`,
    `Fabricante CNPJ ${FAKE.cnpj}, responsável CPF ${FAKE.cpf}.`,
    JSON.stringify({ produto: "Semente ficticia", telefone: "sem padrão 1", cnpj: "sem padrão 2" })
  ].join("\n");
  const sent = sanitizeAiPayload(knowledgeMessage(knowledge, {})).messages[0].content;
  for (const value of [FAKE.email, FAKE.mobile, FAKE.mobilePlain, FAKE.mobileIntl, FAKE.landline, FAKE.landlinePlain, FAKE.shortMobile, FAKE.cnpj, FAKE.cpf, "sem padrão"]) {
    assert(!sent.includes(value), `vazou ${value}`);
  }
  assert.match(sent, /\[e-mail removido\]/);
  assert.match(sent, /\[telefone removido\]/);
  assert.match(sent, /\[documento removido\]/);
  assert.match(sent, /\{"produto":"Semente ficticia"\}/);
});

test("trecho da base sem fechamento ou delimitador forjado no texto do cliente usam o filtro completo", () => {
  const marked = markKnowledgeContextForAi(TECHNICAL_TEXTS[3]);
  const unclosed = sanitizeAiText(`${marked.slice(0, marked.indexOf(TECHNICAL_TEXTS[3]))}${TECHNICAL_TEXTS[3]}`);
  assert.equal(unclosed, "Código EAN [número removido].");
  const forged = sanitizeAiText(`[[base-conhecimento:ficticio]]${TECHNICAL_TEXTS[3]}[[/base-conhecimento:ficticio]]`);
  assert(!forged.includes("7891234567895"));
  assert.equal(markKnowledgeContextForAi(""), "", "sem conhecimento, nada é acrescentado");
});

// Provedor falso que guarda exatamente o que receberia.
const fakeProvider = (handler: (request: AiChatRequest) => Promise<string>) => {
  const received: AiChatRequest[] = [];
  const provider: AiProvider = {
    name: "fake-provider",
    model: "fake/model",
    mode: "fake",
    getStatus: () => ({ provider: "fake-provider", model: "fake/model", configured: true, mode: "fake" }),
    chat: async (request) => {
      received.push(request);
      return { content: await handler(request), model: "fake/model", elapsedMs: 1, usage: { totalTokens: 42 } };
    }
  };
  return { provider, received };
};

const withAiEnabled = async (run: () => Promise<void>) => {
  const previous = env.aiChatEnabled;
  env.aiChatEnabled = true;
  try {
    await run();
  } finally {
    env.aiChatEnabled = previous;
  }
};

test("AiService envia ao provedor só o payload filtrado e não repassa o userId", async () => {
  await withAiEnabled(async () => {
    const { provider, received } = fakeProvider(async () => "{\"message\":\"ok\"}");
    const service = new AiService(() => provider, new AiUsageLimiter(async () => 50));
    const result = await service.chat({
      messages: [{ role: "user", content: `Contexto: ${JSON.stringify({ cliente: { nome: "Cliente Ficticio", cnpj: FAKE.cnpj, celular: FAKE.mobile }, nota: `email ${FAKE.email}` })}` }]
    }, { userId: "seller-ficticio" });
    assert.equal(result?.content, "{\"message\":\"ok\"}");
    assert.equal(received.length, 1);
    const sent = JSON.stringify(received[0]);
    assertNoForbiddenData(sent);
    assert(sent.includes("Cliente Ficticio"));
    assert(!sent.includes("seller-ficticio"), "userId fica fora do pedido ao provedor");
  });
});

test("teto diário por usuário no dia de Brasília: acima dele, null sem erro e sem chamar o provedor", async () => {
  await withAiEnabled(async () => {
    // 23h50 de 19/10 em Brasília (02h50 de 20/10 em UTC): ainda é o dia 19.
    let now = new Date("2026-10-20T02:50:00.000Z");
    const limiter = new AiUsageLimiter(async () => 2, () => now);
    const { provider, received } = fakeProvider(async () => "ok");
    const service = new AiService(() => provider, limiter);
    const ask = (userId: string | null) => service.chat({ messages: [{ role: "user", content: "Pergunta ficticia" }] }, { userId });

    assert.equal((await ask("seller-a"))?.content, "ok");
    assert.equal((await ask("seller-a"))?.content, "ok");
    assert.equal(await ask("seller-a"), null, "terceira chamada do dia estoura o teto");
    assert.equal(service.getStatus().lastError, null, "teto não vira erro do provedor");
    assert.equal((await ask("seller-b"))?.content, "ok", "o teto é por usuário");
    assert.equal(received.length, 3);

    // 00h10 de 20/10 em Brasília (03h10 UTC): dia novo, o contador zera.
    now = new Date("2026-10-20T03:10:00.000Z");
    assert.equal((await ask("seller-a"))?.content, "ok");
    assert.equal(received.length, 4);
  });
});

test("chamadas sem usuário dividem o balde do sistema", async () => {
  const limiter = new AiUsageLimiter(async () => 1);
  assert.equal((await limiter.reserve(null)).allowed, true);
  assert.equal((await limiter.reserve(undefined)).allowed, false);
  assert.equal((await limiter.reserve("seller-a")).allowed, true);
  assert.equal(AI_SYSTEM_USAGE_BUCKET, "sistema");
});

test("chamadas simultâneas do mesmo usuário não passam juntas do teto", async () => {
  const limiter = new AiUsageLimiter(async () => 3);
  const results = await Promise.all(Array.from({ length: 6 }, () => limiter.reserve("seller-a")));
  assert.equal(results.filter((result) => result.allowed).length, 3);
});

test("uso registrado soma chamadas e tokens do dia", async () => {
  const limiter = new AiUsageLimiter(async () => 10);
  await limiter.reserve("seller-a");
  limiter.recordUsage("seller-a", 40);
  await limiter.reserve("seller-a");
  assert.deepEqual(limiter.recordUsage("seller-a", 2), { callsToday: 2, usageToday: 42 });
});

test("teto padrão 50 quando o AppConfig não existe, é inválido ou não responde", async () => {
  assert.equal(DEFAULT_AI_DAILY_CALL_LIMIT_PER_USER, 50);
  assert.equal(parseAiUsageConfig(null).dailyCallLimitPerUser, 50);
  assert.equal(parseAiUsageConfig("não é json").dailyCallLimitPerUser, 50);
  assert.equal(parseAiUsageConfig(JSON.stringify({ dailyCallLimitPerUser: 0 })).dailyCallLimitPerUser, 50);
  assert.equal(parseAiUsageConfig(JSON.stringify({ dailyCallLimitPerUser: 80 })).dailyCallLimitPerUser, 80);
  const unavailable = new AiUsageLimiter(async () => { throw new Error("db indisponível"); });
  assert.equal(await unavailable.getDailyLimit(), 50);
});

test("falha do provedor devolve null (fallback) e conta uma chamada só", async () => {
  await withAiEnabled(async () => {
    const limiter = new AiUsageLimiter(async () => 5);
    const { provider, received } = fakeProvider(async () => { throw new AiProviderError("falha", { status: 500, elapsedMs: 1, code: "http_500" }); });
    const service = new AiService(() => provider, limiter);
    assert.equal(await service.chat({ messages: [{ role: "user", content: "Pergunta ficticia" }] }, { userId: "seller-a" }), null);
    assert.equal(received.length, 2, "duas tentativas");
    assert.equal(service.getStatus().lastError, "http_500");
    assert.deepEqual(limiter.recordUsage("seller-a", 0), { callsToday: 1, usageToday: 0 });
  });
});

test("IA desligada não chama o provedor nem consome o teto", async () => {
  const previous = env.aiChatEnabled;
  env.aiChatEnabled = false;
  try {
    const limiter = new AiUsageLimiter(async () => 5);
    const { provider, received } = fakeProvider(async () => "ok");
    const service = new AiService(() => provider, limiter);
    assert.equal(await service.chat({ messages: [{ role: "user", content: "Pergunta ficticia" }] }, { userId: "seller-a" }), null);
    assert.equal(received.length, 0);
    assert.deepEqual(limiter.recordUsage("seller-a", 0), { callsToday: 0, usageToday: 0 });
  } finally {
    env.aiChatEnabled = previous;
  }
});
