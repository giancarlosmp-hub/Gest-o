import assert from "node:assert/strict";
import fs from "node:fs";
import { initialTerritorySellerId, territoryReadOnlyMessage, TERRITORY_VIEW_ONLY_MESSAGE } from "../src/lib/territorySellerSelection.js";

// Dados fictícios: Territórios Comerciais abre no primeiro vendedor ativo (a API ordena por nome e inclui inativos) e
// mostra o aviso certo quando o território não pode ser editado.
const inactive = { id: "vendedor-ficticio-a-inativo", isActive: false, canEdit: false, territoryCount: 4 };
const inactiveEmpty = { id: "vendedor-ficticio-b-inativo", isActive: false, canEdit: false, territoryCount: 0 };
const active = { id: "vendedor-ficticio-c-ativo", isActive: true, canEdit: true, territoryCount: 3 };

assert.equal(initialTerritorySellerId([inactive, inactiveEmpty, active], ""), "vendedor-ficticio-c-ativo", "A: abre no primeiro ativo");
assert.equal(initialTerritorySellerId([inactive, inactiveEmpty], ""), "vendedor-ficticio-a-inativo", "sem ativo: o primeiro");
assert.equal(initialTerritorySellerId([inactive, active], "vendedor-ficticio-a-inativo"), "vendedor-ficticio-a-inativo", "mantém o escolhido");
assert.equal(initialTerritorySellerId([], ""), "");

assert.equal(territoryReadOnlyMessage(active), null, "C: diretor ou gerente edita vendedor ativo sem aviso");
assert.equal(territoryReadOnlyMessage(inactive), "Vendedor inativo: o território só pode ser transferido para um vendedor ativo.");
assert.equal(territoryReadOnlyMessage(inactiveEmpty), "Vendedor inativo, sem cidades no território.");
assert.equal(territoryReadOnlyMessage({ ...active, canEdit: false }), TERRITORY_VIEW_ONLY_MESSAGE, "perfil sem edição");

const panel = fs.readFileSync(new URL("../src/components/settings/SellerTerritoriesPanel.tsx", import.meta.url), "utf8");
assert.match(panel, /setSelectedSellerId\(\(current\) => initialTerritorySellerId\(loadedSellers, current\)\)/, "a tela usa a seleção inicial");
assert.match(panel, /\{territoryReadOnlyMessage\(selectedSeller\)\}/, "a tela usa o aviso do caso real");
assert(!panel.includes("Seu perfil permite apenas visualizar este território."), "o texto fixo saiu da tela");

console.log("TERRITORY_SELLER_SELECTION=PASS");
