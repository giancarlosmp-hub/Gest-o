import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { WHATSAPP_CRM_RECIPIENT_REFUSAL_MESSAGES } from "@salesforce-pro/shared";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { createWhatsAppConversationsTestDb } from "../services/whatsappMessages/whatsappConversationsTestDb.js";
import { DAILY_SUMMARY_CONFIG_KEY } from "../services/whatsappDailySummary/dailySummaryConfig.js";
import { resetDailySummaryTestCooldown } from "./whatsappDailySummaryRoutes.js";

// WhatsApp Fase D: rotas do resumo diário (configuração, situação, prévia, "Enviar teste para mim") com
// Prisma em memória e um Evolution falso em localhost. Só dados fictícios.
const { tables } = createWhatsAppConversationsTestDb(prisma);
const user = (id: string) => tables.user.find((row) => row.id === id)!;
user("manager-a").phone = "(11) 90000-0201";
user("seller-a").phone = "11 90000-0202";
user("seller-b").phone = "11900000203";
tables.clientPhoneIndex.push({ id: "idx-1", phone: "5511900000203", clientId: "client-a", source: "crm" });
tables.whatsAppConnection.push({ id: "conn-1", userId: "manager-a", instanceName: "crm-ficticio-gerente", status: "CONNECTED", connectedPhone: "5511900000201" });
tables.client.push({ id: "client-a", name: "Cliente Ficticio A", city: "Cidade Ficticia", state: "SP", isArchived: false });
tables.opportunity.push({
  id: "opp-1",
  clientId: "client-a",
  ownerSellerId: "seller-a",
  stage: "proposta",
  origin: null,
  notes: null,
  createdAt: new Date(Date.now() - 72 * 3_600_000),
  followUpDate: new Date("2020-01-06T00:00:00.000Z")
});

// Evolution falso: estado "open" e envio aceito.
const evolutionRequests: Array<{ method: string; url: string; body: any }> = [];
let instanceState = "open";
const evolution = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  evolutionRequests.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null });
  if (req.url!.startsWith("/instance/connectionState/")) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ instance: { state: instanceState } }));
  if (req.url!.startsWith("/message/sendText/")) return res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ key: { id: "MSG-FICTICIA" }, status: "PENDING" }));
  res.writeHead(404).end();
});
evolution.listen(0, "127.0.0.1");
await once(evolution, "listening");

const server = app.listen(0);
await once(server, "listening");
const port = (server.address() as { port: number }).port;
const call = async (userId: string, method: string, path: string, body?: unknown) => {
  const row = user(userId);
  const response = await fetch(`http://127.0.0.1:${port}/whatsapp${path}`, {
    method,
    headers: { Authorization: `Bearer ${signAccessToken({ id: row.id, email: row.email, role: row.role })}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};

const logs: string[] = [];
const originals = { info: console.info, warn: console.warn, error: console.error };
for (const level of ["info", "warn", "error"] as const) console[level] = (...args: unknown[]) => void logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));

const config = { enabled: true, sendTime: "07:45", senderUserId: "manager-a", sections: { reactivations: true, newOpportunities: true, overdueFollowUps: true, todayFollowUps: false }, managerTips: false };

try {
  env.communicationsEnabled = true;
  env.whatsappEvolutionEnabled = true;
  env.whatsappEvolutionBaseUrl = `http://127.0.0.1:${(evolution.address() as { port: number }).port}`;
  env.whatsappEvolutionApiKey = "chave-ficticia";
  env.whatsappEvolutionWebhookSecret = "segredo-ficticio";
  env.frontendUrl = "https://crm.exemplo.invalid";

  // 1) Vendedor não acessa nada.
  assert.equal((await call("seller-a", "GET", "/daily-summary")).status, 403);
  assert.equal((await call("seller-a", "POST", "/daily-summary/preview", { sellerId: "seller-a" })).status, 403);
  assert.equal((await call("seller-a", "POST", "/daily-summary/test-send", { sellerId: "seller-a" })).status, 403);

  // 2) Tela: desligado por padrão, remetentes com o status da conexão, vendedores com o destino conferido.
  const initial = await call("manager-a", "GET", "/daily-summary");
  assert.equal(initial.status, 200);
  assert.equal(initial.json.whatsappEnabled, true);
  assert.equal(initial.json.crmLinkConfigured, true);
  assert.equal(initial.json.config.enabled, false);
  assert.equal(initial.json.config.sendTime, "07:30");
  assert.equal(initial.json.senderStatus.code, "sender_not_configured");
  assert.deepEqual(
    initial.json.senders.map((row: any) => [row.userId, row.connected]),
    [["director-a", false], ["manager-a", true]]
  );
  const sellerRow = (json: any, id: string) => json.sellers.find((row: any) => row.userId === id);
  assert.deepEqual(sellerRow(initial.json, "seller-a").recipient, { ok: true });
  assert.deepEqual(sellerRow(initial.json, "seller-b").recipient, {
    ok: false,
    reason: "phone_matches_client",
    message: "O celular deste usuário também está cadastrado em cliente(s) – corrija o cadastro."
  });
  assert.equal(sellerRow(initial.json, "seller-c").recipient.reason, "no_phone");
  assert.doesNotMatch(JSON.stringify(initial.json), /client-a|Cliente Ficticio|5511900000203/, "a tela não expõe o cliente do celular repetido");

  // 3) Salvar: só diretor; remetente tem de ser diretor ou gerente ativo; corpo estrito.
  assert.equal((await call("manager-a", "PUT", "/daily-summary/config", config)).status, 403);
  const badSender = await call("director-a", "PUT", "/daily-summary/config", { ...config, senderUserId: "seller-a" });
  assert.deepEqual([badSender.status, badSender.json.code], [400, "sender_not_allowed"]);
  assert.equal((await call("director-a", "PUT", "/daily-summary/config", { ...config, sendTime: "7:45" })).status, 400);
  assert.equal((await call("director-a", "PUT", "/daily-summary/config", { ...config, extra: true })).status, 400);
  assert.equal((await call("director-a", "PUT", "/daily-summary/config", { ...config, managerTips: "sim" })).status, 400);
  // Corpo antigo, sem managerTips: aceito, com as dicas desligadas.
  const { managerTips: _omitted, ...legacyBody } = config;
  const legacy = await call("director-a", "PUT", "/daily-summary/config", legacyBody);
  assert.deepEqual([legacy.status, legacy.json.managerTips], [200, false]);
  const saved = await call("director-a", "PUT", "/daily-summary/config", config);
  assert.deepEqual([saved.status, saved.json], [200, config]);
  assert.deepEqual(JSON.parse(tables.appConfig.find((row) => row.key === DAILY_SUMMARY_CONFIG_KEY)!.value), config);
  assert.deepEqual((await call("manager-a", "GET", "/daily-summary")).json.senderStatus, { ok: true });

  // 4) Prévia: texto do vendedor, sem enviar nada; vazio; destino recusado com a mensagem; não vendedor = 404.
  const preview = await call("manager-a", "POST", "/daily-summary/preview", { sellerId: "seller-a" });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.empty, false);
  assert.match(preview.json.text, /^Bom dia, Vendedor! Resumo da sua carteira/);
  assert.match(preview.json.text, /\*Follow-ups vencidos\* \(1\)\n• Cliente Ficticio A – Cidade Ficticia\/SP – Proposta – follow-up 06\/01/);
  assert.match(preview.json.text, /Ver no CRM: https:\/\/crm\.exemplo\.invalid\/oportunidades/);
  assert.deepEqual(preview.json.recipient, { ok: true });
  const emptyPreview = await call("director-a", "POST", "/daily-summary/preview", { sellerId: "seller-b" });
  assert.deepEqual([emptyPreview.json.text, emptyPreview.json.empty], [null, true]);
  assert.equal(emptyPreview.json.recipient.message, WHATSAPP_CRM_RECIPIENT_REFUSAL_MESSAGES.phone_matches_client);
  assert.equal((await call("manager-a", "POST", "/daily-summary/preview", { sellerId: "manager-a" })).status, 404);
  assert.equal(evolutionRequests.length, 0, "a prévia nunca fala com o Evolution");

  // 5) Teste: vai só para o celular de quem clicou, pela instância do remetente, marcado como teste.
  const sent = await call("manager-a", "POST", "/daily-summary/test-send", { sellerId: "seller-a" });
  assert.deepEqual([sent.status, sent.json], [200, { result: "sent", code: null }]);
  const sendRequest = evolutionRequests.find((request) => request.url.startsWith("/message/sendText/"))!;
  assert.equal(sendRequest.url, "/message/sendText/crm-ficticio-gerente");
  assert.equal(sendRequest.body.number, "5511900000201", "celular de quem pediu o teste, nunca o do vendedor");
  assert.match(sendRequest.body.text, /^\[Teste\] Bom dia, Vendedor!/);
  const again = await call("manager-a", "POST", "/daily-summary/test-send", { sellerId: "seller-a" });
  assert.deepEqual([again.status, again.json.code], [429, "test_send_cooldown"]);

  // Quem pediu o teste sem celular: recusado com a mensagem, nada enviado.
  const sendsBefore = evolutionRequests.filter((request) => request.url.startsWith("/message/")).length;
  const noPhone = await call("director-a", "POST", "/daily-summary/test-send", { sellerId: "seller-a" });
  assert.deepEqual([noPhone.status, noPhone.json.code], [409, "no_phone"]);
  // Vendedor sem nada: o teste avisa que ele não recebe mensagem.
  resetDailySummaryTestCooldown();
  await call("manager-a", "POST", "/daily-summary/test-send", { sellerId: "seller-b" });
  assert.match(evolutionRequests.filter((request) => request.url.startsWith("/message/")).at(-1)!.body.text, /^\[Teste\] Resumo diário: nada a enviar hoje/);

  // 6) Remetente desconectado no Evolution: nada sai, aviso na resposta.
  resetDailySummaryTestCooldown();
  instanceState = "close";
  const disconnected = await call("manager-a", "POST", "/daily-summary/test-send", { sellerId: "seller-a" });
  assert.deepEqual([disconnected.status, disconnected.json.code], [409, "sender_not_connected"]);
  assert.match(disconnected.json.message, /não está conectado/);
  assert.equal(evolutionRequests.filter((request) => request.url.startsWith("/message/")).length, sendsBefore + 1);

  // 7) WhatsApp desligado: teste recusado; a tela mostra que está desligado.
  env.whatsappEvolutionEnabled = false;
  assert.deepEqual((await call("manager-a", "POST", "/daily-summary/test-send", { sellerId: "seller-a" })).json.code, "whatsapp_disabled");
  assert.equal((await call("manager-a", "GET", "/daily-summary")).json.whatsappEnabled, false);

  // Log sem texto, nomes ou números.
  const all = logs.join("\n");
  assert.match(all, /test send/);
  assert.doesNotMatch(all, /Vendedor Ficticio|Cliente Ficticio|Bom dia|5511900000|90000-02/);
} finally {
  Object.assign(console, originals);
  server.close();
  evolution.close();
  await prisma.$disconnect().catch(() => undefined);
}

console.log("whatsappDailySummary.http.test.ts: ok");
