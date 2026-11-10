import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";

// Resumo diário: opção "Dicas do gerente comercial (IA)" e situação das dicas na prévia, renderizadas com
// react-dom/server pelo próprio Vite. Só a parte visual: nenhuma chamada de rede. Só dados fictícios.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const RENDER_ENTRY = "\0daily-summary-tips-render";

const testPlugin: Plugin = {
  name: "daily-summary-tips-test",
  enforce: "pre",
  resolveId(source) {
    return source === "virtual:daily-summary-tips-render" ? RENDER_ENTRY : null;
  },
  load(id) {
    if (id !== RENDER_ENTRY) return null;
    return [
      'import { createElement } from "react";',
      'import { renderToStaticMarkup } from "react-dom/server";',
      'import { ManagerTipsOption, TipsStatusNote } from "/src/components/settings/WhatsAppDailySummaryPanel.tsx";',
      'export { DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG, WHATSAPP_DAILY_SUMMARY_TIPS_MESSAGES } from "@salesforce-pro/shared";',
      "const noop = () => undefined;",
      "export const renderOption = (checked, disabled) => renderToStaticMarkup(createElement(ManagerTipsOption, { checked, disabled, onChange: noop }));",
      "export const renderNote = (tips) => renderToStaticMarkup(createElement(TipsStatusNote, { tips }));"
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

try {
  const mod = await server.ssrLoadModule("virtual:daily-summary-tips-render");
  const renderOption = mod.renderOption as (checked: boolean, disabled: boolean) => string;
  const renderNote = mod.renderNote as (tips: unknown) => string;
  const messages = mod.WHATSAPP_DAILY_SUMMARY_TIPS_MESSAGES as Record<string, string>;

  // 1) Desligadas por padrão; a opção explica o que vai para a IA e o que acontece se ela falhar.
  assert.equal(mod.DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG.managerTips, false);
  const off = renderOption(false, false);
  assert.match(textOf(off), /Dicas do gerente comercial \(IA\)/);
  assert.match(textOf(off), /— Claude, gerente comercial/);
  assert.match(textOf(off), /nunca nome, telefone, documento ou cidade do cliente/);
  assert.match(textOf(off), /o resumo sai sem as dicas/);
  assert.doesNotMatch(off, /checked=""/);
  assert.match(renderOption(true, false), /checked=""/);
  assert.match(renderOption(true, true), /disabled=""/, "gerente só vê");

  // 2) Situação na prévia: nada quando desligadas; verde quando geradas; âmbar quando o resumo sai sem dicas.
  assert.equal(renderNote(undefined), "");
  assert.equal(renderNote({ status: "off", message: messages.off }), "");
  assert.match(renderNote({ status: "ok", message: messages.ok }), /text-emerald-700/);
  for (const status of ["ai_unavailable", "ai_failed", "discarded", "no_summary"]) {
    const html = renderNote({ status, message: messages[status] });
    assert.match(html, /text-amber-700/, status);
    assert.match(textOf(html), new RegExp(messages[status].slice(0, 20).replace(/[()]/g, "\\$&")));
  }
} finally {
  await server.close();
}

console.log("whatsappDailySummaryTips.test.ts: ok");
