import assert from "node:assert/strict";
import fs from "node:fs";

// Integração ERP: o bloco temporário "Diagnóstico ERP do vendedor" saiu do painel junto com a rota da API.
// O diagnóstico por vendedor continua em Configurações → Usuários (GET /users/:id/erp-diagnostics), com o
// vendedor escolhido na lista. Contrato pelo código-fonte, como os demais testes do painel.
const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const erp = read("../src/components/settings/ErpIntegrationPanel.tsx");
const users = read("../src/pages/CrudSimplePage.tsx");

// 1. O painel não chama mais a rota removida nem guarda estado ou função do bloco.
assert.doesNotMatch(erp, /seller-diagnostics/);
assert.doesNotMatch(erp, /SellerDiagnosticsResponse|sellerDiag|runSellerDiagnostics/);
assert.doesNotMatch(erp, /Diagnóstico ERP do vendedor|Tela temporária|Investigar /);

// 2. Nenhum vendedor ou código do ERP fixo no painel: sem parâmetros de vendedor/operador/busca na consulta e
// sem CODVENDEDOR/OPERADOR seguidos de número no texto.
assert.doesNotMatch(erp, /\b(sellerCode|operatorCode|erpCode|operador)\s*:\s*["'`]?\d/);
assert.doesNotMatch(erp, /\bsearch\s*:\s*["'`]/);
assert.doesNotMatch(erp, /\b(CODVENDEDOR|OPERADOR)\s+\d/);

// 3. O diagnóstico por vendedor escolhido na lista de Usuários continua disponível.
assert.match(users, /api\.get<UserErpDiagnostics>\(`\/users\/\$\{item\.id\}\/erp-diagnostics`\)/);
assert.match(users, /Diagnóstico ERP do vendedor/);

console.log("erp integration panel without hardcoded seller diagnostics: ok");
