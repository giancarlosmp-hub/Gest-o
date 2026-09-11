const DEFAULT_OPPORTUNITY_PRICE_TABLE_CODE = "1";

export type OpportunityPriceProduct = {
  defaultPrice?: number | null;
  erpProductCode?: string | null;
  erpProductClassCode?: string | null;
  rawErpPayload?: unknown;
  prices?: Array<{ erpPriceId?: string | null; price: number; validFrom?: Date | null }>;
};

export type OpportunityPriceCalculationInput = {
  product: OpportunityPriceProduct;
  priceTableCode?: string | null;
  priceVariations?: unknown[];
  erpPrices?: unknown[];
  branchCode?: string | null;
};

export type OpportunityPriceCalculationResult = {
  price: number;
  priceTableCode: string;
  priceTableMatched: boolean;
  priceWarning: string | null;
  source: "product.PRECO" | "productPrice" | "rawProduct" | "priceVariation" | "prices" | "default" | "missing";
};

export const isOpportunityProductSelectable = (input: {
  isActive: boolean;
  isSuspended: boolean;
  isSynchronized: boolean;
  price: number;
  priceTableMatched: boolean;
}) => input.isActive
  && !input.isSuspended
  && input.isSynchronized
  && Number.isFinite(input.price)
  && input.price > 0
  && input.priceTableMatched;

const normalizeOptionalString = (value: unknown) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

export const normalizeOpportunityPriceTableCode = (value: unknown) => {
  const normalized = normalizeOptionalString(value);
  return normalized || DEFAULT_OPPORTUNITY_PRICE_TABLE_CODE;
};

const normalizeCode = (value: unknown) => normalizeOptionalString(value).replace(/^0+(?=\d)/, "");

const priceTableMatches = (current: string | null | undefined, requested: string) => {
  const normalizedCurrent = normalizeOpportunityPriceTableCode(current);
  if (normalizedCurrent === requested) return true;
  return requested === DEFAULT_OPPORTUNITY_PRICE_TABLE_CODE && (!current || normalizedCurrent === DEFAULT_OPPORTUNITY_PRICE_TABLE_CODE);
};

const parseNumber = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const parsePositiveNumber = (value: unknown) => {
  const parsed = parseNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const readFirst = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
};

const getProductBasePrice = (product: OpportunityPriceProduct) => {
  const synchronizedDefaultPrice = parseNumber(product.defaultPrice);
  if (synchronizedDefaultPrice !== null) return synchronizedDefaultPrice > 0 ? synchronizedDefaultPrice : 0;
  const raw = asRecord(product.rawErpPayload);
  return parsePositiveNumber(readFirst(raw, ["PRECO", "price", "defaultPrice", "preco", "salePrice", "valor"])) ?? 0;
};

const pickRawPriceForTable = (rawPayload: unknown, priceTableCode: string) => {
  const raw = asRecord(rawPayload);
  const compactCode = priceTableCode.replace(/\W/g, "");
  const candidateKeys = [
    `PRECO_TABELA_${priceTableCode}`,
    `PRECO_TABELA${compactCode}`,
    `PRECO_TAB_${priceTableCode}`,
    `PRECO_TAB${compactCode}`,
    `TABELA_${priceTableCode}_PRECO`,
    `TABELA${compactCode}_PRECO`,
    `PRECO${compactCode}`,
    priceTableCode === "1" ? "PRECO_REVENDA" : "PRECO_CONSUMIDOR_FINAL",
    priceTableCode === "1" ? "PRECO_COOPERATIVA" : "PRECO_CONSUMIDOR",
  ];
  for (const key of candidateKeys) {
    const price = parsePositiveNumber(raw[key]);
    if (price) return price;
  }

  for (const value of Object.values(raw)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      const record = asRecord(row);
      if (!Object.keys(record).length) continue;
      const tableCode = normalizeOpportunityPriceTableCode(readFirst(record, ["TABELA_PRECO", "CODTABELA", "COD_TABELA", "priceTableCode", "tabelaPreco", "tabela"]));
      if (tableCode !== priceTableCode) continue;
      const price = parsePositiveNumber(readFirst(record, ["PRECO", "PRECO_LISTA", "price", "preco", "valor"]));
      if (price) return price;
    }
  }

  return null;
};

const getProductGroupCode = (product: OpportunityPriceProduct) => {
  const raw = asRecord(product.rawErpPayload);
  return normalizeCode(readFirst(raw, ["CODGRUPO", "COD_GRUPO", "groupCode", "codigoGrupo", "grupoCodigo"]));
};

const findVariationPercent = (product: OpportunityPriceProduct, priceTableCode: string, priceVariations: unknown[]) => {
  const productGroupCode = getProductGroupCode(product);
  if (!productGroupCode) return null;

  for (const row of priceVariations) {
    const record = asRecord(row);
    if (!Object.keys(record).length) continue;
    const tableCode = normalizeOpportunityPriceTableCode(readFirst(record, ["TABELA", "CODTABELA", "COD_TABELA", "priceTableCode", "tabela"]));
    if (tableCode !== priceTableCode) continue;
    const groupCode = normalizeCode(readFirst(record, ["CODGRUPO", "COD_GRUPO", "groupCode", "codigoGrupo", "grupo"]));
    if (groupCode !== productGroupCode) continue;
    const percent = parsePositiveNumber(readFirst(record, ["PER_VARIACAO", "PERC_VARIACAO", "PERCENTUAL", "percent", "variationPercent"]));
    if (percent) return percent;
  }

  return null;
};

const findCalculatedPrice = (product: OpportunityPriceProduct, priceTableCode: string, erpPrices: unknown[]) => {
  const productCode = normalizeCode(product.erpProductCode);
  const productClassCode = normalizeCode(product.erpProductClassCode || "default");
  if (!productCode || !productClassCode) return null;

  for (const row of erpPrices) {
    const record = asRecord(row);
    if (!Object.keys(record).length) continue;
    const rowProductCode = normalizeCode(readFirst(record, ["CODPRODUTO", "COD_PRODUTO", "productCode", "erpProductCode", "produto"]));
    if (rowProductCode !== productCode) continue;
    const rowClassCode = normalizeCode(readFirst(record, ["CODPRODUTO_CLAS", "COD_PRODUTO_CLAS", "productClassCode", "erpProductClassCode", "classificacao"]));
    if (rowClassCode !== productClassCode) continue;
    const rowTableCode = readFirst(record, ["TABELA", "CODTABELA", "COD_TABELA", "priceTableCode", "tabela"]);
    if (rowTableCode && normalizeOpportunityPriceTableCode(rowTableCode) !== priceTableCode) continue;
    const price = parsePositiveNumber(readFirst(record, ["PRECO", "PRECO_LISTA", "VALOR", "price", "preco", "valor"]));
    if (price) return price;
  }

  return null;
};

export const calculateOpportunityPriceForTable = ({
  product,
  priceTableCode,
  priceVariations = [],
  erpPrices = [],
  branchCode,
}: OpportunityPriceCalculationInput): OpportunityPriceCalculationResult => {
  const normalizedPriceTableCode = normalizeOpportunityPriceTableCode(priceTableCode);
  const productPrices = product.prices || [];
  const normalizedBranchCode = normalizeOptionalString(branchCode);
  const selectedTableRows = productPrices.filter((item) => {
    if (!priceTableMatches(item.erpPriceId, normalizedPriceTableCode)) return false;
    const rowBranch = normalizeOptionalString((item as { branchCode?: string | null }).branchCode);
    return !normalizedBranchCode || rowBranch === normalizedBranchCode;
  });
  const hasExplicitInvalidSelectedTablePrice = selectedTableRows.some((item) => Number(item.price) <= 0);
  const tablePrice = hasExplicitInvalidSelectedTablePrice
    ? undefined
    : selectedTableRows.find((item) => Number(item.price) > 0);
  // ProductPrice is the sole availability authority. Product/default/min prices,
  // cached payloads and calculated-price caches are deliberately not fallbacks:
  // they can outlive a zero/absent price in the current ERP snapshot.
  const rawTablePrice = null;

  if (normalizedPriceTableCode === DEFAULT_OPPORTUNITY_PRICE_TABLE_CODE) {
    const selectedPrice = tablePrice?.price ?? 0;
    const source = tablePrice
      ? "productPrice"
        : "missing";
    return {
      price: Number(selectedPrice.toFixed(2)),
      priceTableCode: normalizedPriceTableCode,
      priceTableMatched: selectedPrice > 0,
      priceWarning: selectedPrice > 0 ? null : "Produto sem preço válido sincronizado para a tabela 1.",
      source,
    };
  }

  return {
    price: Number(tablePrice?.price ?? 0),
    priceTableCode: normalizedPriceTableCode,
    priceTableMatched: Boolean(tablePrice),
    priceWarning: tablePrice ? null : `Sem preço positivo sincronizado para a tabela ${normalizedPriceTableCode}.`,
    source: tablePrice ? "productPrice" : "missing",
  };
};
