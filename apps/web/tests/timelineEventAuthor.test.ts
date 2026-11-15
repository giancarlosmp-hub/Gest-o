import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";

// Dados fictícios: linha do tempo do cliente depois da troca de vendedor, renderizada com react-dom/server. A API
// devolve eventos de oportunidades que o vendedor novo não pode abrir; a lista mostra o autor de cada evento e não
// cria link (nem mostra título) de nenhuma oportunidade.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const RENDER_ENTRY = "\0timeline-event-author-render";

const testPlugin: Plugin = {
  name: "timeline-event-author-test",
  enforce: "pre",
  resolveId(source) {
    return source === "virtual:timeline-event-author-render" ? RENDER_ENTRY : null;
  },
  load(id) {
    if (id !== RENDER_ENTRY) return null;
    return [
      'import { createElement } from "react";',
      'import { renderToStaticMarkup } from "react-dom/server";',
      'import TimelineEventList from "/src/components/TimelineEventList.tsx";',
      "export const render = (props) => renderToStaticMarkup(createElement(TimelineEventList, props));"
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

const events = [
  {
    id: "ev-b1", type: "comentario", description: "Comentario ficticio do vendedor novo", createdAt: "2026-01-10T12:05:00.000Z",
    ownerSeller: { id: "seller-b", name: "Vendedor Ficticio B" },
    opportunity: { id: "opp-nova", title: "Oportunidade ficticia nova" }
  },
  {
    id: "ev-a1", type: "status", description: "Status ficticio do vendedor antigo", createdAt: "2026-01-10T12:01:00.000Z",
    ownerSeller: { id: "seller-a", name: "Vendedor Ficticio A" },
    opportunity: { id: "opp-antiga", title: "Oportunidade ficticia antiga" }
  },
  { id: "ev-sis", type: "status", description: "Registro ficticio sem autor", createdAt: "2026-01-10T12:00:00.000Z", ownerSeller: null }
];

try {
  const { render } = await server.ssrLoadModule("virtual:timeline-event-author-render");
  const html: string = render({ events });

  // Autor preservado em cada evento, inclusive os do vendedor anterior.
  assert.match(html, /por Vendedor Ficticio B/);
  assert.match(html, /por Vendedor Ficticio A/);
  assert.match(html, /por Sistema/);
  assert.match(html, /Status ficticio do vendedor antigo/);

  // Nenhum link nem título de oportunidade: o vendedor novo não recebe atalho para a oportunidade antiga.
  assert.doesNotMatch(html, /<a\b/);
  assert.doesNotMatch(html, /\/opportunities\//);
  assert.doesNotMatch(html, /Oportunidade ficticia antiga/);

  console.log("TIMELINE_EVENT_AUTHOR=PASS");
} finally {
  await server.close();
}
