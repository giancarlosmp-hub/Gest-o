import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Configurações → Política Comercial: seção própria, só o diretor edita, e o painel valida com o mesmo schema da API.
const settingsPage = readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../src/components/settings/CommercialPolicyPanel.tsx", import.meta.url), "utf8");

assert.match(settingsPage, /id: "commercial-policy",\s+label: "Política Comercial"/, "seção na lista de Configurações");
assert.match(settingsPage, /normalizedSection === "politica-comercial"\) return "commercial-policy"/, "link ?section=politica-comercial");
assert.match(settingsPage, /activeSection === "commercial-policy" \? \(\s+<CommercialPolicyPanel canEdit=\{user\.role === "diretor"\} \/>/, "só o diretor edita");

assert.match(panel, /api\s+\.get<CommercialPolicy>\("\/settings\/commercial-policy"\)/);
assert.match(panel, /api\.put<CommercialPolicy>\("\/settings\/commercial-policy", parsed\.data\)/);
assert.match(panel, /commercialPolicySchema\.safeParse\(/, "mesma validação da API");
assert.match(panel, /COMMERCIAL_POLICY_ROLES\.map/, "um limite por perfil");
assert.match(panel, /Somente o diretor pode alterar a política comercial\./);
assert.match(panel, /Se o limite do ERP for menor que o daqui, o pedido\s+será recusado pelo ERP\./, "aviso do limite do ERP");

console.log("commercialPolicySettings.test: ok");
