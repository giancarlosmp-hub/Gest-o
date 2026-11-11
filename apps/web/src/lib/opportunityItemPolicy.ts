import { checkItemDiscount, computeOpportunityItemAmounts, type CommercialPolicy } from "@salesforce-pro/shared";

// Item de oportunidade na tela, com a política comercial: preço do ERP (somente leitura), desconto só em %, limite do
// perfil e aviso sempre que houver desconto. A API repete as mesmas regras (packages/shared).
export type OpportunityItemPolicyInput = {
  quantity: string;
  unitPrice: string;
  discountType: "value" | "percent";
  discountValue: string;
  erpUnitPrice?: number | null;
  erpPriceDiffers?: boolean;
};

export const OPPORTUNITY_ITEM_ERP_PRICE_DIFFERS_LABEL = "Preço diferente do ERP atual";

// "2,5" ou "2.5" → 2.5; vazio → 0; texto inválido → NaN.
export const parseDiscountPercentInput = (value: string) => {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const toCents = (value: number) => Math.round(value * 100);

// Mesma conta da API e do pedido ERP. Item antigo com desconto em R$ mantém a conta antiga só para exibição.
export const opportunityItemAmounts = (item: OpportunityItemPolicyInput) => {
  const quantity = Number(item.quantity || 0);
  const unitPrice = Number(item.unitPrice || 0);
  if (item.discountType === "value") {
    const grossCents = toCents(quantity * unitPrice);
    const discountCents = Math.min(grossCents, Math.max(0, toCents(Number(item.discountValue || 0))));
    return { grossTotal: grossCents / 100, discountTotal: discountCents / 100, netTotal: (grossCents - discountCents) / 100 };
  }
  const discountPercent = parseDiscountPercentInput(item.discountValue);
  return computeOpportunityItemAmounts({ quantity, unitPrice, discountPercent: Number.isNaN(discountPercent) ? 0 : discountPercent });
};

// Mensagem que bloqueia o item (desconto em R$, % inválido ou acima do limite do perfil); null quando pode salvar.
export const opportunityItemDiscountError = (policy: CommercialPolicy, role: unknown, item: OpportunityItemPolicyInput) => {
  if (item.discountType === "value") return Number(item.discountValue || 0) > 0 ? "Desconto só em %: informe o percentual de desconto." : null;
  const percent = parseDiscountPercentInput(item.discountValue);
  if (Number.isNaN(percent)) return "Informe o desconto em %.";
  const check = checkItemDiscount(policy, role, percent);
  return check.ok ? null : check.message;
};

// Aviso da política sempre que houver desconto maior que zero.
export const opportunityItemDiscountWarning = (policy: CommercialPolicy, item: OpportunityItemPolicyInput) => {
  const percent = item.discountType === "percent" ? parseDiscountPercentInput(item.discountValue) : Number(item.discountValue || 0);
  return percent > 0 ? policy.discountWarning : null;
};

// Ao editar, o preço volta ao do ERP atual e o desconto passa a ser em % (desconto antigo em R$ precisa ser informado de novo).
export const opportunityItemDraftForEdit = <T extends OpportunityItemPolicyInput>(item: T): T & { legacyValueDiscount: boolean } => ({
  ...item,
  unitPrice: typeof item.erpUnitPrice === "number" ? String(item.erpUnitPrice) : item.unitPrice,
  discountType: "percent",
  discountValue: item.discountType === "percent" ? item.discountValue : "0",
  legacyValueDiscount: item.discountType === "value" && Number(item.discountValue || 0) > 0
});
