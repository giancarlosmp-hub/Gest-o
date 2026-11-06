import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";

// Configurações → Usuários renderizada de verdade (SettingsPage → CrudSimplePage) com react-dom/server,
// pelo próprio Vite (import.meta.env, JSX e aliases iguais aos do app). Só o useAuth é trocado por um
// usuário fictício; nenhuma chamada de rede acontece na renderização no servidor.
type FakeUser = { id: string; name: string; email: string; role: "diretor" | "gerente" | "vendedor" };

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const FAKE_AUTH = "\0fake-auth-context";
const RENDER_ENTRY = "\0users-settings-render";
const CRUD_PROBE = "\0crud-simple-page-probe";

const testPlugin: Plugin = {
  name: "users-settings-page-test",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "virtual:users-settings-render") return RENDER_ENTRY;
    // Só o import da SettingsPage passa pela sonda, que escreve as props recebidas no HTML (JSON) e
    // renderiza o CrudSimplePage real logo em seguida.
    if (source === "./CrudSimplePage" && importer?.replace(/\\/g, "/").endsWith("/src/pages/SettingsPage.tsx")) return CRUD_PROBE;
    if (/(^|\/)context\/AuthContext(\.tsx)?$/.test(source)) return FAKE_AUTH;
    return null;
  },
  load(id) {
    if (id === FAKE_AUTH) {
      return [
        "export const useAuth = () => globalThis.__usersSettingsTestAuth;",
        "export function AuthProvider({ children }) { return children; }"
      ].join("\n");
    }
    if (id === CRUD_PROBE) {
      return [
        'import { createElement, Fragment } from "react";',
        'import CrudSimplePage from "/src/pages/CrudSimplePage.tsx";',
        "export default function CrudSimplePageProbe(props) {",
        "  return createElement(Fragment, null,",
        '    createElement("script", { type: "application/json", "data-crud-props": "" }, JSON.stringify(props)),',
        "    createElement(CrudSimplePage, props));",
        "}"
      ].join("\n");
    }
    if (id === RENDER_ENTRY) {
      return [
        'import { createElement } from "react";',
        'import { renderToStaticMarkup } from "react-dom/server";',
        'import { MemoryRouter } from "react-router-dom";',
        'import SettingsPage from "/src/pages/SettingsPage.tsx";',
        'export { buildUserAdminFields } from "/src/components/settings/userAdminFields.ts";',
        "export const render = (url) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, createElement(SettingsPage)));"
      ].join("\n");
    }
    return null;
  }
};

// Armazenamento do navegador em memória: o apiClient lê o token ao carregar o módulo.
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

// Só o aviso esperado de useLayoutEffect no servidor é silenciado; qualquer outro erro continua no log.
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("Warning: useLayoutEffect does nothing on the server")) return;
  originalConsoleError(...args);
};

const server = await createServer({
  root: webRoot,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, watch: null },
  plugins: [testPlugin]
});

const fakeUser = (role: FakeUser["role"]): FakeUser => ({ id: `${role}-ficticio`, name: `Usuario Ficticio ${role}`, email: `${role}@test.invalid`, role });
const setUser = (user: FakeUser) => {
  (globalThis as any).__usersSettingsTestAuth = { user, loading: false, login: async () => undefined, logout: async () => undefined };
};
const textOf = (html: string) => html.replace(/<[^>]+>/g, "\n").split("\n").map((part) => part.trim()).filter(Boolean);
// Props que a SettingsPage passou ao CrudSimplePage, escritas pela sonda (null se não montou).
const crudPropsOf = (html: string) => {
  const json = html.match(/<script type="application\/json" data-crud-props="">([\s\S]*?)<\/script>/)?.[1];
  return json ? JSON.parse(json.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) : null;
};
const formLabels = (html: string) => {
  const form = html.match(/<form[\s\S]*?<\/form>/)?.[0];
  assert(form, "formulário de usuários renderizado");
  return { form, labels: [...form.matchAll(/<label[^>]*>([^<]*)/g)].map((match) => match[1].trim()) };
};

try {
  const { render, buildUserAdminFields } = await server.ssrLoadModule("virtual:users-settings-render");

  // 1) Lista efetivamente usada pela tela: celular logo depois da região, no formulário e na tabela.
  for (const role of ["diretor", "gerente"] as const) {
    const fields = buildUserAdminFields(role) as Array<Record<string, any>>;
    const keys = fields.map((field) => field.key);
    assert.equal(keys.indexOf("phone"), keys.indexOf("region") + 1, "celular logo depois de Região de atuação");
    const phone = fields.find((field) => field.key === "phone")!;
    assert.deepEqual(phone, { key: "phone", label: "Celular / WhatsApp", type: "tel", placeholder: "(DDD) 9XXXX-XXXX" });
    const roleOptions = fields.find((field) => field.key === "role")!.options.map((option: any) => option.value);
    assert.deepEqual(roleOptions, role === "diretor" ? ["diretor", "gerente", "vendedor"] : ["gerente", "vendedor"]);
  }

  // 2) Tela renderizada para diretor e gerente fictícios.
  for (const role of ["diretor", "gerente"] as const) {
    setUser(fakeUser(role));
    const html = render("/configurações?section=users") as string;
    assert(textOf(html).includes("Usuários"), `${role}: seção Usuários aberta`);

    const { form, labels } = formLabels(html);
    assert.deepEqual(labels, [
      "Nome completo", "E-mail corporativo", "Perfil de acesso", "Região de atuação", "Celular / WhatsApp",
      "Vendedor/operador ERP", "Login FV3 / CPF-CNPJ", "Senha FV3", "Senha de acesso"
    ], `${role}: campos do formulário`);
    const phoneInput = form.match(/<input[^>]*placeholder="\(DDD\) 9XXXX-XXXX"[^>]*>/)?.[0];
    assert(phoneInput, `${role}: input do celular`);
    assert.match(phoneInput, /type="tel"/);
    assert.doesNotMatch(phoneInput, /required/, `${role}: celular opcional`);

    // A tabela só aparece depois do GET /users (useEffect), que não roda no servidor: no HTML fica o
    // "Carregando...". As colunas vêm das props que a SettingsPage passou ao CrudSimplePage real nesta
    // renderização, pela mesma regra do <thead> (campos sem formOnly, tableLabel ou label).
    assert.match(html, /Carregando\.\.\./, `${role}: tabela aguardando a lista`);
    const props = crudPropsOf(html);
    assert.equal(props?.endpoint, "/users", `${role}: CrudSimplePage de usuários`);
    assert.deepEqual(props.fields, buildUserAdminFields(role), `${role}: tela usa buildUserAdminFields`);
    const columns = props.fields.filter((field: any) => !field.formOnly).map((field: any) => field.tableLabel ?? field.label);
    assert.deepEqual(columns, [
      "Nome completo", "E-mail corporativo", "Perfil de acesso", "Região de atuação", "Celular / WhatsApp", "WhatsApp",
      "Vínculo ERP", "Login FV3 / CPF-CNPJ", "Login FV3 configurado", "Senha de acesso"
    ], `${role}: colunas da tabela`);
    // A coluna WhatsApp é só de tabela: nunca vira campo do formulário.
    assert.doesNotMatch(form, /WhatsApp conectado/, `${role}: status do WhatsApp fora do formulário`);
  }

  // 3) Vendedor não acessa Configurações.
  setUser(fakeUser("vendedor"));
  const sellerHtml = render("/configurações?section=users") as string;
  assert.match(sellerHtml, /Acesso não permitido/);
  assert.doesNotMatch(sellerHtml, /Celular \/ WhatsApp/);
  assert.equal(crudPropsOf(sellerHtml), null, "vendedor não monta o cadastro");

  console.log("users settings page tests passed");
} finally {
  console.error = originalConsoleError;
  await server.close();
}
