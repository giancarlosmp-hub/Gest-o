import assert from "node:assert/strict";
import fs from "node:fs";
import { CLIENT_WITHOUT_ERP_CODE_ORDER_MESSAGE, getErpOrderReadiness } from "@salesforce-pro/shared";
import { validateClientPayload } from "../src/lib/validateClientPayload.js";

// Dados fictícios: o formulário do CRM nunca envia o código do cliente (vem do ERP).
const { sanitizedPayload } = validateClientPayload(
  { name: "Cliente Ficticio", city: "Cidade", state: "GO", clientType: "PJ", code: "7405" },
  { isSeller: true, canChooseOwnerSeller: false, sellerId: "seller-a" },
);
assert.equal("code" in sanitizedPayload, false, "cadastro e edição não enviam code");

const readiness = getErpOrderReadiness({
  stage: "ganho", itemCount: 1, clientErpCode: "", sellerErpCode: "10", sellerOperatorCode: "20", sellerLoginFv3: "login", sellerPasswordConfigured: true,
});
assert.equal(readiness.ready, false);
assert.equal(readiness.firstReason, CLIENT_WITHOUT_ERP_CODE_ORDER_MESSAGE);
assert.equal(getErpOrderReadiness({
  stage: "ganho", itemCount: 1, clientErpCode: "90001", sellerErpCode: "10", sellerOperatorCode: "20", sellerLoginFv3: "login", sellerPasswordConfigured: true,
}).ready, true);

const crudPage = fs.readFileSync(new URL("../src/pages/CrudSimplePage.tsx", import.meta.url), "utf8");
assert.match(crudPage, /f\.key === "code"\) \{\s*if \(!editing\) return null;/, "código fora do cadastro de novo cliente");
assert.match(crudPage, /readOnly[\s\S]{0,900}O código vem do ERP após o cadastro do cliente lá e a próxima sincronização\./, "código só leitura na edição");
const opportunitiesPage = fs.readFileSync(new URL("../src/pages/OpportunitiesPage.tsx", import.meta.url), "utf8");
assert.equal((opportunitiesPage.match(/disabled=\{isClientWithoutErpCode\(/g) || []).length, 3, "os três botões Gerar/Reenviar pedido ERP ficam desabilitados");

console.log("Client code ERP-only web tests passed");
