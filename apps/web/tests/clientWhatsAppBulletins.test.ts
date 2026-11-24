import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";

// Card "Boletins WhatsApp" da ficha do cliente renderizado com react-dom/server pelo próprio Vite.
// Só a parte visual (ClientWhatsAppBulletinsView): nenhuma chamada de rede. Telefones e culturas fictícios.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const RENDER_ENTRY = "\0client-whatsapp-bulletins-render";

const testPlugin: Plugin = {
  name: "client-whatsapp-bulletins-test",
  enforce: "pre",
  resolveId(source) {
    return source === "virtual:client-whatsapp-bulletins-render" ? RENDER_ENTRY : null;
  },
  load(id) {
    if (id !== RENDER_ENTRY) return null;
    return [
      'import { createElement } from "react";',
      'import { renderToStaticMarkup } from "react-dom/server";',
      'import { ClientWhatsAppBulletinsView } from "/src/components/clients/ClientWhatsAppBulletinsCard.tsx";',
      "const noop = () => undefined;",
      "export const render = (props) => renderToStaticMarkup(createElement(ClientWhatsAppBulletinsView, { draft: null, selectedCultureIds: [], culturesDirty: false, saving: false, onStartDraft: noop, onDraftChange: noop, onCancelDraft: noop, onSubmitDraft: noop, onToggleCulture: noop, onSaveCultures: noop, ...props }));"
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

const phones = [
  {
    phoneRef: "idx-1",
    display: "(11) 90000-0001",
    sources: ["erp", "crm"],
    current: { status: "ACEITE", source: "WHATSAPP_LINK", createdAt: "2026-11-20T13:00:00.000Z" },
    canReceive: true,
    history: [
      { id: "e2", status: "ACEITE", source: "WHATSAPP_LINK", note: null, createdAt: "2026-11-20T13:00:00.000Z", recordedByName: null },
      { id: "e1", status: "DESCADASTRO", source: "VENDEDOR_MANUAL", note: "Pediu para parar", createdAt: "2026-11-10T13:00:00.000Z", recordedByName: "Vendedor Ficticio" }
    ]
  },
  { phoneRef: "idx-2", display: "(11) 3000-0001", sources: ["crm"], current: null, canReceive: false, history: [] },
  {
    phoneRef: null,
    display: "(11) 90000-0009",
    sources: [],
    current: { status: "DESCADASTRO", source: "WHATSAPP_BOTAO", createdAt: "2026-11-21T13:00:00.000Z" },
    canReceive: false,
    history: [{ id: "e3", status: "DESCADASTRO", source: "WHATSAPP_BOTAO", note: null, createdAt: "2026-11-21T13:00:00.000Z", recordedByName: null }]
  }
];
const cultures = {
  selected: [{ id: "c-soja", label: "Soja", isActive: true }, { id: "c-velha", label: "Cultura Antiga", isActive: false }],
  options: [{ id: "c-soja", label: "Soja", category: "Grãos" }, { id: "c-trigo", label: "Trigo", category: "Grãos" }]
};

try {
  const mod = await server.ssrLoadModule("virtual:client-whatsapp-bulletins-render");

  // Carregando e sem telefone.
  const loading = mod.render({ phones: null, cultures: null });
  assert.match(loading, /Boletins WhatsApp/);
  assert.match(loading, /Carregando telefones/);
  assert.match(loading, /Carregando culturas/);
  assert.match(mod.render({ phones: [], cultures }), /Nenhum telefone do ERP ou dos contatos deste cliente/);
  assert.match(mod.render({ phones: null, phonesError: "Cliente não encontrado.", cultures: null }), /Cliente não encontrado\./);

  const html = mod.render({ phones, cultures, selectedCultureIds: ["c-soja", "c-velha"] });
  // Situação atual por telefone.
  assert.match(html, /\(11\) 90000-0001/);
  assert.match(html, />ERP</);
  assert.match(html, />Contato</);
  assert.match(html, />Aceite<\/span>/);
  assert.match(html, />Sem registro<\/span>/);
  assert.match(html, />Descadastro<\/span>/);
  assert.match(html, /Link de aceite no WhatsApp · 20\/11\/2026, 10:00/, "data no horário de Brasília");
  // Botões só para telefones do cadastro do cliente (referência do índice).
  assert.equal(html.match(/Registrar aceite/g)?.length, 2);
  assert.equal(html.match(/Registrar descadastro/g)?.length, 2);
  assert.match(html, /Telefone fora do cadastro atual do cliente: só o histórico\./);
  // Histórico recolhido (details sem open), mais recente primeiro, com quem registrou e observação.
  assert.match(html, /<details class="mt-2 text-sm"><summary[^>]*>Histórico \(2\)<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /Descadastro<\/span> · Vendedor \(manual\) · 10\/11\/2026, 10:00 · Vendedor Ficticio/);
  assert.match(html, /Pediu para parar/);
  // Culturas: opções ativas do catálogo + a inativa já ligada, marcadas conforme a seleção.
  assert.match(html, /Culturas do cliente/);
  assert.match(html, /checked=""[^>]*\/>Soja/);
  assert.match(html, /Cultura Antiga \(inativa\)/);
  assert.doesNotMatch(html, /checked=""[^>]*\/>Trigo/);
  assert.doesNotMatch(html, /Salvar culturas/, "botão só com mudança");
  assert.match(mod.render({ phones, cultures, selectedCultureIds: ["c-trigo"], culturesDirty: true }), /Salvar culturas/);

  // Formulário de registro: origem (5 opções) e observação (até 280), só no telefone em edição.
  const form = mod.render({ phones, cultures, draft: { phoneRef: "idx-2", status: "DESCADASTRO", source: "VENDEDOR_MANUAL", note: "" } });
  assert.match(form, /Registrar descadastro dos boletins/);
  assert.equal(form.match(/<option /g)?.length, 5);
  assert.match(form, /<option value="VENDEDOR_MANUAL" selected="">Vendedor \(manual\)<\/option>/);
  assert.match(form, /maxLength="280"/);
  assert.equal(form.match(/Registrar aceite<\/button>/g)?.length, 1, "o telefone em edição troca os botões pelo formulário");

  console.log("client whatsapp bulletins card tests passed");
} finally {
  await server.close();
}
