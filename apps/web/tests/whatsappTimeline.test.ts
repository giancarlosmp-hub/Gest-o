import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";

// WhatsApp Fase B2: cartões "WhatsApp · dd/mm" intercalados na linha do tempo do cliente e da oportunidade.
// Intercalação por data com as duas listas paginadas e o cartão renderizado com react-dom/server (sem rede).
// Só dados fictícios.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const RENDER_ENTRY = "\0whatsapp-timeline-render";

const testPlugin: Plugin = {
  name: "whatsapp-timeline-test",
  enforce: "pre",
  resolveId(source) {
    return source === "virtual:whatsapp-timeline-render" ? RENDER_ENTRY : null;
  },
  load(id) {
    if (id !== RENDER_ENTRY) return null;
    return [
      'import { createElement } from "react";',
      'import { renderToStaticMarkup } from "react-dom/server";',
      'import TimelineEventList from "/src/components/TimelineEventList.tsx";',
      'import { WhatsAppDayCardView } from "/src/components/whatsapp/WhatsAppDayCard.tsx";',
      'export * from "/src/lib/whatsappMessages.ts";',
      "const noop = () => undefined;",
      "export const renderCard = (props) => renderToStaticMarkup(createElement(WhatsAppDayCardView, { onToggle: noop, onLoadMore: noop, loading: false, error: false, hasMore: false, messages: [], open: false, ...props }));",
      "export const renderList = (props) => renderToStaticMarkup(createElement(TimelineEventList, { onLoadMore: noop, ...props }));"
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
const card = (day: string, lastAt: string, extra: Record<string, unknown> = {}) => ({
  day,
  conversationId: `conv-${day}`,
  total: 3,
  inbound: 2,
  outbound: 1,
  firstAt: lastAt,
  lastAt,
  contactDisplay: "(11) ****-0201",
  numberOwner: { id: "seller-a", name: "Vendedor Ficticio A" },
  ...extra
});
const event = (id: string, createdAt: string) => ({ id, type: "comentario" as const, description: `Interação ficticia ${id}`, createdAt, ownerSeller: null });

try {
  const mod = await server.ssrLoadModule("virtual:whatsapp-timeline-render");

  // 1) Rótulos.
  assert.equal(mod.formatWhatsAppDay("2026-11-05"), "05/11");
  assert.equal(mod.formatWhatsAppTime("2026-11-05T16:30:00.000Z"), "13:30");
  assert.equal(mod.formatBrazilDayMonth("2026-11-06T01:30:00.000Z"), "05/11");
  assert.equal(mod.whatsappOriginLabel({ origin: "app" }), "via app");
  assert.equal(mod.whatsappOriginLabel({ origin: "received" }), "recebida");
  assert.equal(mod.whatsappExpiryLabel(1), "expira em 1 dia");
  assert.equal(mod.whatsappExpiryLabel(6), "expira em 6 dias");
  assert.equal(mod.whatsappExpiryLabel(0), "expira hoje");

  // 2) Intercalação por data, mais recente primeiro.
  const events = [event("e1", "2026-11-06T12:00:00.000Z"), event("e2", "2026-11-03T12:00:00.000Z")];
  const cards = [card("2026-11-05", "2026-11-05T18:00:00.000Z"), card("2026-11-01", "2026-11-01T18:00:00.000Z")];
  const keys = (entries: any[]) => entries.map((entry) => (entry.kind === "event" ? entry.event.id : entry.card.day));
  assert.deepEqual(keys(mod.mergeTimeline({ events, eventsHasMore: false, cards, cardsHasMore: false })), ["e1", "2026-11-05", "e2", "2026-11-01"]);
  // Eventos com mais páginas: nada mais antigo que o último evento carregado aparece ainda.
  assert.deepEqual(keys(mod.mergeTimeline({ events, eventsHasMore: true, cards, cardsHasMore: false })), ["e1", "2026-11-05", "e2"]);
  // Cartões com mais páginas: o mesmo, pelo lado do WhatsApp.
  assert.deepEqual(keys(mod.mergeTimeline({ events, eventsHasMore: false, cards, cardsHasMore: true })), ["e1", "2026-11-05", "e2", "2026-11-01"]);
  assert.deepEqual(keys(mod.mergeTimeline({ events, eventsHasMore: false, cards: cards.slice(0, 1), cardsHasMore: true })), ["e1", "2026-11-05"]);
  assert.deepEqual(keys(mod.mergeTimeline({ events: [], eventsHasMore: false, cards, cardsHasMore: false })), ["2026-11-05", "2026-11-01"]);

  // 3) Cartão fechado: título, contagens, número mascarado e dono do número; sem mensagens.
  const closed = mod.renderCard({ card: card("2026-11-05", "2026-11-05T18:00:00.000Z") });
  assert.match(textOf(closed), /WhatsApp · 05\/11/);
  assert.match(textOf(closed), /3 mensagens · 2 recebidas · 1 enviada/);
  assert.match(textOf(closed), /\(11\) \*\*\*\*-0201/);
  assert.match(textOf(closed), /número de Vendedor Ficticio A/);
  assert.match(closed, /aria-expanded="false"/);

  // 4) Aberto: origem, editada, apagada pelo vendedor (mantida com marca) e do contato ("[mensagem apagada]").
  const messages = [
    { id: "m1", direction: "inbound", type: "TEXT", text: "Pergunta ficticia", at: "2026-11-05T16:00:00.000Z", origin: "received", edited: false, deletedInWhatsApp: false },
    { id: "m2", direction: "outbound", type: "TEXT", text: "Resposta ficticia", at: "2026-11-05T16:05:00.000Z", origin: "app", edited: true, deletedInWhatsApp: false },
    { id: "m3", direction: "outbound", type: "TEXT", text: "Texto ficticio apagado", at: "2026-11-05T16:10:00.000Z", origin: "app", edited: false, deletedInWhatsApp: true },
    { id: "m4", direction: "inbound", type: "TEXT", text: "[mensagem apagada]", at: "2026-11-05T16:20:00.000Z", origin: "received", edited: false, deletedInWhatsApp: true }
  ];
  const open = mod.renderCard({ card: card("2026-11-05", "2026-11-05T18:00:00.000Z"), open: true, messages, hasMore: true });
  const openText = textOf(open);
  assert.match(open, /aria-expanded="true"/);
  assert.match(openText, /Pergunta ficticia 13:00 recebida/);
  assert.match(openText, /Resposta ficticia 13:05 via app editada/);
  assert.match(openText, /Texto ficticio apagado 13:10 via app apagada no WhatsApp/);
  assert.match(openText, /\[mensagem apagada\] 13:20 recebida/);
  assert.doesNotMatch(openText, /\[mensagem apagada\] 13:20 recebida apagada no WhatsApp/);
  assert.match(openText, /Carregar mais mensagens/);
  assert.equal((open.match(/data-whatsapp-direction="outbound"/g) ?? []).length, 2);
  assert.match(textOf(mod.renderCard({ card: card("2026-11-05", "2026-11-05T18:00:00.000Z"), open: true, error: true })), /Não foi possível carregar as mensagens/);

  // 5) Linha do tempo: cartões entre os eventos; "Carregar mais" aparece se qualquer lista tem mais.
  const list = mod.renderList({ events, hasMore: false, whatsapp: { cards, hasMore: false } });
  const order = ["Interação ficticia e1", "WhatsApp · 05/11", "Interação ficticia e2", "WhatsApp · 01/11"].map((text) => textOf(list).indexOf(text));
  assert.ok(order.every((index) => index >= 0), "todos os itens na lista");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "ordem por data");
  assert.doesNotMatch(textOf(list), /Carregar mais/);
  assert.match(textOf(mod.renderList({ events, hasMore: false, whatsapp: { cards, hasMore: true } })), /Carregar mais/);
  // Sem a prop whatsapp: igual a antes.
  const plain = mod.renderList({ events, hasMore: false });
  assert.doesNotMatch(plain, /data-whatsapp-card/);
  assert.match(textOf(mod.renderList({ events: [], hasMore: false, emptyMessage: "Sem interações registradas." })), /Sem interações registradas/);

  // 6) Só leitura: nada de envio.
  assert.doesNotMatch(textOf(open), /Enviar|Responder/i);

  console.log("whatsapp timeline tests passed");
} finally {
  await server.close();
}
