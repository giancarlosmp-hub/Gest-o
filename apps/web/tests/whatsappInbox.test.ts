import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";

// WhatsApp Fase C (C2): caixa de conversas e envio pelo CRM em /whatsapp. Funções da lib e telas renderizadas
// com react-dom/server (sem rede). Só dados fictícios.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const RENDER_ENTRY = "\0whatsapp-inbox-render";

const testPlugin: Plugin = {
  name: "whatsapp-inbox-test",
  enforce: "pre",
  resolveId(source) {
    return source === "virtual:whatsapp-inbox-render" ? RENDER_ENTRY : null;
  },
  load(id) {
    if (id !== RENDER_ENTRY) return null;
    return [
      'import { createElement } from "react";',
      'import { renderToStaticMarkup } from "react-dom/server";',
      'import { WhatsAppInboxListView } from "/src/components/whatsapp/WhatsAppInbox.tsx";',
      'import { WhatsAppConversationView } from "/src/components/whatsapp/WhatsAppConversation.tsx";',
      'import { WhatsAppReplyBoxView } from "/src/components/whatsapp/WhatsAppReplyBox.tsx";',
      'export * from "/src/lib/whatsappInbox.ts";',
      "const noop = () => undefined;",
      "export const renderList = (props) => renderToStaticMarkup(createElement(WhatsAppInboxListView, { scope: 'mine', showTeam: false, items: [], selectedId: null, loading: false, error: false, hasMore: false, unreadTotal: 0, onScope: noop, onSelect: noop, onLoadMore: noop, ...props }));",
      "export const renderConversation = (props) => renderToStaticMarkup(createElement(WhatsAppConversationView, { title: 'Cliente Ficticio', messages: [], loading: false, error: null, hasOlder: false, onLoadOlder: noop, ...props }));",
      "export const renderReply = (props) => renderToStaticMarkup(createElement(WhatsAppReplyBoxView, { text: '', sending: false, generating: false, canGenerate: true, canSend: false, blockedReason: null, feedback: null, status: null, onText: noop, onGenerate: noop, onSend: noop, ...props }));"
    ].join("\n");
  }
};

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; }
  };
};
for (const name of ["localStorage", "sessionStorage"]) {
  if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value: memoryStorage(), configurable: true });
}

const server = await createServer({
  root: webRoot,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, watch: null },
  plugins: [testPlugin]
});

const message = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
  id,
  direction: "inbound",
  type: "TEXT",
  text: `Mensagem ficticia ${id}`,
  at,
  origin: "received",
  edited: false,
  editedTextUnavailable: false,
  deletedInWhatsApp: false,
  transcription: null,
  ...extra
});

try {
  const mod = await server.ssrLoadModule("virtual:whatsapp-inbox-render");

  // 1) Junção incremental: a versão nova vence, ordem de envio, sem duplicar.
  const merged = mod.mergeMessages(
    [message("m1", "2026-11-10T12:00:00.000Z"), message("m2", "2026-11-10T12:01:00.000Z")],
    [message("m2", "2026-11-10T12:01:00.000Z", { edited: true, text: "Texto editado ficticio" }), message("m3", "2026-11-10T12:00:30.000Z")]
  );
  assert.deepEqual(merged.map((item: { id: string }) => item.id), ["m1", "m3", "m2"]);
  assert.equal(merged[2].text, "Texto editado ficticio");
  const same = [message("m1", "2026-11-10T12:00:00.000Z")];
  assert.equal(mod.mergeMessages(same, []), same);

  // 2) Envio: 201 é sucesso; 202 "uncertain" não é; erro com a mensagem da API como veio; sem resposta = incerto.
  const sent = mod.sendOutcomeFromResponse({ conversationId: "conv-1", message: message("m9", "2026-11-10T12:05:00.000Z") });
  assert.equal(sent.ok, true);
  const uncertain = mod.sendOutcomeFromResponse({ message: "Pode ter sido enviada. Confira no celular antes de reenviar.", code: "uncertain" });
  assert.deepEqual(uncertain, { ok: false, uncertain: true, message: "Pode ter sido enviada. Confira no celular antes de reenviar." });
  const limit = mod.sendOutcomeFromError({ response: { status: 429, data: { message: "Limite diário de envios atingido (150).", code: "rate_day" } } });
  assert.deepEqual(limit, { ok: false, uncertain: false, message: "Limite diário de envios atingido (150)." });
  const noWhatsApp = mod.sendOutcomeFromError({ response: { status: 422, data: { message: "Este número não tem WhatsApp.", code: "number_not_on_whatsapp" } } });
  assert.equal(noWhatsApp.message, "Este número não tem WhatsApp.");
  const timeout = mod.sendOutcomeFromError(new Error("timeout of 15000ms exceeded"));
  assert.equal(timeout.uncertain, true);
  assert.match(timeout.message, /Confira no celular antes de reenviar/);

  // 3) Telefone do ERP → destino do CRM, pelo número; caminho da conversa existente ou nova.
  const targets = [
    { ref: "ref-a", display: "(11) 90000-0101", kind: "mobile", source: "erp", conversationId: null, unreadCount: 0 },
    { ref: "ref-b", display: "(11) 3000-0102", kind: "landline", source: "erp", conversationId: "conv-b", unreadCount: 2 }
  ];
  assert.equal(mod.findPhoneTarget(targets, "(11) 90000-0101")?.ref, "ref-a");
  assert.equal(mod.findPhoneTarget(targets, "(11) 90000-0999"), null);
  assert.equal(mod.findPhoneTarget(null, "(11) 90000-0101"), null);
  assert.equal(mod.conversationPath({ clientId: "client-1", target: targets[1] }), "/whatsapp?conversationId=conv-b");
  assert.equal(mod.conversationPath({ clientId: "client-1", target: targets[0] }), "/whatsapp?clientId=client-1&phoneRef=ref-a");

  // 4) Trecho da última mensagem e rótulo de mídia.
  assert.equal(mod.lastMessagePreview({ lastMessage: { direction: "inbound", type: "TEXT", text: "Olá ficticio", viaCrm: false } }), "Olá ficticio");
  assert.equal(mod.lastMessagePreview({ lastMessage: { direction: "outbound", type: "TEXT", text: "Bom dia", viaCrm: true } }), "Você (CRM): Bom dia");
  assert.equal(mod.lastMessagePreview({ lastMessage: { direction: "outbound", type: "TEXT", text: "Bom dia", viaCrm: false } }), "Você: Bom dia");
  assert.equal(mod.lastMessagePreview({ lastMessage: null }), "");
  assert.equal(mod.messageBodyLabel({ type: "IMAGE", text: "" }), "[imagem]");
  assert.equal(mod.messageBodyLabel({ type: "IMAGE", text: "[imagem] legenda ficticia" }), "[imagem] legenda ficticia");

  // 5) Campo de resposta: até 4.000 caracteres, uma ação por vez, só com o envio ligado e conectado.
  const ready = { sendEnabled: true, connected: true };
  assert.equal(mod.remainingChars("abc"), 3997);
  assert.equal(mod.canSendText({ status: ready, canReply: true, text: "Olá", sending: false }), true);
  assert.equal(mod.canSendText({ status: ready, canReply: true, text: "Olá", sending: true }), false);
  assert.equal(mod.canSendText({ status: ready, canReply: true, text: "   ", sending: false }), false);
  assert.equal(mod.canSendText({ status: ready, canReply: true, text: "x".repeat(4001), sending: false }), false);
  assert.equal(mod.canSendText({ status: ready, canReply: true, text: "x".repeat(4000), sending: false }), true);
  assert.equal(mod.canSendText({ status: { sendEnabled: false, connected: true }, canReply: true, text: "Olá", sending: false }), false);
  assert.equal(mod.canSendText({ status: ready, canReply: false, text: "Olá", sending: false }), false);
  const status = { sendEnabled: true, connected: true, available: true, enabled: true };
  assert.match(mod.replyBlockedReason({ status, own: false, canReply: false }), /Somente leitura/);
  assert.match(mod.replyBlockedReason({ status: { ...status, enabled: false, sendEnabled: false }, own: true, canReply: true }), /desligado/);
  assert.match(mod.replyBlockedReason({ status: { ...status, connected: false }, own: true, canReply: true }), /não está conectado/);
  assert.equal(mod.replyBlockedReason({ status, own: true, canReply: true }), null);

  // 6) Lista: "Meu número" com não lidas e trecho; "Equipe" só para gestão, com o dono do número.
  const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const item = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    client: { id: `client-${id}`, name: `Cliente Ficticio ${id}` },
    contactDisplay: "(11) 9****-0101",
    lastMessageAt: "2026-11-10T15:00:00.000Z",
    unreadCount: 0,
    numberOwner: { id: "seller-a", name: "Vendedor Ficticio A" },
    own: true,
    canReply: true,
    lastMessage: { direction: "inbound", type: "TEXT", text: "Pode mandar a proposta?", viaCrm: false },
    ...extra
  });
  const mine = mod.renderList({ items: [item("c1", { unreadCount: 3 }), item("c2")], unreadTotal: 3, selectedId: "c2" });
  assert.match(textOf(mine), /Meu número 3/);
  assert.doesNotMatch(mine, /Equipe/);
  assert.match(mine, /aria-label="3 não lidas"/);
  assert.match(textOf(mine), /Cliente Ficticio c1 .*10\/11 12:00/);
  assert.match(textOf(mine), /Pode mandar a proposta\?/);
  assert.match(mine, /data-inbox-item="c2" aria-current="true"|aria-current="true"[^>]*data-inbox-item="c2"/);
  assert.doesNotMatch(textOf(mine), /número de Vendedor Ficticio A/);
  const team = mod.renderList({ scope: "team", showTeam: true, items: [item("c3", { own: false, canReply: false })] });
  assert.match(textOf(team), /Equipe/);
  assert.match(textOf(team), /Somente leitura/);
  assert.match(textOf(team), /número de Vendedor Ficticio A/);
  assert.match(textOf(mod.renderList({})), /Nenhuma conversa vinculada no seu número/);
  assert.match(textOf(mod.renderList({ error: true })), /Não foi possível carregar as conversas/);

  // 7) Conversa: texto, origem, marcas, transcrição, mídia como rótulo; somente leitura; conversa nova vazia.
  const thread = mod.renderConversation({
    subtitle: "(11) 9****-0101",
    hasOlder: true,
    messages: [
      message("t1", "2026-11-10T12:00:00.000Z", { text: "Bom dia, tudo bem?" }),
      message("t2", "2026-11-10T12:01:00.000Z", { direction: "outbound", origin: "app", text: "Tudo sim", edited: true }),
      message("t3", "2026-11-10T12:02:00.000Z", { direction: "outbound", origin: "crm", text: "Segue a proposta ficticia" }),
      message("t4", "2026-11-10T12:03:00.000Z", { type: "AUDIO", text: "[áudio 0:42]", transcription: { status: "done", text: "Transcrição ficticia do áudio" } }),
      message("t5", "2026-11-10T12:04:00.000Z", { type: "IMAGE", text: "" }),
      message("t6", "2026-11-10T12:05:00.000Z", { deletedInWhatsApp: true, text: "Mensagem ficticia apagada" }),
      message("t7", "2026-11-10T12:06:00.000Z", { editedTextUnavailable: true })
    ]
  });
  const threadText = textOf(thread);
  for (const expected of ["recebida", "via app", "via CRM", "editada", "🎤 0:42", "transcrição automática", "Transcrição ficticia do áudio", "[imagem]", "apagada no WhatsApp", "texto novo não disponível", "Mensagens anteriores", "10/11 09:00"]) {
    assert.ok(threadText.includes(expected), `conversa sem "${expected}"`);
  }
  assert.doesNotMatch(thread, /data-inbox-read-only/);
  const readOnly = mod.renderConversation({ readOnlyNote: "Somente leitura: conversa do número de outro usuário. Abrir não marca como lida." });
  assert.match(readOnly, /data-inbox-read-only/);
  assert.doesNotMatch(readOnly, /textarea/);
  assert.match(textOf(mod.renderConversation({ emptyText: "Nenhuma mensagem ainda. A conversa é criada no primeiro envio." })), /criada no primeiro envio/);

  // 8) Campo de resposta: contador, IA, envio, erro da API como veio, incerto como aviso, bloqueado sem campo.
  const limits = { perMinute: 6, perDay: 150, firstContactsPerDay: 20, maxTextLength: 4000 };
  const reply = mod.renderReply({ text: "Olá, tudo bem?", canSend: true, status: { limits, today: { total: 7, firstContacts: 2 } } });
  assert.match(reply, /maxLength="4000"/);
  assert.match(textOf(reply), /3986 caracteres restantes/);
  assert.match(textOf(reply), /Gerar mensagem IA/);
  assert.match(textOf(reply), /Hoje: 7 de 150 envios · 2 de 20 primeiros contatos/);
  assert.doesNotMatch(reply, /<button[^>]*disabled=""[^>]*>.*Enviar/);
  const sendingHtml = mod.renderReply({ text: "Olá", canSend: true, sending: true });
  assert.match(textOf(sendingHtml), /Enviando\.\.\./);
  assert.match(sendingHtml, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Gerar mensagem IA/);
  const limitHtml = mod.renderReply({ feedback: { tone: "error", message: "Limite diário de envios atingido (150)." } });
  assert.match(limitHtml, /role="alert"/);
  assert.match(textOf(limitHtml), /Limite diário de envios atingido \(150\)\./);
  const uncertainHtml = mod.renderReply({ feedback: { tone: "warning", message: "Pode ter sido enviada. Confira no celular antes de reenviar." } });
  assert.match(uncertainHtml, /data-inbox-reply-feedback="warning"/);
  const blocked = mod.renderReply({ blockedReason: "Envio pelo CRM desligado. Responda pelo celular." });
  assert.match(blocked, /data-inbox-reply-blocked/);
  assert.doesNotMatch(blocked, /textarea/);
  assert.doesNotMatch(textOf(mod.renderReply({ canGenerate: false })), /Gerar mensagem IA/);

  console.log("whatsapp inbox tests passed");
} finally {
  await server.close();
}
