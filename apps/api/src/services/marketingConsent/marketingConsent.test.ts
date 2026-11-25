import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MarketingConsentSource, MarketingConsentStatus } from "@prisma/client";
import {
  canReceiveMarketing,
  classifyInboundConsent,
  consentTimelineDescription,
  normalizeOptInText,
  normalizeOptOutText,
  processInboundMarketingConsent,
  recordMarketingConsent,
} from "./marketingConsent.js";
import { MetaWhatsAppCloudProvider } from "../communications/metaWhatsAppCloudProvider.js";

// Dados fictícios: telefones de DDD válido com números inventados, tenants e clientes de teste.
const PHONE_A = "5511900000001";
const PHONE_B = "5511900000002";
/** Celular que o WhatsApp antigo manda sem o nono dígito ("55 11 8765-0003"). */
const PHONE_C = "5511987650003";

type Row = Record<string, any>;
function fakeDb(seed: { clients?: Row[]; phoneIndex?: Row[] } = {}) {
  const events: Row[] = [];
  const timeline: Row[] = [];
  const clients = seed.clients ?? [];
  const phoneIndex = seed.phoneIndex ?? [];
  let seq = 0;
  let clock = Date.parse("2026-11-01T12:00:00.000Z");
  const db = {
    events,
    timeline,
    /** Próximo registro no mesmo milissegundo (o id desempata). */
    sameInstant: false,
    marketingConsentEvent: {
      create: async ({ data }: any) => {
        seq += 1;
        if (!db.sameInstant) clock += 1000;
        const row = { id: `evt-${String(seq).padStart(4, "0")}`, createdAt: new Date(clock), ...data };
        events.push(row);
        return { id: row.id };
      },
      findFirst: async ({ where, orderBy }: any) => {
        assert.deepEqual(orderBy, [{ createdAt: "desc" }, { id: "desc" }], "o mais recente decide; o id desempata");
        const rows = events
          .filter((row) => row.tenantId === where.tenantId && row.phone === where.phone)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
        return rows[0] ? { status: rows[0].status, source: rows[0].source, createdAt: rows[0].createdAt } : null;
      },
    },
    client: {
      findFirst: async ({ where }: any) => {
        const row = clients.find((client) => client.id === where.id && client.tenantId === where.tenantId);
        return row ? { id: row.id, ownerSellerId: row.ownerSellerId } : null;
      },
    },
    timelineEvent: { create: async ({ data }: any) => { timeline.push(data); return data; } },
    clientPhoneIndex: {
      findMany: async ({ where }: any) =>
        phoneIndex
          .filter((row) => row.phone === where.phone)
          .filter((row) => {
            const client = clients.find((item) => item.id === row.clientId);
            return client && client.tenantId === where.client.tenantId && client.isArchived === where.client.isArchived;
          })
          .map((row) => ({ clientId: row.clientId })),
    },
  };
  return db;
}

// 1. Frases de aceite: acentos, maiúsculas, espaços e pontuação só nas pontas.
const accepted = [
  "Quero receber os boletins da Demetra",
  "quero receber os boletins da demetra",
  "  QUERO RECEBER OS BOLETINS DA DEMETRA  ",
  "Quero receber os boletins da Demetra!",
  "¡Quero receber os boletins da Demetra...",
  "Quero  receber   os boletins da Demetra",
  "Quéro recebêr os boletins da Deméträ",
];
for (const text of accepted) {
  assert.deepEqual(classifyInboundConsent({ text }), { status: MarketingConsentStatus.ACEITE, source: MarketingConsentSource.WHATSAPP_LINK }, `aceite: ${text}`);
}
const notAccepted = [
  "Quero receber os boletins da Demetra, por favor",
  "Oi! Quero receber os boletins da Demetra",
  "Quero receber os, boletins da Demetra",
  "Quero receber os boletins",
  "Quero receber os boletins da Demetra 👍",
  "",
  "   ",
];
for (const text of notAccepted) assert.equal(classifyInboundConsent({ text }), null, `não é aceite: ${JSON.stringify(text)}`);
assert.equal(normalizeOptInText("  Quero receber os boletins da Demetra?! "), "quero receber os boletins da demetra");

// 2. Palavras de descadastro: mensagem inteira, ignorando acentos, maiúsculas, espaços, pontuação e emojis.
const optOut = [
  "parar", "PARAR", "Parar.", "  parar!!! ", "Sair", "cancelar", "Descadastrar", "remover", "STOP", "stop 🛑",
  "🙏 parar 🙏", "Não quero receber", "nao quero receber", "NÃO QUERO RECEBER!!", "não, quero receber",
  "Não quero mais receber", "nao-quero-mais-receber", "Cancelar 😡😡",
];
for (const text of optOut) {
  assert.deepEqual(classifyInboundConsent({ text }), { status: MarketingConsentStatus.DESCADASTRO, source: MarketingConsentSource.WHATSAPP_PALAVRA }, `descadastro: ${text}`);
}
const notOptOut = ["parar de receber", "quero sair do grupo", "pode cancelar o pedido?", "stop por favor", "não quero", "obrigado", "p a r a r", "remove"];
for (const text of notOptOut) assert.equal(classifyInboundConsent({ text }), null, `não é descadastro: ${text}`);
assert.equal(normalizeOptOutText("  NÃO quero... mais RECEBER 🙅‍♂️ "), "nao quero mais receber");

// 3. Botão de resposta rápida: só o payload OPT_OUT_MARKETING, com ou sem texto junto.
assert.deepEqual(classifyInboundConsent({ buttonPayload: "OPT_OUT_MARKETING" }), { status: MarketingConsentStatus.DESCADASTRO, source: MarketingConsentSource.WHATSAPP_BOTAO });
assert.deepEqual(classifyInboundConsent({ buttonPayload: "OPT_OUT_MARKETING", text: "Quero receber os boletins da Demetra" }), { status: MarketingConsentStatus.DESCADASTRO, source: MarketingConsentSource.WHATSAPP_BOTAO });
assert.equal(classifyInboundConsent({ buttonPayload: "OUTRO_BOTAO" }), null);
assert.equal(classifyInboundConsent({ buttonPayload: "opt_out_marketing" }), null, "payload exato");

// 4. Parser da Meta: botão de modelo (type "button") traz o payload; texto continua igual.
const provider = new MetaWhatsAppCloudProvider();
const parsed = provider.parseEvents({
  entry: [{ changes: [{ field: "messages", value: {
    metadata: { phone_number_id: "conta-ficticia" },
    contacts: [{ wa_id: PHONE_A, profile: { name: "Contato Ficticio" } }],
    messages: [
      { from: PHONE_A, id: "wamid.ficticio.1", timestamp: "1793000000", type: "button", button: { payload: "OPT_OUT_MARKETING", text: "Não quero receber" } },
      { from: PHONE_A, id: "wamid.ficticio.2", timestamp: "1793000001", type: "text", text: { body: "Quero receber os boletins da Demetra" } },
    ],
  } }] }],
});
assert.equal(parsed[0].buttonPayload, "OPT_OUT_MARKETING");
assert.equal(parsed[0].textContent, undefined);
assert.equal(parsed[1].buttonPayload, undefined);
assert.equal(parsed[1].textContent, "Quero receber os boletins da Demetra");

// 5. Regra "pode receber marketing?": só quando o registro mais recente é ACEITE.
{
  const db = fakeDb();
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", PHONE_A), false, "sem registro: não recebe");
  await recordMarketingConsent(db as any, { tenantId: "tenant-a", phone: PHONE_A, clientId: null, status: MarketingConsentStatus.ACEITE, source: MarketingConsentSource.VENDEDOR_MANUAL });
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", PHONE_A), true, "aceite: recebe");
  await recordMarketingConsent(db as any, { tenantId: "tenant-a", phone: PHONE_A, clientId: null, status: MarketingConsentStatus.DESCADASTRO, source: MarketingConsentSource.WHATSAPP_PALAVRA });
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", PHONE_A), false, "aceite → descadastro: não recebe");
  await recordMarketingConsent(db as any, { tenantId: "tenant-a", phone: PHONE_A, clientId: null, status: MarketingConsentStatus.ACEITE, source: MarketingConsentSource.WHATSAPP_LINK });
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", PHONE_A), true, "aceite → descadastro → aceite: recebe");
  assert.equal(db.events.length, 3, "histórico nunca é apagado");

  // Mesmo telefone em formatos diferentes (com +, com máscara, celular antigo sem o nono dígito).
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", "+55 (11) 90000-0001"), true);
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", "551100000001"), false, "fixo é outro telefone");
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", "55110000001"), false, "telefone inválido nunca recebe");
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", PHONE_B), false, "outro telefone");

  // Filtro por tenant: o aceite de um tenant não vale no outro.
  assert.equal(await canReceiveMarketing(db as any, "tenant-b", PHONE_A), false, "aceite é por tenant");
  assert.equal(await canReceiveMarketing(db as any, "", PHONE_A), false, "sem tenant nunca recebe");

  // Registros no mesmo milissegundo: o último gravado (id maior) decide.
  db.sameInstant = true;
  await recordMarketingConsent(db as any, { tenantId: "tenant-a", phone: PHONE_B, clientId: null, status: MarketingConsentStatus.ACEITE, source: MarketingConsentSource.OUTRO });
  await recordMarketingConsent(db as any, { tenantId: "tenant-a", phone: PHONE_B, clientId: null, status: MarketingConsentStatus.DESCADASTRO, source: MarketingConsentSource.OUTRO });
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", PHONE_B), false);
}

// 6. Registro com cliente: evento "comentario" na linha do tempo, sem telefone e sem a observação.
{
  const db = fakeDb({ clients: [{ id: "client-1", tenantId: "tenant-a", ownerSellerId: "seller-1", isArchived: false }] });
  const result = await recordMarketingConsent(db as any, {
    tenantId: "tenant-a", phone: PHONE_A, clientId: "client-1", status: MarketingConsentStatus.ACEITE,
    source: MarketingConsentSource.VENDEDOR_MANUAL, note: "Pediu na visita", recordedBy: { id: "seller-1", name: "Vendedor Ficticio" },
  });
  assert.equal(result.clientId, "client-1");
  assert.equal(db.events[0].recordedById, "seller-1");
  assert.equal(db.events[0].note, "Pediu na visita");
  assert.equal(db.timeline.length, 1);
  assert.equal(db.timeline[0].type, "comentario");
  assert.equal(db.timeline[0].ownerSellerId, "seller-1");
  assert.equal(db.timeline[0].description, "Aceite dos boletins WhatsApp registrado por Vendedor Ficticio (Vendedor (manual)).");
  assert.doesNotMatch(db.timeline[0].description, /\d{4}|Pediu/, "linha do tempo sem telefone e sem observação");

  // Cliente de outro tenant não é ligado: grava só pelo telefone e não escreve linha do tempo.
  const crossTenant = await recordMarketingConsent(db as any, { tenantId: "tenant-b", phone: PHONE_A, clientId: "client-1", status: MarketingConsentStatus.DESCADASTRO, source: MarketingConsentSource.OUTRO });
  assert.equal(crossTenant.clientId, null);
  assert.equal(db.events[1].clientId, null);
  assert.equal(db.timeline.length, 1);

  await assert.rejects(recordMarketingConsent(db as any, { tenantId: "tenant-a", phone: "123", clientId: null, status: MarketingConsentStatus.ACEITE, source: MarketingConsentSource.OUTRO }), /Telefone inválido/);
}
assert.equal(consentTimelineDescription(MarketingConsentStatus.DESCADASTRO, MarketingConsentSource.WHATSAPP_BOTAO), "Descadastro dos boletins WhatsApp recebido pelo WhatsApp oficial (Botão no WhatsApp).");

// 7. Webhook de entrada: liga ao cliente pelo ClientPhoneIndex do mesmo tenant; nenhum ou mais de um → sem cliente.
{
  const db = fakeDb({
    clients: [
      { id: "client-1", tenantId: "tenant-a", ownerSellerId: "seller-1", isArchived: false },
      { id: "client-2", tenantId: "tenant-a", ownerSellerId: "seller-2", isArchived: false },
      { id: "client-3", tenantId: "tenant-a", ownerSellerId: "seller-2", isArchived: false },
      { id: "client-arquivado", tenantId: "tenant-a", ownerSellerId: "seller-1", isArchived: true },
      { id: "client-outro-tenant", tenantId: "tenant-b", ownerSellerId: "seller-9", isArchived: false },
    ],
    phoneIndex: [
      { phone: PHONE_A, clientId: "client-1" },
      { phone: PHONE_A, clientId: "client-arquivado" },
      { phone: PHONE_A, clientId: "client-outro-tenant" },
      { phone: PHONE_B, clientId: "client-2" },
      { phone: PHONE_B, clientId: "client-3" },
    ],
  });
  // Meta manda "+55..." já normalizado; celular antigo pode vir sem o nono dígito.
  assert.equal(await processInboundMarketingConsent(db as any, { tenantId: "tenant-a", phone: "+5511900000001", text: "Quero receber os boletins da Demetra" }), "accepted");
  assert.equal(db.events[0].clientId, "client-1", "único cliente ativo do tenant");
  assert.equal(db.events[0].phone, PHONE_A);
  assert.equal(db.events[0].source, "WHATSAPP_LINK");
  assert.equal(db.events[0].recordedById, null);
  assert.equal(db.timeline[0].ownerSellerId, "seller-1");

  assert.equal(await processInboundMarketingConsent(db as any, { tenantId: "tenant-a", phone: "+5511900000002", text: "parar" }), "opted_out");
  assert.equal(db.events[1].clientId, null, "telefone em dois clientes: grava sem cliente");
  assert.equal(db.events[1].phone, PHONE_B);

  assert.equal(await processInboundMarketingConsent(db as any, { tenantId: "tenant-a", phone: "+5511900000003", buttonPayload: "OPT_OUT_MARKETING" }), "opted_out");
  assert.equal(db.events[2].clientId, null, "telefone sem cliente: grava sem cliente");
  assert.equal(db.events[2].source, "WHATSAPP_BOTAO");

  assert.equal(await processInboundMarketingConsent(db as any, { tenantId: "tenant-b", phone: PHONE_A, text: "sair" }), "opted_out");
  assert.equal(db.events[3].clientId, "client-outro-tenant", "cada tenant liga ao próprio cliente");
  assert.equal(db.events[3].tenantId, "tenant-b");

  // Celular antigo sem o nono dígito cai no mesmo telefone (55 + DDD + 9 + número).
  assert.equal(await processInboundMarketingConsent(db as any, { tenantId: "tenant-a", phone: "+551187650003", text: "Quero receber os boletins da Demetra" }), "accepted");
  assert.equal(db.events[4].phone, PHONE_C);
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", PHONE_C), true);
  assert.equal(await processInboundMarketingConsent(db as any, { tenantId: "tenant-a", phone: PHONE_A, text: "olá" }), "ignored", "mensagem comum");
  assert.equal(await processInboundMarketingConsent(db as any, { tenantId: "tenant-a", phone: "+55110000001", text: "parar" }), "ignored", "telefone inválido");
  assert.equal(await processInboundMarketingConsent(db as any, { tenantId: null, phone: PHONE_A, text: "parar" }), "ignored", "sem tenant");
  assert.equal(db.events.length, 5, "mensagens comuns, telefone inválido e sem tenant não gravam nada");
  assert.equal(await canReceiveMarketing(db as any, "tenant-a", PHONE_A), true);
  assert.equal(await canReceiveMarketing(db as any, "tenant-b", PHONE_A), false);
}

// 8. Ligação no webhook da Meta: dentro da transação do evento (idempotente: cada evento só é aplicado uma vez),
// só para mensagem recebida; e nenhum log neste módulo (o telefone nunca vai para log).
const integrationSource = readFileSync(new URL("../communications/communicationIntegrationService.ts", import.meta.url), "utf8");
assert.match(integrationSource, /if \(event\.direction === CommunicationDirection\.INBOUND\) await processInboundMarketingConsent\(tx, \{ tenantId: event\.tenantId, phone: normalizedPhone, text: event\.textContent, buttonPayload: event\.buttonPayload \}\);/);
const moduleSource = readFileSync(new URL("./marketingConsent.ts", import.meta.url), "utf8");
assert.doesNotMatch(moduleSource, /logApiEvent|console\./, "módulo de aceite não grava log");

console.log("marketing consent rules: PASS");
