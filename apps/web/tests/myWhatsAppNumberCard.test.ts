import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";

// Cartão "Meu número" (WhatsApp Fase A) renderizado com react-dom/server pelo próprio Vite.
// Só a parte visual (MyWhatsAppNumberView): nenhuma chamada de rede. Números fictícios.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const RENDER_ENTRY = "\0my-whatsapp-number-render";

const testPlugin: Plugin = {
  name: "my-whatsapp-number-card-test",
  enforce: "pre",
  resolveId(source) {
    return source === "virtual:my-whatsapp-number-render" ? RENDER_ENTRY : null;
  },
  load(id) {
    if (id !== RENDER_ENTRY) return null;
    return [
      'import { createElement } from "react";',
      'import { renderToStaticMarkup } from "react-dom/server";',
      'import { MyWhatsAppNumberView } from "/src/components/whatsapp/MyWhatsAppNumberCard.tsx";',
      'export * from "/src/lib/whatsappConnection.ts";',
      "const noop = () => undefined;",
      "export const render = (connection, summary = null) => renderToStaticMarkup(createElement(MyWhatsAppNumberView, { connection, summary, busy: false, onConnect: noop, onDisconnect: noop }));"
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

const FAKE_QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const base = {
  enabled: true as const,
  configured: true,
  serviceAvailable: true,
  phoneConfigured: true,
  expectedPhone: "(11) 90000-0001",
  status: "NOT_CONNECTED" as const,
  statusReason: null,
  connectedPhone: null,
  connectedAt: null,
  lastSeenAt: null,
  qrDataUrl: null
};
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

try {
  const mod = await server.ssrLoadModule("virtual:my-whatsapp-number-render");
  const render = mod.render as (connection: unknown, summary?: unknown) => string;

  // 1) Não conectado: botão de conectar e o número esperado.
  const idle = render(base);
  assert.match(textOf(idle), /Meu número/);
  assert.match(textOf(idle), /\(11\) 90000-0001/);
  assert.match(textOf(idle), /Conectar meu WhatsApp/);
  assert.doesNotMatch(idle, /<img/);

  // 2) Aguardando: QR (só a data URL recebida) e instruções; sem botão de conectar.
  const pending = render({ ...base, status: "PENDING_QR", qrDataUrl: FAKE_QR });
  assert.match(pending, /data-whatsapp-status="PENDING_QR"/);
  assert.ok(pending.includes(`src="${FAKE_QR}"`), "QR renderizado");
  assert.match(textOf(pending), /Aparelhos conectados/);
  assert.match(textOf(pending), /Só o número cadastrado é aceito/);
  assert.doesNotMatch(textOf(pending), /Conectar meu WhatsApp/);
  assert.match(textOf(pending), /Cancelar/);
  assert.match(textOf(render({ ...base, status: "PENDING_QR" })), /Gerando QR/);

  // 3) Conectado.
  const connected = render({ ...base, status: "CONNECTED", connectedPhone: "(11) 90000-0001" });
  assert.match(textOf(connected), /Conectado com \(11\) 90000-0001/);
  assert.match(textOf(connected), /Desconectar/);
  assert.doesNotMatch(textOf(connected), /Conectar meu WhatsApp/);

  // 4) Recusado por número diferente: explica e permite tentar de novo.
  const rejected = render({ ...base, status: "REJECTED_WRONG_NUMBER", statusReason: "phone_mismatch" });
  assert.match(textOf(rejected), /Recusado: número diferente do cadastrado/);
  assert.match(textOf(rejected), /não é o celular cadastrado/);
  assert.match(textOf(rejected), /Conectar meu WhatsApp/);
  assert.doesNotMatch(textOf(rejected), /Desconectar/);

  // 5) Sem celular cadastrado, sem configuração ou serviço fora do ar: avisos e nada de conectar.
  const noPhone = render({ ...base, phoneConfigured: false, expectedPhone: null });
  assert.match(textOf(noPhone), /ainda não tem celular cadastrado/);
  assert.doesNotMatch(textOf(noPhone), /Conectar meu WhatsApp/);
  assert.doesNotMatch(textOf(render({ ...base, configured: false })), /Conectar meu WhatsApp/);
  assert.match(textOf(render({ ...base, serviceAvailable: false, status: "CONNECTED", connectedPhone: "(11) 90000-0001" })), /restante do CRM continua funcionando/);

  // 6) Rótulos da coluna de Usuários.
  assert.equal(mod.whatsappColumnLabel(undefined), "Não conectado");
  assert.equal(mod.whatsappColumnLabel({ userId: "u", status: "CONNECTED", connectedPhone: "(11) 9****-0001" }), "Conectado · (11) 9****-0001");
  assert.equal(mod.whatsappColumnLabel({ userId: "u", status: "REJECTED_WRONG_NUMBER", connectedPhone: null }), "Recusado (número diferente)");
  assert.equal(mod.whatsappCanDisconnect("CONNECTED"), true);
  assert.equal(mod.whatsappCanDisconnect("DISCONNECTED"), false);

  // 7) Fase B2: gravação ligada/desligada desde dd/mm (Brasília), aviso de registro e contador da fila.
  const connectedBase = { ...base, status: "CONNECTED", connectedPhone: "(11) 90000-0001" };
  const recordingOn = render(connectedBase, { recording: { enabled: true, since: "2026-11-10T01:00:00.000Z" }, unlinkedCount: 3 });
  assert.match(recordingOn, /data-whatsapp-recording="on"/);
  assert.match(textOf(recordingOn), /Gravação das conversas ligada desde 09\/11/);
  assert.match(textOf(recordingOn), /ficam registradas no CRM/);
  assert.match(textOf(recordingOn), /3 conversas não vinculadas/);
  assert.match(recordingOn, /href="#conversas-nao-vinculadas"/);
  const recordingOff = render(connectedBase, { recording: { enabled: false, since: "2026-11-08T12:00:00.000Z" }, unlinkedCount: 0 });
  assert.match(textOf(recordingOff), /Gravação das conversas desligada desde 08\/11/);
  assert.doesNotMatch(textOf(recordingOff), /ficam registradas/);
  assert.match(textOf(recordingOff), /Nenhuma conversa aguardando vínculo/);
  assert.match(textOf(render(connectedBase, { recording: { enabled: true, since: null }, unlinkedCount: 1 })), /Gravação das conversas ligada As conversas.* 1 conversa não vinculada/);
  // Não conectado: nada de gravação; com fila, só o contador.
  assert.doesNotMatch(textOf(render(base, { recording: { enabled: true, since: null }, unlinkedCount: 0 })), /Gravação|aguardando vínculo/);
  const idleWithQueue = textOf(render(base, { recording: { enabled: true, since: null }, unlinkedCount: 2 }));
  assert.doesNotMatch(idleWithQueue, /Gravação/);
  assert.match(idleWithQueue, /2 conversas não vinculadas/);

  // 8) Nenhum texto de envio de mensagem no cartão.
  for (const html of [idle, pending, connected, recordingOn]) assert.doesNotMatch(textOf(html), /Enviar|enviar mensagem/i);

  console.log("my whatsapp number card tests passed");
} finally {
  await server.close();
}
