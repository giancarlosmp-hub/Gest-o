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
    return ['export * from "/src/lib/whatsappInbox.ts";'].join("\n");
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

  console.log("whatsapp inbox tests passed");
} finally {
  await server.close();
}
