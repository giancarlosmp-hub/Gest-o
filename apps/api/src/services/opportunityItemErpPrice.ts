import { prisma } from "../config/prisma.js";
import { isSynchronizedProduct } from "./opportunityPriceRules.js";
import {
  calculateOpportunityPriceForTable,
  isOpportunityProductSelectable,
  normalizeOpportunityPriceTableCode,
  type OpportunityPriceProduct
} from "./opportunityPriceService.js";

// Preço do item de oportunidade: sempre o do ERP para a tabela da oportunidade, com a mesma regra da busca de produtos
// (/products/search). O valor que a tela manda é ignorado.
type ErpPricedProduct = OpportunityPriceProduct & { isActive: boolean; isSuspended: boolean; rawErpPayload?: unknown };

export type ErpUnitPrice = { price: number; selectable: boolean; priceTableCode: string };

export const resolveErpUnitPrice = (product: ErpPricedProduct, priceTableCode: string | null | undefined): ErpUnitPrice => {
  const tableCode = normalizeOpportunityPriceTableCode(priceTableCode);
  const picked = calculateOpportunityPriceForTable({ product, priceTableCode: tableCode });
  const selectable = isOpportunityProductSelectable({
    isActive: product.isActive,
    isSuspended: product.isSuspended,
    isSynchronized: isSynchronizedProduct(product as Parameters<typeof isSynchronizedProduct>[0]),
    price: picked.price,
    priceTableMatched: picked.priceTableMatched
  });
  return { price: selectable ? Number(picked.price.toFixed(2)) : 0, selectable, priceTableCode: tableCode };
};

export const erpPriceUnavailableMessage = (priceTableCode: string) =>
  `Produto sem preço válido no ERP para a tabela ${priceTableCode}. O preço não pode ser digitado no CRM.`;

// Preço gravado diferente do preço atual do ERP (comparado em centavos). Produto sem preço no ERP conta como diferente.
export const isErpPriceDifferent = (unitPrice: number, erp: ErpUnitPrice | undefined) =>
  !erp || !erp.selectable || Math.round(Number(unitPrice) * 100) !== Math.round(erp.price * 100);

export const loadErpUnitPrices = async (productIds: Array<string | null | undefined>, priceTableCode: string | null | undefined) => {
  const ids = [...new Set(productIds.filter((id): id is string => Boolean(id)))];
  const result = new Map<string, ErpUnitPrice>();
  if (!ids.length) return result;
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, include: { prices: { orderBy: [{ validFrom: "desc" }] } } });
  for (const product of products) result.set(product.id, resolveErpUnitPrice(product, priceTableCode));
  return result;
};

export const ERP_PRICE_DIFFERS_LABEL = "Preço diferente do ERP atual";
