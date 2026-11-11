import assert from "node:assert/strict";

// Regra da política comercial (packages/shared): limite de desconto por perfil, leitura tolerante da configuração e
// totais do item com o desconto arredondado para baixo no centavo. Só números fictícios.
const {
  DEFAULT_COMMERCIAL_POLICY,
  DEFAULT_COMMERCIAL_POLICY_DISCOUNT_WARNING,
  checkItemDiscount,
  commercialPolicySchema,
  computeOpportunityItemAmounts,
  maxDiscountPercentFor,
  parseCommercialPolicy
} = await import("@salesforce-pro/shared");

// Padrão: ligada, 3% para todos, texto do aviso padrão.
assert.deepEqual(DEFAULT_COMMERCIAL_POLICY, {
  enabled: true,
  maxDiscountPercent: { vendedor: 3, gerente: 3, diretor: 3 },
  discountWarning: "Descontos acima do limite da política comercial não são autorizados e implicam a perda do bônus."
});

// Leitura tolerante: sem configuração, JSON quebrado ou campo inválido voltam ao padrão campo a campo.
assert.deepEqual(parseCommercialPolicy(undefined), DEFAULT_COMMERCIAL_POLICY);
assert.deepEqual(parseCommercialPolicy("{quebrado"), DEFAULT_COMMERCIAL_POLICY);
assert.deepEqual(
  parseCommercialPolicy(JSON.stringify({ enabled: false, maxDiscountPercent: { vendedor: 2.5, gerente: -1, diretor: "x" }, discountWarning: "  Aviso de teste.  " })),
  { enabled: false, maxDiscountPercent: { vendedor: 2.5, gerente: 3, diretor: 3 }, discountWarning: "Aviso de teste." }
);
assert.equal(parseCommercialPolicy({ discountWarning: "   " }).discountWarning, DEFAULT_COMMERCIAL_POLICY_DISCOUNT_WARNING);

// Schema da gravação: limites entre 0 e 100 e aviso obrigatório.
assert.equal(commercialPolicySchema.safeParse(DEFAULT_COMMERCIAL_POLICY).success, true);
assert.equal(commercialPolicySchema.safeParse({ ...DEFAULT_COMMERCIAL_POLICY, maxDiscountPercent: { vendedor: 101, gerente: 3, diretor: 3 } }).success, false);
assert.equal(commercialPolicySchema.safeParse({ ...DEFAULT_COMMERCIAL_POLICY, discountWarning: "" }).success, false);

// Limite por perfil; perfil desconhecido fica com o menor; política desligada não limita no CRM.
const policy = { ...DEFAULT_COMMERCIAL_POLICY, maxDiscountPercent: { vendedor: 3, gerente: 5, diretor: 8 } };
assert.equal(maxDiscountPercentFor(policy, "vendedor"), 3);
assert.equal(maxDiscountPercentFor(policy, "gerente"), 5);
assert.equal(maxDiscountPercentFor(policy, "diretor"), 8);
assert.equal(maxDiscountPercentFor(policy, "outro"), 3);
assert.equal(maxDiscountPercentFor({ ...policy, enabled: false }, "vendedor"), null);

assert.deepEqual(checkItemDiscount(policy, "vendedor", 3), { ok: true });
assert.deepEqual(checkItemDiscount(policy, "vendedor", 0), { ok: true });
assert.deepEqual(checkItemDiscount(policy, "vendedor", 3.01), {
  ok: false,
  message: `Desconto máximo permitido: 3%. ${DEFAULT_COMMERCIAL_POLICY_DISCOUNT_WARNING}`
});
assert.deepEqual(checkItemDiscount(policy, "gerente", 5), { ok: true });
assert.equal(checkItemDiscount(policy, "gerente", 5.5).ok, false);
assert.deepEqual(checkItemDiscount({ ...policy, enabled: false }, "vendedor", 50), { ok: true });
assert.equal(checkItemDiscount({ ...policy, enabled: false }, "vendedor", 101).ok, false);
assert.equal(checkItemDiscount(policy, "diretor", -1).ok, false);
assert.equal(checkItemDiscount({ ...policy, maxDiscountPercent: { vendedor: 2.5, gerente: 5, diretor: 8 } }, "vendedor", 3).ok, false);

// Totais: bruto = quantidade × preço; desconto arredondado para baixo; líquido = bruto − desconto.
assert.deepEqual(computeOpportunityItemAmounts({ quantity: 100, unitPrice: 140, discountPercent: 3 }), { grossTotal: 14000, discountTotal: 420, netTotal: 13580 });
assert.deepEqual(computeOpportunityItemAmounts({ quantity: 3, unitPrice: 33.33, discountPercent: 3 }), { grossTotal: 99.99, discountTotal: 2.99, netTotal: 97 });
assert.deepEqual(computeOpportunityItemAmounts({ quantity: 7, unitPrice: 12.35, discountPercent: 2.5 }), { grossTotal: 86.45, discountTotal: 2.16, netTotal: 84.29 });
assert.deepEqual(computeOpportunityItemAmounts({ quantity: 10, unitPrice: 50, discountPercent: 0 }), { grossTotal: 500, discountTotal: 0, netTotal: 500 });
assert.deepEqual(computeOpportunityItemAmounts({ quantity: 2, unitPrice: 50, discountPercent: 100 }), { grossTotal: 100, discountTotal: 100, netTotal: 0 });
// O desconto arredondado nunca passa do % pedido.
for (const [quantity, unitPrice] of [[1, 0.17], [3, 19.9], [13, 7.77], [101, 3.33]]) {
  const amounts = computeOpportunityItemAmounts({ quantity, unitPrice, discountPercent: 3 });
  assert.ok(amounts.discountTotal <= amounts.grossTotal * 0.03 + 1e-9, `${quantity} × ${unitPrice}`);
  assert.equal(Math.round((amounts.grossTotal - amounts.discountTotal) * 100), Math.round(amounts.netTotal * 100));
}

console.log("commercialPolicy.test: ok");
