import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertFreshUnknownStatusCheck, isAmbiguousManualResolutionCandidate, MANUAL_RESOLUTION_CONFIRMATION_PHRASE, resolveAmbiguousErpOrderManually, validateManualResolutionInput } from "./erpOrderManualResolutionService.js";

const pedidoIdImportacao = "6f5edc8a-55a7-4502-a816-a8b94b8e67c2";
const valid = {
  checkedNotFound: true,
  expectedImportIdSuffix: pedidoIdImportacao.slice(-8),
  justification: "Diretor conferiu a tentativa no ERP sem localizar pedido.",
  originalCorrelationId: "93690e4d-ac13-4288-b4c9-0212efe2dfad",
  confirmedConsequence: true,
  confirmationPhrase: MANUAL_RESOLUTION_CONFIRMATION_PHRASE,
};
assert.equal(validateManualResolutionInput(valid, pedidoIdImportacao).justification, valid.justification);
assert.throws(() => validateManualResolutionInput({ ...valid, expectedImportIdSuffix: "00000000" }, pedidoIdImportacao), /não conferem/);
assert.throws(() => validateManualResolutionInput({ ...valid, justification: "" }, pedidoIdImportacao), /entre 10 e 240/);
assert.throws(() => validateManualResolutionInput({ ...valid, justification: "Usei token bearer secreto na consulta" }, pedidoIdImportacao), /dados sensíveis/);
assert.throws(() => validateManualResolutionInput({ ...valid, checkedNotFound: false }, pedidoIdImportacao), /duas confirmações/);
assert.throws(() => validateManualResolutionInput({ ...valid, confirmationPhrase: "CONFIRMAÇÃO INCORRETA" }, pedidoIdImportacao), /frase de confirmação/);
assert.throws(() => assertFreshUnknownStatusCheck({ outcome: "unknown", checkedAt: new Date("2026-08-28T09:00:00.000Z") }, new Date("2026-08-28T09:02:00.001Z")), /não é recente/);
assert.throws(() => assertFreshUnknownStatusCheck({ outcome: "confirmed", checkedAt: new Date("2026-08-28T09:02:00.000Z") }, new Date("2026-08-28T09:02:01.000Z")), /permaneça unknown/);
assert.doesNotThrow(() => assertFreshUnknownStatusCheck({ outcome: "unknown", checkedAt: new Date("2026-08-28T09:02:00.000Z") }, new Date("2026-08-28T09:02:01.000Z")));
assert.equal(isAmbiguousManualResolutionCandidate({ status: "error", syncErrors: [{ status: 504, message: "timeout" }], erpResponse: null, lastStatusPayload: null }), true);
assert.equal(isAmbiguousManualResolutionCandidate({ status: "error", syncErrors: null, erpResponse: { status: 400, message: "rejeitado" }, lastStatusPayload: { outcome: "rejected" } }), false);
assert.equal(isAmbiguousManualResolutionCandidate({ status: "sent", syncErrors: null, erpResponse: null, lastStatusPayload: null }), false);
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
assert.match(serviceSource, /requestUltraFv3ReadOnlyWithCredentialsRetry[\s\S]*classifyUltraFv3OrderLookup[\s\S]*assertFreshUnknownStatusCheck[\s\S]*erpOrderManualResolution\.create/, "consulta fresca unknown deve ocorrer antes da auditoria/liberação");
assert.match(serviceSource, /isAmbiguousManualResolutionCandidate\(attempt\)/, "tentativa fora de unknown/error deve falhar");
assert.match(orderSource, /\/orderStatus\?pedido=[\s\S]*manual-resolution-retry-preflight[\s\S]*supersedesErpOrderSyncId/, "retry deve executar GET e preservar vínculo causal antes do POST");
assert.match(orderSource, /blockedByPreflight[\s\S]*nenhuma duplicidade foi criada/, "preflight positivo deve impedir POST");
assert.match(orderSource, /manualResolution\) continue/, "reconciliação automática não pode sobrescrever tentativa resolvida manualmente");

console.log("ERP order manual resolution tests passed");
