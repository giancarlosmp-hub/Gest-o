import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAmbiguousErpOrderManually, validateManualResolutionInput } from "./erpOrderManualResolutionService.js";

const pedidoIdImportacao = "6f5edc8a-55a7-4502-a816-a8b94b8e67c2";
const valid = {
  checkedNotFound: true,
  expectedImportIdSuffix: pedidoIdImportacao.slice(-8),
  justification: "Diretor conferiu a tentativa no ERP sem localizar pedido.",
  originalCorrelationId: "93690e4d-ac13-4288-b4c9-0212efe2dfad",
  confirmedConsequence: true,
};
assert.equal(validateManualResolutionInput(valid, pedidoIdImportacao).justification, valid.justification);
assert.throws(() => validateManualResolutionInput({ ...valid, expectedImportIdSuffix: "00000000" }, pedidoIdImportacao), /não conferem/);
assert.throws(() => validateManualResolutionInput({ ...valid, justification: "" }, pedidoIdImportacao), /entre 10 e 240/);
assert.throws(() => validateManualResolutionInput({ ...valid, justification: "Usei token bearer secreto na consulta" }, pedidoIdImportacao), /dados sensíveis/);
assert.throws(() => validateManualResolutionInput({ ...valid, checkedNotFound: false }, pedidoIdImportacao), /duas confirmações/);
for (const role of ["gerente", "vendedor"] as const) {
  await assert.rejects(
    resolveAmbiguousErpOrderManually({ opportunityId: "opportunity-a", erpOrderSyncId: "attempt-a", actor: { id: `user-${role}`, role }, input: valid }),
    /Somente diretor/,
    `${role} não pode resolver tentativa ambígua`,
  );
}

const routeSource = readFileSync(new URL("../routes/crudRoutes.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("./erpOrderManualResolutionService.ts", import.meta.url), "utf8");
const orderSource = readFileSync(new URL("./erpOrderService.ts", import.meta.url), "utf8");
const migrationSource = readFileSync(new URL("../../prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql", import.meta.url), "utf8");

assert.match(routeSource, /erp\/orders\/:orderId\/manual-resolution"[\s\S]{0,120}authorize\("diretor"\)/, "somente diretor pode acessar a rota");
assert.match(serviceSource, /params\.actor\.role !== Role\.diretor/, "service também deve autorizar diretor");
assert.match(serviceSource, /id: params\.erpOrderSyncId, opportunityId: params\.opportunityId/, "tentativa deve pertencer à oportunidade da rota");
assert.match(serviceSource, /pg_advisory_xact_lock/, "resolução concorrente deve usar lock da oportunidade");
assert.match(migrationSource, /UNIQUE INDEX "ErpOrderManualResolution_erpOrderSyncId_key"/, "uma tentativa só pode ter uma resolução");
assert.doesNotMatch(serviceSource, /erpOrderSync\.update/, "resolução não pode alterar a tentativa original");
assert.match(serviceSource, /erpOrderManualResolution\.create[\s\S]*timelineEvent\.create/, "auditoria e timeline devem ser atômicas");
assert.match(orderSource, /\/orderStatus\?pedido=[\s\S]*manual-resolution-retry-preflight[\s\S]*supersedesErpOrderSyncId/, "retry deve executar GET e preservar vínculo causal antes do POST");
assert.match(orderSource, /blockedByPreflight[\s\S]*nenhuma duplicidade foi criada/, "preflight positivo deve impedir POST");
assert.match(orderSource, /manualResolution\) continue/, "reconciliação automática não pode sobrescrever tentativa resolvida manualmente");

console.log("ERP order manual resolution tests passed");
