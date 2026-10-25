// Classificação da carteira pela última compra real: a data do ERP (Client.lastPurchaseDate, com
// fallback DATA_ULTFATURA) ou um pedido do CRM já enviado ao ERP (status sent) mais recente que ela.
// Meses contados em dias de Brasília (UTC-3 fixo, como apps/api/src/utils/dateRange.ts).
// Bordas: compra exatamente 12 meses atrás ainda é "ativo"; exatamente 24 meses ainda é "inativoRecente".
export type PortfolioStatus = "ativo" | "inativoRecente" | "exCliente" | "prospect";

export const PORTFOLIO_STATUS_LABELS: Record<PortfolioStatus, string> = {
  ativo: "Ativo",
  inativoRecente: "Inativo recente",
  exCliente: "Ex-cliente",
  prospect: "Prospect"
};

export const PORTFOLIO_STATUSES = Object.keys(PORTFOLIO_STATUS_LABELS) as PortfolioStatus[];

export const isPortfolioStatus = (value: unknown): value is PortfolioStatus =>
  typeof value === "string" && (PORTFOLIO_STATUSES as string[]).includes(value);

const BRAZIL_UTC_OFFSET_MS = 3 * 3_600_000;

type DateInput = Date | string | null | undefined;

const toValidDate = (value: DateInput) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Dia de Brasília como número comparável AAAAMMDD.
const brazilDayNumber = (instant: Date) => {
  const shifted = new Date(instant.getTime() - BRAZIL_UTC_OFFSET_MS);
  return shifted.getUTCFullYear() * 10000 + (shifted.getUTCMonth() + 1) * 100 + shifted.getUTCDate();
};

// Mesmo dia do mês, N meses antes (29/02 vira 28/02 quando o ano não é bissexto).
const brazilDayNumberMonthsBefore = (now: Date, months: number) => {
  const shifted = new Date(now.getTime() - BRAZIL_UTC_OFFSET_MS);
  const totalMonths = shifted.getUTCFullYear() * 12 + shifted.getUTCMonth() - months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return year * 10000 + (month + 1) * 100 + Math.min(shifted.getUTCDate(), lastDay);
};

// Dia de Brasília da compra mais recente entre as duas fontes; null quando nenhuma é válida.
const lastPurchaseDayNumber = (lastErpPurchase: DateInput, lastSentCrmOrder: DateInput) => {
  const candidates = [toValidDate(lastErpPurchase), toValidDate(lastSentCrmOrder)].filter((date): date is Date => date !== null);
  if (candidates.length === 0) return null;
  return brazilDayNumber(new Date(Math.max(...candidates.map((date) => date.getTime()))));
};

export const classifyPortfolioStatus = (lastErpPurchase: DateInput, lastSentCrmOrder: DateInput, now: Date): PortfolioStatus => {
  const lastPurchaseDay = lastPurchaseDayNumber(lastErpPurchase, lastSentCrmOrder);
  if (lastPurchaseDay === null) return "prospect";
  if (lastPurchaseDay >= brazilDayNumberMonthsBefore(now, 12)) return "ativo";
  if (lastPurchaseDay >= brazilDayNumberMonthsBefore(now, 24)) return "inativoRecente";
  return "exCliente";
};

export const COOLING_ACTIVE_MONTHS = 9;

// "Esfriando": alerta preventivo, não é uma 5ª situação. Cliente ativo cuja última compra foi há mais de
// 9 meses. Bordas no dia de Brasília: exatamente 9 meses ainda não esfria; 12 meses ainda é ativo e esfria.
export const isCoolingActive = (lastErpPurchase: DateInput, lastSentCrmOrder: DateInput, now: Date): boolean => {
  if (classifyPortfolioStatus(lastErpPurchase, lastSentCrmOrder, now) !== "ativo") return false;
  const lastPurchaseDay = lastPurchaseDayNumber(lastErpPurchase, lastSentCrmOrder)!;
  return lastPurchaseDay < brazilDayNumberMonthsBefore(now, COOLING_ACTIVE_MONTHS);
};

// Filtro "Esfriando" da lista de clientes (?status=esfriando): recorte de "ativo" pela regra acima, ao lado das
// quatro situações no mesmo parâmetro. Como no alerta da Central do Dia, cliente em cobrança fica de fora.
export const COOLING_STATUS_FILTER = "esfriando";
export const COOLING_STATUS_FILTER_LABEL = "Esfriando";

export type ClientStatusFilter = PortfolioStatus | typeof COOLING_STATUS_FILTER;

export const isClientStatusFilter = (value: unknown): value is ClientStatusFilter => value === COOLING_STATUS_FILTER || isPortfolioStatus(value);
