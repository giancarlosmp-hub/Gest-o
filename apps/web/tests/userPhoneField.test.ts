import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeBrazilPhone } from "@salesforce-pro/shared";

// Celular/WhatsApp do usuário em Configurações → Usuários. Dados fictícios.
const panel = fs.readFileSync(new URL("../src/components/settings/UsersAdminPanel.tsx", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../src/pages/CrudSimplePage.tsx", import.meta.url), "utf8");

assert.match(panel, /key: "phone", label: "Celular \/ WhatsApp", type: "tel"/, "campo de celular no cadastro de usuários");
assert.match(page, /isOptionalUserPhoneField = endpoint === "\/users" && f\.key === "phone"/, "celular é opcional");
assert.match(page, /phone: payload\.phone \? String\(payload\.phone\)\.trim\(\) : null/, "vazio envia null para limpar");
assert.match(page, /fieldKey === "phone"\) \{\s*return [^\n]*normalizeBrazilPhone\(item\.phone\)\.display/, "tabela mostra o número formatado");

// O valor salvo (55DDDNÚMERO) aparece formatado na tabela e no formulário de edição.
assert.equal(normalizeBrazilPhone("5511900000001").display, "(11) 90000-0001");
console.log("user phone field tests passed");
