import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

// Dados fictícios: códigos, descrições, vendedor e cliente inventados.
process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = "test-only-payment-method-key";

const { prisma } = await import("../config/prisma.js");
const { encryptErpCredential } = await import("./erpCredentialCrypto.js");
const { isErpReferenceEligible } = await import("../utils/erpReferenceValidation.js");
const { toReferenceOptions } = await import("../routes/ultraFv3Routes.js");
const { createErpOrderFromOpportunity } = await import("./erpOrderService.js");
const { getErpOrderPdfMetadata } = await import("./erpOrderPdfService.js");

type Row = Record<string, unknown>;
const pm = (FORMA: string, extra: Row): Row => ({ FORMA, DSCFORMA: `FORMA FICTICIA ${FORMA}`, ...extra });
const paymentMethods: Row[] = [
  pm("1", { LIBERAR_INTERNET: "S", ATIVO: "S" }),
  pm("2", { LIBERAR_INTERNET: " s ", ATIVO: " s " }),
  pm("91", { LIBERAR_INTERNET: "N", ATIVO: "S" }),
  pm("92", { LIBERAR_INTERNET: "S", ATIVO: "N" }),
  pm("93", { ATIVO: "S" }),
  pm("94", { LIBERAR_INTERNET: "S" }),
  pm("95", { LIBERAR_INTERNET: null, ATIVO: "S" }),
  pm("96", { LIBERAR_INTERNET: "", ATIVO: "" }),
];

// 1. Regra de elegibilidade (fail-closed).
assert.equal(isErpReferenceEligible("paymentMethods", paymentMethods[0]), true, "S + ativo é elegível");
assert.equal(isErpReferenceEligible("paymentMethods", paymentMethods[1]), true, "maiúsculas/espaços ignorados");
for (const row of paymentMethods.slice(2)) {
  assert.equal(isErpReferenceEligible("paymentMethods", row), false, `forma ${row.FORMA} não pode ser elegível`);
}

// 2. Listagem para o vendedor (projeção de GET /erp/ultrafv3/payment-methods).
const listedCodes = (rows: Row[]) => (toReferenceOptions("paymentMethods", rows) as Array<{ code: string }>).map((option) => option.code);
assert.deepEqual(listedCodes(paymentMethods), ["1", "2"], "só formas com LIBERAR_INTERNET=S e ATIVO=S aparecem");

// Condição de recebimento continua com a regra anterior (ATIVO ausente segue aceito, LIBERAR_INTERNET exigido).
const receivingConditions: Row[] = [
  { CODCONDREC: "10", DESCRICAO: "CONDICAO FICTICIA A", LIBERAR_INTERNET: "S" },
  { CODCONDREC: "11", DESCRICAO: "CONDICAO FICTICIA B", ATIVO: "S", LIBERAR_INTERNET: "N" },
];
assert.deepEqual((toReferenceOptions("receivingConditions", receivingConditions) as Array<{ code: string }>).map((o) => o.code), ["10"]);

// 3. Envio direto pela API: revalidação no backend antes do ERP.
const appConfig = new Map<string, string>([
  ["erp.ultrafv3.paymentMethods", JSON.stringify(paymentMethods)],
  ["erp.ultrafv3.receivingConditions", JSON.stringify(receivingConditions)],
  ["erp.ultrafv3.operations", JSON.stringify([{ CODOPER: "100", DESCRICAO: "VENDA", ATIVO: "S", LIBERAR_INTERNET: "S", VENDAS: "S" }])],
]);
(prisma as any).appConfig.findUnique = async ({ where }: { where: { key: string } }) => {
  const value = appConfig.get(where.key);
  return value === undefined ? null : { value, updatedAt: new Date("2026-10-01T00:00:00Z") };
};

const opportunity = {
  id: "opp-ficticia",
  stage: "ganho",
  client: { tenantId: "tenant-ficticio", code: "7001" },
  ownerSeller: {
    id: "seller-ficticio", name: "Vendedor Ficticio", erpCode: "77", erpOperatorCode: "5",
    erpLoginUsername: "login-ficticio", erpLoginPasswordEncrypted: encryptErpCredential("senha-ficticia"),
  },
  items: [{ lineNumber: 1, erpProductCode: "P1", erpProductClassCode: "1", unit: "UN", unitPrice: 10, netTotal: 10, productNameSnapshot: "Produto Ficticio" }],
} as any;
// Data inválida de propósito: se a revalidação passar, a falha seguinte é a data, antes de qualquer gravação/ERP.
const params = (paymentMethodCode: string) => ({
  paymentMethodCode, receivingConditionCode: "10", priceTableCode: "1", branchCode: "1", operationCode: "100",
  expectedDeliveryDate: "data-invalida", erpOrderObservation: "", simulateOnly: true,
});
const sendError = async (code: string) => {
  try {
    await createErpOrderFromOpportunity(opportunity, params(code) as any, { correlationId: "corr-ficticio" });
  } catch (error) {
    return error as Error & { status?: number };
  }
  throw new Error("envio deveria falhar");
};

for (const code of ["91", "92", "93", "94"]) {
  const error = await sendError(code);
  assert.equal(error.status, 400);
  assert.equal(error.message, `Forma de pagamento não autorizada para uso no CRM (código ${code}).`);
}
const missing = await sendError("999");
assert.equal(missing.status, 400);
assert.equal(missing.message, "Forma de pagamento inválida para emissão ERP.");
const allowed = await sendError("1");
assert.match(allowed.message, /Data prevista de entrega/, "forma liberada passa pela revalidação");

// 4. Histórico: pedido já enviado com forma hoje não liberada continua consultável com a descrição.
const historical = await getErpOrderPdfMetadata(prisma as any, {
  payloadSent: { FORMA: 91, CODCONDREC: 10, CODFILIAL: 1 },
  opportunity: { client: { code: "7001", cnpj: null } },
} as any);
assert.equal(historical.paymentMethodDescription, "FORMA FICTICIA 91");

// 5. Mutação: sem o filtro na projeção da rota, a forma N aparece para o vendedor.
const routeSource = readFileSync(new URL("../routes/ultraFv3Routes.ts", import.meta.url), "utf8");
const filterGuard = "(ERP_ELIGIBILITY_FILTERED_SCOPES as readonly string[]).includes(scope)";
assert.ok(routeSource.includes(filterGuard));
const mutatedUrl = new URL(`../routes/ultraFv3Routes.mutation-payment-${process.pid}.ts`, import.meta.url);
writeFileSync(mutatedUrl, routeSource.replace(filterGuard, "false"));
try {
  const unfiltered = await import(mutatedUrl.href);
  const codes = (unfiltered.toReferenceOptions("paymentMethods", paymentMethods) as Array<{ code: string }>).map((o) => o.code);
  assert.ok(codes.includes("91"), "sem o filtro a forma LIBERAR_INTERNET=N apareceria");
} finally {
  rmSync(mutatedUrl, { force: true });
}

await prisma.$disconnect().catch(() => undefined);
console.log("ERP_PAYMENT_METHOD_ELIGIBILITY=PASS listing=S_and_active_only direct_api_n=REJECTED missing=REJECTED history=PRESERVED receiving_conditions=UNCHANGED mutation_shows_n=DETECTED");
