const normalizeCode = (value: unknown) => String(value ?? "").trim().replace(/^0+(?=\d)/, "");

const firstValue = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
};

const parseNumber = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Resolve a variation only from the ERP rule for the requested table/group. */
export const resolveErpPriceVariationPercent = (
  rows: unknown[],
  tableCode: string,
  productGroupCode: string,
  now = new Date(),
) => {
  const requestedTable = normalizeCode(tableCode);
  const requestedGroup = normalizeCode(productGroupCode);
  if (!requestedTable || !requestedGroup) return null;
  const unsupportedConstraintKeys = [
    "PRODUTO", "CODPRODUTO", "PRODUTO_CLAS", "CODPRODUTO_CLAS", "CODFILIAL",
    "PRAZO_MEDIO", "FORMA", "CODCONDREC", "GRUPO_FISCAL", "PARCEIRO", "CIDADE",
    "UF", "MARCA", "CATEGORIA", "CREDENCIAL", "NIVEL_AGRUPAMENTO",
  ];
  const candidates: Array<{ percent: number; validFrom: number; changedAt: number }> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const rowTable = normalizeCode(firstValue(record, ["CODTABELA", "COD_TABELA", "TABELA", "priceTableCode", "tabela", "code"]));
    if (!rowTable || rowTable !== requestedTable) continue;
    const rowGroup = normalizeCode(firstValue(record, ["CODGRUPO", "COD_GRUPO", "groupCode", "codigoGrupo", "grupo"]));
    if (!rowGroup || rowGroup !== requestedGroup) continue;
    if (unsupportedConstraintKeys.some((key) => firstValue(record, [key]) !== null)) continue;
    const validRaw = firstValue(record, ["DATA_VIGENCIA", "DTA_VIGENCIA", "DTAVIGENCIA", "validFrom"]);
    const validFrom = validRaw ? new Date(String(validRaw)).getTime() : 0;
    if (validRaw && (Number.isNaN(validFrom) || validFrom > now.getTime())) continue;
    const percent = parseNumber(firstValue(record, ["PER_VARIACAO", "PERC_VARIACAO", "PERCENTUAL", "percent", "variationPercent", "VARIACAO"]));
    if (percent === null) continue;
    const changedRaw = firstValue(record, ["DTAALTER", "DTA_ALTER", "sourceChangedAt"]);
    const changedAt = changedRaw ? new Date(String(changedRaw)).getTime() : 0;
    candidates.push({ percent, validFrom, changedAt: Number.isNaN(changedAt) ? 0 : changedAt });
  }
  return candidates.sort((left, right) => right.validFrom - left.validFrom || right.changedAt - left.changedAt)[0]?.percent ?? null;
};

export const calculatePriceFromErpVariation = (basePrice: number, percent: number) => {
  if (!Number.isFinite(basePrice) || basePrice <= 0 || !Number.isFinite(percent)) return 0;
  const percentDecimal = Math.abs(percent) < 1 ? percent : percent / 100;
  return Number((basePrice * (1 + percentDecimal)).toFixed(2));
};

export const orderPriceAuthoritySteps = <T extends { scope: string }>(steps: T[]) => {
  const commercialOrder = ["products", "priceTables", "priceVariations", "prices"];
  const positions = commercialOrder.map((scope) => steps.findIndex((step) => step.scope === scope));
  if (positions.some((position) => position < 0)) throw new Error("Fluxo ERP sem etapas comerciais obrigatórias.");
  const commercialSteps = commercialOrder.map((scope) => steps.find((step) => step.scope === scope)!);
  const firstPosition = Math.min(...positions);
  return [
    ...steps.slice(0, firstPosition).filter((step) => !commercialOrder.includes(step.scope)),
    ...commercialSteps,
    ...steps.slice(firstPosition).filter((step) => !commercialOrder.includes(step.scope)),
  ];
};

export const shouldSweepAbsentPrices = (snapshotComplete: boolean) => snapshotComplete;
