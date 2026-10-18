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

export const classifyPortfolioStatus = (lastErpPurchase: DateInput, lastSentCrmOrder: DateInput, now: Date): PortfolioStatus => {
  const candidates = [toValidDate(lastErpPurchase), toValidDate(lastSentCrmOrder)].filter((date): date is Date => date !== null);
  if (candidates.length === 0) return "prospect";
  const lastPurchaseDay = brazilDayNumber(new Date(Math.max(...candidates.map((date) => date.getTime()))));
  if (lastPurchaseDay >= brazilDayNumberMonthsBefore(now, 12)) return "ativo";
  if (lastPurchaseDay >= brazilDayNumberMonthsBefore(now, 24)) return "inativoRecente";
  return "exCliente";
};
