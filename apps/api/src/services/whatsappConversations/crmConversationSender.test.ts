import assert from "node:assert/strict";
import { env } from "../../config/env.js";
import { EvolutionUnavailableError, type EvolutionClientSendResult } from "../whatsappConnection/evolutionClient.js";
import { createWhatsAppConversationsTestDb } from "../whatsappMessages/whatsappConversationsTestDb.js";
import { PrismaWhatsAppMessageStore } from "../whatsappMessages/whatsappMessageStore.js";
import type { ClientRecipient } from "./clientRecipient.js";
import { CRM_SEND_CONFIG_KEY } from "./crmSendConfig.js";
import { CRM_SEND_LIMITS, CrmSendLimiter, loadDayUsageFromDb } from "./crmSendLimits.js";
import { CRM_SEND_HTTP_STATUS, CRM_SEND_MAX_TEXT_LENGTH, CRM_SEND_MESSAGES, sendCrmText, type CrmSendDeps } from "./crmConversationSender.js";

// WhatsApp Fase C: ponto único de envio pelo CRM com Prisma e Evolution falsos. Só dados fictícios.
const models = ["user", "client", "opportunity", "opportunityItem", "opportunityChangeLog", "contact", "clientPhoneIndex", "communicationConversation", "communicationMessage", "appConfig", "whatsAppConnection", "tenantMembership"];
const db: any = Object.fromEntries(models.map((model) => [model, {}]));
const { tables } = createWhatsAppConversationsTestDb(db);

const ACCOUNT = "5511900000001";
tables.whatsAppConnection.push({ id: "conn-a", userId: "seller-a", instanceName: "crm-ficticio-a", status: "CONNECTED", connectedPhone: ACCOUNT });
tables.client.push({ id: "client-a", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false });
for (let i = 0; i < 30; i++) {
  tables.clientPhoneIndex.push({ id: `idx-${i}`, phone: `5511900000${400 + i}`, clientId: "client-a", tenantId: "tenant-a", source: "erp" });
}

// Evolution falso: estado e resultado configuráveis; guarda só quantos envios chegaram e para qual instância.
let state = "open";
let stateError: Error | null = null;
let nextResult: EvolutionClientSendResult | null = null;
let gate: Promise<void> | null = null;
let messageSeq = 0;
const sent: Array<{ instanceName: string; phone: string; text: string }> = [];
const client = {
  async connectionState() {
    if (stateError) throw stateError;
    return state as any;
  },
  async sendTextToClient(recipient: ClientRecipient, text: string): Promise<EvolutionClientSendResult> {
    if (gate) await gate;
    sent.push({ instanceName: recipient.instanceName, phone: recipient.phone, text });
    const result = nextResult ?? { kind: "sent" as const, messageId: `MSG-FICTICIA-${++messageSeq}` };
    nextResult = null;
    return result;
  }
};
let clock = Date.parse("2026-11-10T13:00:00.000Z");
const limiter = new CrmSendLimiter(loadDayUsageFromDb(db), () => clock);
const deps: CrmSendDeps = {
  db,
  client,
  store: new PrismaWhatsAppMessageStore(db),
  limiter,
  now: () => new Date(clock),
  internalPhones: async () => new Set()
};
const send = (target: any, text: unknown = "Olá, mensagem fictícia", userId = "seller-a", role = "vendedor") =>
  sendCrmText({ user: { id: userId, role }, tenantId: "tenant-a", target, text }, deps);
const code = async (...args: Parameters<typeof send>) => {
  const result = await send(...args);
  return result.ok ? "ok" : result.code;
};
const advance = (ms: number) => {
  clock += ms;
};

const logs: string[] = [];
const originals = { info: console.info, warn: console.warn, error: console.error };
for (const level of ["info", "warn", "error"] as const) console[level] = (...args: unknown[]) => void logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));

try {
  // 0) Toda recusa tem texto e status HTTP.
  for (const key of Object.keys(CRM_SEND_MESSAGES)) assert(CRM_SEND_HTTP_STATUS[key as keyof typeof CRM_SEND_HTTP_STATUS], key);

  // 1) Infraestrutura desligada, depois chave desligada (padrão).
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-0" }), "send_unavailable");
  env.communicationsEnabled = true;
  env.whatsappEvolutionEnabled = true;
  env.whatsappEvolutionMessagesEnabled = true;
  env.whatsappEvolutionBaseUrl = "http://127.0.0.1:1";
  env.whatsappEvolutionApiKey = "chave-ficticia";
  env.whatsappEvolutionWebhookSecret = "segredo-ficticio";
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-0" }), "send_disabled");
  tables.appConfig.push({ key: CRM_SEND_CONFIG_KEY, value: JSON.stringify({ enabled: true }) });

  // 2) Texto inválido e destino recusado não chegam ao Evolution.
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-0" }, "   "), "text_invalid");
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-0" }, "x".repeat(CRM_SEND_MAX_TEXT_LENGTH + 1)), "text_invalid");
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-0" }, ["lote"]), "text_invalid");
  assert.equal(await code({ clientId: "client-a", phoneRef: "nao-existe" }), "recipient_not_allowed");
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-0" }, "Olá", "seller-b"), "not_connected");
  assert.equal(sent.length, 0);

  // 3) Envio para contato novo: conversa criada e vinculada pelo CRM, mensagem "via CRM", sem não lidas.
  const first = await send({ clientId: "client-a", phoneRef: "idx-0" }, "  Olá, mensagem fictícia  ");
  assert(first.ok);
  assert.deepEqual(sent[0], { instanceName: "crm-ficticio-a", phone: "5511900000400", text: "Olá, mensagem fictícia" });
  const conversation = tables.communicationConversation.find((row) => row.id === first.conversationId)!;
  assert.equal(conversation.clientId, "client-a");
  assert.equal(conversation.linkStatus, "linked");
  assert.equal(conversation.linkSource, "crm");
  assert.equal(conversation.numberOwnerUserId, "seller-a");
  assert.equal(conversation.externalAccountId, ACCOUNT);
  assert.equal(conversation.contactDisplay, "(11) ****-0400");
  assert.equal(conversation.unreadCount, 0);
  assert.equal(conversation.previewSanitized, "Mensagem enviada");
  const stored = tables.communicationMessage.filter((row) => row.conversationId === first.conversationId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].externalMessageId, "MSG-FICTICIA-1");
  assert.equal(stored[0].direction, "OUTBOUND");
  assert.equal(stored[0].status, "SENT");
  assert.equal(stored[0].textContent, "Olá, mensagem fictícia");
  assert.deepEqual(stored[0].metadata, { origin: "crm", sentByUserId: "seller-a", firstContact: true });
  assert.equal(first.message.direction, "outbound");
  assert.equal(first.message.text, "Olá, mensagem fictícia");

  // 4) Intervalo mínimo; depois, pela conversa, mesma conversa (sem criar outra).
  assert.equal(await code({ conversationId: first.conversationId }), "rate_interval");
  advance(CRM_SEND_LIMITS.minIntervalMs);
  const second = await send({ conversationId: first.conversationId }, "Segunda mensagem fictícia");
  assert(second.ok);
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(tables.communicationConversation.filter((row) => row.externalConversationKey === "5511900000400").length, 1);

  // 5) Eco do webhook ANTES da resposta do envio: mesma mensagem (mesmo id), só a origem vira "crm".
  advance(CRM_SEND_LIMITS.minIntervalMs);
  tables.communicationMessage.push({
    id: "msg-eco",
    conversationId: first.conversationId,
    provider: "evolution_whatsapp",
    externalAccountId: ACCOUNT,
    externalMessageId: "MSG-ECO-FICTICIA",
    direction: "OUTBOUND",
    type: "TEXT",
    textContent: "Terceira mensagem fictícia",
    providerTimestamp: new Date(clock),
    status: "SENT",
    metadata: { origin: "app" }
  });
  nextResult = { kind: "sent", messageId: "MSG-ECO-FICTICIA" };
  const echoed = await send({ conversationId: first.conversationId }, "Terceira mensagem fictícia");
  assert(echoed.ok);
  const echoRows = tables.communicationMessage.filter((row) => row.externalMessageId === "MSG-ECO-FICTICIA");
  assert.equal(echoRows.length, 1, "nunca duplica");
  assert.deepEqual(echoRows[0].metadata, { origin: "crm", sentByUserId: "seller-a", firstContact: true });
  assert.equal(echoed.message.id, "msg-eco");

  // 6) Por minuto: 6 envios na janela; o 7º espera.
  advance(60_000);
  for (let i = 1; i <= CRM_SEND_LIMITS.perMinute; i++) {
    assert.equal(await code({ clientId: "client-a", phoneRef: `idx-${i}` }), "ok", `envio ${i}`);
    advance(CRM_SEND_LIMITS.minIntervalMs);
  }
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-7" }), "rate_minute");
  advance(60_000);

  // 7) Recusa certa do Evolution não conta; incerto conta e não grava nada.
  const before = tables.communicationMessage.length;
  nextResult = { kind: "not_sent", code: "number_not_on_whatsapp", retryable: false };
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-7" }), "number_not_on_whatsapp");
  nextResult = { kind: "not_sent", code: "instance_not_found", retryable: false };
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-7" }), "not_connected");
  nextResult = { kind: "uncertain", code: "timeout" };
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-7" }), "uncertain");
  assert.equal(tables.communicationMessage.length, before, "incerto e recusado não gravam");
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-8" }), "rate_interval", "o incerto contou como envio");
  advance(CRM_SEND_LIMITS.minIntervalMs);

  // 8) Instância fechada ou Evolution fora: nada sai.
  const sentBefore = sent.length;
  state = "close";
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-8" }), "not_connected");
  state = "open";
  stateError = new EvolutionUnavailableError("timeout");
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-8" }), "evolution_unavailable");
  stateError = null;
  assert.equal(sent.length, sentBefore);

  // 9) Um envio de cada vez por usuário (dois cliques): o segundo é recusado na hora.
  let open!: () => void;
  gate = new Promise((resolve) => (open = resolve));
  const pending = send({ clientId: "client-a", phoneRef: "idx-8" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await code({ clientId: "client-a", phoneRef: "idx-9" }), "send_in_progress");
  open();
  gate = null;
  assert((await pending).ok);
  advance(60_000);

  // 10) Primeiros contatos por dia: o mesmo contato conta uma vez; o 21º contato novo é recusado.
  // Até aqui: contatos novos idx-0..idx-8 (o 7, incerto, também conta) = 9.
  let contacts = 9;
  let phoneIndex = 9;
  while (contacts < CRM_SEND_LIMITS.firstContactsPerDay) {
    assert.equal(await code({ clientId: "client-a", phoneRef: `idx-${phoneIndex++}` }), "ok");
    contacts++;
    advance(15_000);
  }
  assert.equal(await code({ clientId: "client-a", phoneRef: `idx-${phoneIndex}` }), "rate_first_contact");
  assert.equal(await code({ conversationId: first.conversationId }), "ok", "contato já contado hoje não conta de novo");
  advance(15_000);
  assert.deepEqual(await limiter.today("seller-a", ACCOUNT), { total: 23, firstContacts: 20 });

  // 11) Depois de reiniciar a API, o dia parte do banco (só o que foi gravado: o incerto não volta).
  const restarted = new CrmSendLimiter(loadDayUsageFromDb(db), () => clock);
  assert.deepEqual(await restarted.today("seller-a", ACCOUNT), { total: 22, firstContacts: 19 });

  // 12) Limite do dia: com o total no limite, nada sai; no dia seguinte volta.
  const full = new CrmSendLimiter(async () => ({ total: CRM_SEND_LIMITS.perDay, firstContacts: new Set() }), () => clock);
  assert.equal(await sendCrmText({ user: { id: "seller-a", role: "vendedor" }, tenantId: "tenant-a", target: { conversationId: first.conversationId }, text: "x" }, { ...deps, limiter: full }).then((r) => (r.ok ? "ok" : r.code)), "rate_day");

  // 13) Logs do envio: só resultado e código. Nunca texto, telefone (completo ou parcial), nome, JID, id da
  // mensagem do WhatsApp, instância do Evolution nem chave/segredo.
  const joined = logs.join("\n");
  assert.match(joined, /\[whatsapp\] crm send/);
  for (const forbidden of ["mensagem fictícia", "Olá", "5511900000", "90000-0", "****-", "@s.whatsapp.net", "MSG-", "crm-ficticio", "chave-ficticia", "segredo-ficticio"]) {
    assert(!joined.includes(forbidden), `log com ${forbidden}`);
  }
  for (const line of logs.filter((entry) => entry.includes("[whatsapp] crm send"))) {
    const meta = JSON.parse(line).meta;
    assert(Object.keys(meta).every((key) => key === "result" || key === "code"), "log do envio só com resultado e código");
  }

  console.log("crmConversationSender.test.ts: ok");
} finally {
  Object.assign(console, originals);
}
