import { z } from "zod";

// Política comercial dos itens de oportunidade. O preço é sempre o do ERP (a API recalcula); o vendedor só dá
// desconto em %, limitado por perfil. Uma regra só para a tela, a API e o pedido ERP: os totais do item saem de
// computeOpportunityItemAmounts e o limite de checkItemDiscount.
export const COMMERCIAL_POLICY_ROLES = ["vendedor", "gerente", "diretor"] as const;
export type CommercialPolicyRole = (typeof COMMERCIAL_POLICY_ROLES)[number];

export const DEFAULT_COMMERCIAL_POLICY_DISCOUNT_WARNING =
  "Descontos acima do limite da política comercial não são autorizados e implicam a perda do bônus.";

// 3% para todos os perfis, igual ao parâmetro "Limitar % desconto" do ERP: desconto maior é feito direto no ERP.
export const DEFAULT_COMMERCIAL_POLICY_MAX_DISCOUNT_PERCENT = 3;

const percentSchema = z.number().finite().min(0, "O limite não pode ser negativo.").max(100, "O limite não pode passar de 100%.");

export const commercialPolicySchema = z.object({
  enabled: z.boolean(),
  maxDiscountPercent: z.object({ vendedor: percentSchema, gerente: percentSchema, diretor: percentSchema }),
  discountWarning: z.string().trim().min(1, "Informe o texto do aviso.").max(500, "O aviso pode ter até 500 caracteres.")
});
export type CommercialPolicy = z.infer<typeof commercialPolicySchema>;

export const DEFAULT_COMMERCIAL_POLICY: CommercialPolicy = {
  enabled: true,
  maxDiscountPercent: {
    vendedor: DEFAULT_COMMERCIAL_POLICY_MAX_DISCOUNT_PERCENT,
    gerente: DEFAULT_COMMERCIAL_POLICY_MAX_DISCOUNT_PERCENT,
    diretor: DEFAULT_COMMERCIAL_POLICY_MAX_DISCOUNT_PERCENT
  },
  discountWarning: DEFAULT_COMMERCIAL_POLICY_DISCOUNT_WARNING
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// Lê a configuração gravada (JSON) campo a campo: campo ausente ou inválido volta ao padrão.
export const parseCommercialPolicy = (raw: unknown): CommercialPolicy => {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  const record = asRecord(value);
  const limits = asRecord(record.maxDiscountPercent);
  const limitOf = (role: CommercialPolicyRole) => {
    const parsed = percentSchema.safeParse(limits[role]);
    return parsed.success ? parsed.data : DEFAULT_COMMERCIAL_POLICY.maxDiscountPercent[role];
  };
  const warning = commercialPolicySchema.shape.discountWarning.safeParse(record.discountWarning);
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_COMMERCIAL_POLICY.enabled,
    maxDiscountPercent: { vendedor: limitOf("vendedor"), gerente: limitOf("gerente"), diretor: limitOf("diretor") },
    discountWarning: warning.success ? warning.data : DEFAULT_COMMERCIAL_POLICY.discountWarning
  };
};

const isPolicyRole = (role: unknown): role is CommercialPolicyRole =>
  COMMERCIAL_POLICY_ROLES.includes(role as CommercialPolicyRole);

// Limite de desconto do perfil. Política desligada: sem limite do CRM (o ERP continua validando o dele).
// Perfil desconhecido fica com o menor limite configurado.
export const maxDiscountPercentFor = (policy: CommercialPolicy, role: unknown): number | null => {
  if (!policy.enabled) return null;
  if (isPolicyRole(role)) return policy.maxDiscountPercent[role];
  return Math.min(...COMMERCIAL_POLICY_ROLES.map((item) => policy.maxDiscountPercent[item]));
};

const formatPercent = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

export type DiscountCheck = { ok: true } | { ok: false; message: string };

export const checkItemDiscount = (policy: CommercialPolicy, role: unknown, discountPercent: number): DiscountCheck => {
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    return { ok: false, message: "Desconto deve estar entre 0% e 100%." };
  }
  const limit = maxDiscountPercentFor(policy, role);
  if (limit !== null && discountPercent > limit) {
    return { ok: false, message: `Desconto máximo permitido: ${formatPercent(limit)}. ${policy.discountWarning}` };
  }
  return { ok: true };
};

// Totais do item em centavos: bruto = quantidade × preço; desconto = bruto × % arredondado PARA BAIXO no centavo
// (o ERP valida o próprio limite e nunca deve ver um % acima dele por arredondamento); líquido = bruto − desconto.
// É a mesma conta do pedido ERP (VALOR_BRUTO, VALOR_DESCONTO e VALOR_LIQUIDO de cada item).
export const computeOpportunityItemAmounts = (input: { quantity: number; unitPrice: number; discountPercent: number }) => {
  const quantity = Number(input.quantity) || 0;
  const unitPrice = Number(input.unitPrice) || 0;
  const discountPercent = Math.min(100, Math.max(0, Number(input.discountPercent) || 0));
  const grossCents = Math.round(quantity * unitPrice * 100);
  const discountCents = Math.min(grossCents, Math.floor((grossCents * discountPercent) / 100 + 1e-7));
  return {
    grossTotal: grossCents / 100,
    discountTotal: discountCents / 100,
    netTotal: (grossCents - discountCents) / 100
  };
};
