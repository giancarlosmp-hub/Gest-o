import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";

// WhatsApp Fase C (C2): painel de Configurações do envio pelo CRM, renderizado com react-dom/server (sem rede).
// Só dados fictícios.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const RENDER_ENTRY = "\0whatsapp-crm-send-panel-render";

const testPlugin: Plugin = {
  name: "whatsapp-crm-send-panel-test",
  enforce: "pre",
  resolveId(source) {
    return source === "virtual:whatsapp-crm-send-panel-render" ? RENDER_ENTRY : null;
  },
  load(id) {
    if (id !== RENDER_ENTRY) return null;
    return [
      'import { createElement } from "react";',
      'import { renderToStaticMarkup } from "react-dom/server";',
      'import { WhatsAppCrmSendPanelView } from "/src/components/settings/WhatsAppCrmSendPanel.tsx";',
      "const noop = () => undefined;",
      "export const renderPanel = (props) => renderToStaticMarkup(createElement(WhatsAppCrmSendPanelView, { status: null, canEdit: false, saving: false, error: null, onToggle: noop, ...props }));"
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
const limits = { perMinute: 6, perDay: 150, firstContactsPerDay: 20, maxTextLength: 4000 };

try {
  const mod = await server.ssrLoadModule("virtual:whatsapp-crm-send-panel-render");

  // 1) Texto com os limites (vindos da API) e o risco de bloqueio; diretor edita.
  const off = mod.renderPanel({ status: { enabled: false, available: true, limits }, canEdit: true });
  const offText = textOf(off);
  for (const expected of ["Até 6 mensagens por minuto", "Até 150 mensagens por dia", "Até 20 primeiros contatos por dia", "4.000 caracteres", "Risco de bloqueio", "Envio pelo CRM desligado"]) {
    assert.ok(offText.includes(expected), `painel sem "${expected}"`);
  }
  assert.match(off, /type="checkbox"/);
  assert.doesNotMatch(off, /<input[^>]*disabled=""/);

  // 2) Gerente vê, não edita.
  const manager = mod.renderPanel({ status: { enabled: true, available: true, limits }, canEdit: false });
  assert.match(manager, /<input[^>]*disabled=""/);
  assert.match(textOf(manager), /Somente o diretor altera esta opção/);
  assert.match(textOf(manager), /Envio pelo CRM ligado/);

  // 3) Ligado sem infraestrutura: aviso de indisponível; erro da API aparece; carregando.
  assert.match(textOf(mod.renderPanel({ status: { enabled: true, available: false, limits }, canEdit: true })), /indisponível agora/);
  assert.match(mod.renderPanel({ error: "Você não tem permissão para executar esta ação." }), /role="alert"/);
  assert.match(textOf(mod.renderPanel({})), /Carregando/);

  console.log("whatsapp crm send panel tests passed");
} finally {
  await server.close();
}
