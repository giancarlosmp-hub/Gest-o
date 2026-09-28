export type ErpProductPriceObservation = {
  productCode: string;
  productClassCode: string;
  priceTableCode: string | null;
  branchCode: string | null;
  price: number | null;
  sourcePriceId: string | null;
  sourceValidFrom: Date | null;
  sourceChangedAt: Date | null;
};

const first = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
};

const text = (value: unknown) => value === null ? "" : String(value).trim();

const number = (value: unknown) => {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const date = (value: unknown) => {
  const raw = text(value);
  if (!raw) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const normalizeErpProductPriceObservation = (row: Record<string, unknown>): ErpProductPriceObservation => ({
  productCode: text(first(row, ["CODPRODUTO", "COD_PRODUTO", "productCode", "erpProductCode", "produto"])),
  productClassCode: text(first(row, ["CODPRODUTO_CLAS", "COD_PRODUTO_CLAS", "productClassCode", "erpProductClassCode", "classificacao"])),
  priceTableCode: text(first(row, ["TABELA", "CODTABELA", "COD_TABELA", "TABELA_PRECO", "priceTableCode", "tabela"])) || null,
  branchCode: text(first(row, ["CODFILIAL", "COD_FILIAL", "branchCode", "filial"])) || null,
  price: number(first(row, ["PRECO", "PRECO_LISTA", "VALOR", "price", "preco", "valor"])),
  sourcePriceId: text(first(row, ["PRECOS_ID", "PRECO_ID", "priceId", "erpPriceRecordId"])) || null,
  sourceValidFrom: date(first(row, ["DATA_VIGENCIA", "DTA_VIGENCIA", "validFrom", "vigencia"])),
  sourceChangedAt: date(first(row, ["DTAALTER", "DTA_ALTER", "sourceChangedAt", "updatedAtErp"])),
});

export const compareErpPriceCommercialVersion = (
  left: Pick<ErpProductPriceObservation, "sourceValidFrom" | "sourceChangedAt" | "sourcePriceId">,
  right: Pick<ErpProductPriceObservation, "sourceValidFrom" | "sourceChangedAt" | "sourcePriceId">,
) => {
  const validDifference = (right.sourceValidFrom?.getTime() ?? 0) - (left.sourceValidFrom?.getTime() ?? 0);
  if (validDifference) return validDifference;
  const changedDifference = (right.sourceChangedAt?.getTime() ?? 0) - (left.sourceChangedAt?.getTime() ?? 0);
  if (changedDifference) return changedDifference;
  return String(right.sourcePriceId ?? "").localeCompare(String(left.sourcePriceId ?? ""));
};

export const isErpPriceCurrentlyValid = (validFrom: Date | null, now = new Date()) =>
  !validFrom || validFrom.getTime() <= now.getTime();

export const selectCurrentErpPriceObservation = <T extends Pick<ErpProductPriceObservation, "sourceValidFrom" | "sourceChangedAt" | "sourcePriceId">>(
  observations: T[],
  now = new Date(),
) => observations
  .filter((observation) => isErpPriceCurrentlyValid(observation.sourceValidFrom, now))
  .sort(compareErpPriceCommercialVersion)[0];

/**
 * Mirrors the proven PRECO_VENDA candidate order for one already-equivalent
 * commercial context: current vigência first, exact branch only as a tie-break
 * over the null branch, then the ERP change clock. An absent requested branch
 * is not enough context and therefore fails closed.
 */
export const selectCurrentErpPriceObservationForBranch = <T extends Pick<
  ErpProductPriceObservation,
  "branchCode" | "sourceValidFrom" | "sourceChangedAt" | "sourcePriceId"
>>(
  observations: T[],
  requestedBranchCode: string | null | undefined,
  now = new Date(),
) => {
  const branch = text(requestedBranchCode);
  if (!branch) return undefined;
  return observations
    .filter((observation) => isErpPriceCurrentlyValid(observation.sourceValidFrom, now))
    .filter((observation) => !observation.branchCode || text(observation.branchCode) === branch)
    .sort((left, right) => {
      const validDifference = (right.sourceValidFrom?.getTime() ?? 0) - (left.sourceValidFrom?.getTime() ?? 0);
      if (validDifference) return validDifference;
      const branchDifference = Number(text(right.branchCode) === branch) - Number(text(left.branchCode) === branch);
      if (branchDifference) return branchDifference;
      const changedDifference = (right.sourceChangedAt?.getTime() ?? 0) - (left.sourceChangedAt?.getTime() ?? 0);
      if (changedDifference) return changedDifference;
      return String(right.sourcePriceId ?? "").localeCompare(String(left.sourcePriceId ?? ""));
    })[0];
};
