import { calculateOpportunityPriceForTable } from "./opportunityPriceService.js";

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

// Campos que prendem a regra a um contexto que o catálogo não tem (produto, filial, parceiro, cidade, UF, forma,
// condição etc.): preenchidos, a regra fica fora do preço de catálogo. ACRESCIMO_PESO e OPERADOR não são lidos.
const UNSUPPORTED_CONSTRAINT_KEYS = [
  "PRODUTO", "CODPRODUTO", "PRODUTO_CLAS", "CODPRODUTO_CLAS", "CODFILIAL",
  "FORMA", "CODCONDREC", "GRUPO_FISCAL", "PARCEIRO", "CIDADE", "CODCIDADE",
  "UF", "MARCA", "CATEGORIA", "CREDENCIAL", "NIVEL_AGRUPAMENTO",
];
// Prazo médio 999 (ou vazio/0) é "sem restrição de prazo" no ERP; prazo menor prende a regra ao prazo do pedido.
const UNRESTRICTED_AVERAGE_TERM = 999;
const BRAZIL_UTC_OFFSET_MS = 3 * 3_600_000;

// Dia (AAAA-MM-DD) de uma data do ERP: ISO (com ou sem hora) ou dd/mm/aaaa e dd.mm.aaaa. Fora disso, null.
const dayKeyOf = (value: unknown) => {
  const raw = String(value ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = /^(\d{2})[/.](\d{2})[/.](\d{4})/.exec(raw);
  return br ? `${br[3]}-${br[2]}-${br[1]}` : null;
};

export type ErpPriceVariationRuleStatus = "catalog" | "restricted" | "payment_term" | "out_of_validity" | "invalid";

/** Se a regra de variação vale para o preço de catálogo hoje (dia de Brasília) e, se não, por quê. */
export const classifyErpPriceVariationRule = (record: Record<string, unknown>, now = new Date()): ErpPriceVariationRuleStatus => {
  if (UNSUPPORTED_CONSTRAINT_KEYS.some((key) => firstValue(record, [key]) !== null)) return "restricted";
  const averageTerm = firstValue(record, ["PRAZO_MEDIO"]);
  if (averageTerm !== null) {
    const term = parseNumber(averageTerm);
    if (term === null) return "invalid";
    if (term > 0 && term < UNRESTRICTED_AVERAGE_TERM) return "payment_term";
  }
  const today = new Date(now.getTime() - BRAZIL_UTC_OFFSET_MS).toISOString().slice(0, 10);
  const startRaw = firstValue(record, ["DTA_VIGENCIA_INI", "DATA_VIGENCIA", "DTA_VIGENCIA", "DTAVIGENCIA", "validFrom"]);
  const endRaw = firstValue(record, ["DTA_VIGENCIA_FIN", "validTo"]);
  const start = startRaw === null ? null : dayKeyOf(startRaw);
  const end = endRaw === null ? null : dayKeyOf(endRaw);
  if ((startRaw !== null && !start) || (endRaw !== null && !end)) return "invalid";
  if ((start && start > today) || (end && end < today)) return "out_of_validity";
  return parseNumber(firstValue(record, ["PER_VARIACAO", "PERC_VARIACAO", "PERCENTUAL", "percent", "variationPercent", "VARIACAO"])) === null ? "invalid" : "catalog";
};

const ruleTable = (record: Record<string, unknown>) => normalizeCode(firstValue(record, ["CODTABELA", "COD_TABELA", "TABELA", "priceTableCode", "tabela", "code"]));
const ruleGroup = (record: Record<string, unknown>) => normalizeCode(firstValue(record, ["CODGRUPO", "COD_GRUPO", "groupCode", "codigoGrupo", "grupo"]));
const asRules = (rows: unknown[]) => rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));

/** Contagem das regras de uma tabela por situação, para o log da sincronização (sem dado de cliente). */
export const summarizeErpPriceVariationRules = (rows: unknown[], tableCode: string, now = new Date()) => {
  const counts: Record<ErpPriceVariationRuleStatus, number> = { catalog: 0, restricted: 0, payment_term: 0, out_of_validity: 0, invalid: 0 };
  for (const record of asRules(rows)) if (ruleTable(record) === normalizeCode(tableCode)) counts[classifyErpPriceVariationRule(record, now)] += 1;
  return counts;
};

/** Resolve a variation only from the ERP rule for the requested table/group that applies to the catalogue price. */
export const resolveErpPriceVariationPercent = (
  rows: unknown[],
  tableCode: string,
  productGroupCode: string,
  now = new Date(),
) => {
  const requestedTable = normalizeCode(tableCode);
  const requestedGroup = normalizeCode(productGroupCode);
  if (!requestedTable || !requestedGroup) return null;
  const candidates: Array<{ percent: number; validFrom: string; changedAt: number }> = [];
  for (const record of asRules(rows)) {
    const rowTable = ruleTable(record);
    if (!rowTable || rowTable !== requestedTable) continue;
    const rowGroup = ruleGroup(record);
    if (!rowGroup || rowGroup !== requestedGroup) continue;
    if (classifyErpPriceVariationRule(record, now) !== "catalog") continue;
    const percent = parseNumber(firstValue(record, ["PER_VARIACAO", "PERC_VARIACAO", "PERCENTUAL", "percent", "variationPercent", "VARIACAO"]))!;
    const validFrom = dayKeyOf(firstValue(record, ["DTA_VIGENCIA_INI", "DATA_VIGENCIA", "DTA_VIGENCIA", "DTAVIGENCIA", "validFrom"])) ?? "";
    const changedRaw = firstValue(record, ["DTAALTER", "DTA_ALTER", "sourceChangedAt"]);
    const changedAt = changedRaw ? new Date(String(changedRaw)).getTime() : 0;
    candidates.push({ percent, validFrom, changedAt: Number.isNaN(changedAt) ? 0 : changedAt });
  }
  return candidates.sort((left, right) => right.validFrom.localeCompare(left.validFrom) || right.changedAt - left.changedAt)[0]?.percent ?? null;
};

type VariationBaseRow = {
  erpPriceId?: string | null;
  branchCode?: string | null;
  price: number;
  validFrom?: Date | null;
  sourceChangedAt?: Date | null;
  source?: string | null;
  availabilityState?: string | null;
  erpSourcePriceId?: string | null;
};

/**
 * Base das tabelas derivadas: o preço da Tabela 1 sem filial com a mesma precedência da busca (linha explícita da
 * Tabela 1 que não seja zero estrutural, senão a linha de /prices sem tabela), sem linhas legacy nem de filial. O
 * registro mais novo de /prices (Tabela 1 ou sem tabela) com zero explícito bloqueia a base.
 */
export const resolveVariationBasePrice = (rows: VariationBaseRow[], now = new Date()) => {
  const eligible = rows.filter((row) =>
    row.source !== "legacy"
    && !String(row.branchCode ?? "").trim()
    && ["", "1"].includes(normalizeCode(row.erpPriceId))
    && (!row.validFrom || row.validFrom.getTime() <= now.getTime()));
  const newestFromPrices = eligible
    .filter((row) => row.source === "prices" && row.availabilityState !== "absent")
    .sort((left, right) => (right.validFrom?.getTime() ?? 0) - (left.validFrom?.getTime() ?? 0)
      || (right.sourceChangedAt?.getTime() ?? 0) - (left.sourceChangedAt?.getTime() ?? 0))[0];
  if (newestFromPrices && (newestFromPrices.availabilityState === "explicit_zero" || Number(newestFromPrices.price) <= 0)) return 0;
  const picked = calculateOpportunityPriceForTable({ product: { prices: eligible }, priceTableCode: "1" });
  return picked.priceTableMatched ? picked.price : 0;
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
