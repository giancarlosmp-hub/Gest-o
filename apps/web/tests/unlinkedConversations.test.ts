import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";

// WhatsApp Fase B2: fila "Conversas não vinculadas" em /whatsapp, renderizada com react-dom/server (só a
// parte visual, sem rede). Números e nomes fictícios.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const RENDER_ENTRY = "\0unlinked-conversations-render";

const testPlugin: Plugin = {
  name: "unlinked-conversations-test",
  enforce: "pre",
  resolveId(source) {
    return source === "virtual:unlinked-conversations-render" ? RENDER_ENTRY : null;
  },
  load(id) {
    if (id !== RENDER_ENTRY) return null;
    return [
      'import { createElement } from "react";',
      'import { renderToStaticMarkup } from "react-dom/server";',
      'import { UnlinkedConversationsView } from "/src/components/whatsapp/UnlinkedConversationsCard.tsx";',
      "const noop = () => undefined;",
      "export const render = (props) => renderToStaticMarkup(createElement(UnlinkedConversationsView, { hasMore: false, busyId: null, linkingId: null, selectedClientId: '', onStartLink: noop, onCancelLink: noop, onSelectClient: noop, onConfirmLink: noop, onDiscard: noop, onLoadMore: noop, ...props }));"
    ].join("\n");
  }
};

// O apiClient lê o armazenamento do navegador ao carregar o módulo.
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

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const items = [
  {
    id: "q-1",
    phone: "(11) 90000-0301",
    pushName: "Contato Ficticio",
    status: "unlinked",
    lastMessage: { text: "Mensagem ficticia recebida", direction: "inbound", at: "2026-11-06T15:30:00.000Z" },
    lastMessageAt: "2026-11-06T15:30:00.000Z",
    expiresAt: "2026-11-12T15:30:00.000Z",
    daysToExpire: 6
  },
  {
    id: "q-2",
    phone: "(11) 90000-0302",
    pushName: null,
    status: "ambiguous",
    lastMessage: { text: "Mensagem ficticia enviada", direction: "outbound", at: "2026-11-06T12:00:00.000Z" },
    lastMessageAt: "2026-11-06T12:00:00.000Z",
    expiresAt: "2026-11-07T12:00:00.000Z",
    daysToExpire: 1
  }
];

try {
  const { render } = await server.ssrLoadModule("virtual:unlinked-conversations-render");

  // 1) Lista: número, pushName, última mensagem (com "Você:" quando enviada), dias para expirar, ações.
  const html = render({ items, total: 2, hasMore: true });
  const text = textOf(html);
  assert.match(html, /id="conversas-nao-vinculadas"/);
  assert.match(html, /data-unlinked-total="2"/);
  assert.match(text, /Conversas não vinculadas/);
  assert.match(text, /\(11\) 90000-0301 No WhatsApp: Contato Ficticio/);
  assert.match(text, /Mensagem ficticia recebida 06\/11 12:30/);
  assert.match(text, /Você: Mensagem ficticia enviada/);
  assert.match(text, /expira em 6 dias/);
  assert.match(text, /expira em 1 dia/);
  assert.match(text, /mais de um cliente/);
  assert.equal((text.match(/Vincular a um cliente/g) ?? []).length, 2);
  assert.equal((text.match(/Descartar/g) ?? []).length, 2);
  assert.match(text, /Carregar mais/);
  assert.match(text, /apagadas em 7 dias/);

  // 2) Vinculando: busca de cliente e confirmação (desabilitada sem cliente escolhido).
  const linking = render({ items, total: 2, linkingId: "q-1" });
  assert.match(linking, /placeholder="Buscar cliente..."/);
  assert.match(textOf(linking), /Confirmar vínculo/);
  assert.match(linking, /<button[^>]*disabled=""[^>]*>Confirmar vínculo/);
  assert.equal((textOf(linking).match(/Vincular a um cliente/g) ?? []).length, 1);
  assert.doesNotMatch(render({ items, total: 2, linkingId: "q-1", selectedClientId: "client-a" }), /<button[^>]*disabled=""[^>]*>Confirmar vínculo/);
  assert.match(textOf(render({ items, total: 2, linkingId: "q-1", selectedClientId: "client-a", busyId: "q-1" })), /Vinculando/);

  // 3) Vazia.
  assert.match(textOf(render({ items: [], total: 0 })), /Nenhuma conversa aguardando vínculo/);

  // 4) Só leitura de mensagem: nada de envio.
  assert.doesNotMatch(text, /Enviar|Responder/i);

  console.log("unlinked conversations tests passed");
} finally {
  await server.close();
}
