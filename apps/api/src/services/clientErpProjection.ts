// Projeção dos dados financeiros do ERP devolvidos à tela. O payload bruto do ERP
// (financialProfile e partnerTitles) nunca sai da API: só as chaves abaixo.

export const CLIENT_FINANCIAL_PROFILE_ALLOWED_KEYS = [
  "DIAS_MEDIAATRASO",
  "DIAS_MAIORATRASO_AB",
  "QTD_CHEQUES_DEV",
  "VALOR_MEDIO",
  "DATA_PRIMFATURA",
  "DATA_ULTFATURA",
  "VALOR_ULTFATURA"
] as const;

export const CLIENT_PARTNER_TITLE_ALLOWED_KEYS = [
  "DOCTO",
  "PARCELA",
  "DATA_VENCIMENTO",
  "DSCFORMA",
  "VALOR",
  "SALDO_CAPITAL"
] as const;

export type ClientCreditAlertLevel = "ok" | "atencao" | "risco";

export type ClientCreditAlert = {
  level: ClientCreditAlertLevel;
  reasons: string[];
};

type ErpScalar = string | number | boolean | null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const isErpScalar = (value: unknown): value is ErpScalar =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const pickAllowed = (source: Record<string, unknown>, keys: readonly string[]) => {
  const output: Record<string, ErpScalar> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && isErpScalar(value)) output[key] = value;
  }
  return output;
};

export const projectClientFinancialProfile = (value: unknown): Record<string, ErpScalar> | null => {
  const record = asRecord(value);
  return record ? pickAllowed(record, CLIENT_FINANCIAL_PROFILE_ALLOWED_KEYS) : null;
};

export const projectClientPartnerTitles = (value: unknown): Record<string, ErpScalar>[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((title) => {
    const record = asRecord(title);
    return record ? [pickAllowed(record, CLIENT_PARTNER_TITLE_ALLOWED_KEYS)] : [];
  });
};

// Mesma conversão que a tela usava: vazio vira 0, "1.234,5" vira 1234.5.
const numberFromErp = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

const formatBrl = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);

const pluralDays = (days: number) =>
  `${days.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${days === 1 ? "dia" : "dias"}`;

const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const saoPauloDayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: SAO_PAULO_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** Dia civil (aaaa-mm-dd) de um instante no fuso de São Paulo. */
const saoPauloDay = (instant: Date) => saoPauloDayFormatter.format(instant);

const validDay = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : null;
};

/**
 * Vencimento do ERP como dia civil de São Paulo (aaaa-mm-dd). Hoje o ERP manda ISO com hora
 * ("2025-12-10T03:00:00.000Z" = meia-noite local); dd/mm/aaaa e dd.mm.aaaa são aceitos por defesa.
 */
export const parseErpDueDay = (value: unknown): string | null => {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : saoPauloDay(value);
  const text = value.trim();
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return validDay(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const instant = new Date(text);
    return Number.isNaN(instant.getTime()) ? null : saoPauloDay(instant);
  }
  const brazilian = text.match(/^(\d{2})[/.](\d{2})[/.](\d{4})$/);
  if (brazilian) return validDay(Number(brazilian[3]), Number(brazilian[2]), Number(brazilian[1]));
  return null;
};

const dayNumber = (day: string) => {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date) / MS_PER_DAY;
};

export type ClientDelayMetrics = {
  /** Dias corridos desde o vencimento mais antigo com saldo; null sem títulos ou sem data legível. */
  openDelayDays: number | null;
  overdueTitlesCount: number;
  /** aaaa-mm-dd (dia civil de São Paulo). */
  oldestOverdueDueDate: string | null;
  unparseableDueDates: number;
};

/**
 * Atraso em aberto calculado pelos títulos (partnerTitles), não pelo DIAS_MAIORATRASO_AB do ERP.
 * O título vence à meia-noite local do dia de vencimento: vencido no próprio dia conta 0 dias de
 * atraso, como no overdueTitlesTotal da sincronização.
 */
export const buildClientDelayMetrics = (partnerTitles: unknown, now = new Date()): ClientDelayMetrics => {
  const titles = Array.isArray(partnerTitles) ? partnerTitles.flatMap((title) => (asRecord(title) ? [asRecord(title)!] : [])) : [];
  const today = dayNumber(saoPauloDay(now));
  let oldestOverdue: string | null = null;
  let overdueTitlesCount = 0;
  let unparseableDueDates = 0;
  let withBalanceAndDate = 0;
  for (const title of titles) {
    if ((numberFromErp(title.SALDO_CAPITAL) ?? 0) <= 0) continue;
    const dueDay = parseErpDueDay(title.DATA_VENCIMENTO);
    if (!dueDay) {
      unparseableDueDates += 1;
      continue;
    }
    withBalanceAndDate += 1;
    if (dayNumber(dueDay) > today) continue;
    overdueTitlesCount += 1;
    if (!oldestOverdue || dueDay < oldestOverdue) oldestOverdue = dueDay;
  }
  const hasReadableData = titles.length > 0 && (withBalanceAndDate > 0 || unparseableDueDates === 0);
  return {
    openDelayDays: !hasReadableData ? null : oldestOverdue ? today - dayNumber(oldestOverdue) : 0,
    overdueTitlesCount,
    oldestOverdueDueDate: oldestOverdue,
    unparseableDueDates,
  };
};

const LEVEL_RANK: Record<ClientCreditAlertLevel, number> = { ok: 0, atencao: 1, risco: 2 };

/**
 * Regra de crédito que antes ficava no web (selo Verde/Amarelo/Vermelho do Perfil Financeiro ERP),
 * com os mesmos limites, mais os títulos vencidos (overdueTitlesTotal > 0 é risco). O maior atraso em
 * aberto vem dos títulos (buildClientDelayMetrics); DIAS_MAIORATRASO_AB do ERP não entra na regra.
 */
export const buildClientCreditAlert = (
  client: { financialProfile?: unknown; partnerTitles?: unknown; overdueTitlesTotal?: number | null },
  now = new Date()
): ClientCreditAlert => {
  const reasons: string[] = [];
  let level: ClientCreditAlertLevel = "ok";
  const raise = (to: ClientCreditAlertLevel) => {
    if (LEVEL_RANK[to] > LEVEL_RANK[level]) level = to;
  };

  const overdueTitlesTotal = typeof client.overdueTitlesTotal === "number" ? client.overdueTitlesTotal : 0;
  if (overdueTitlesTotal > 0) {
    raise("risco");
    reasons.push(`Cliente com títulos vencidos: ${formatBrl(overdueTitlesTotal)}`);
  }

  const delay = buildClientDelayMetrics(client.partnerTitles, now);
  const openDelay = delay.openDelayDays ?? 0;
  const profile = asRecord(client.financialProfile);
  const averageDelay = profile ? numberFromErp(profile.DIAS_MEDIAATRASO) : null;
  const bouncedChecks = profile ? numberFromErp(profile.QTD_CHEQUES_DEV) : null;
  const riskFromDelays = (averageDelay ?? 0) > 15 || openDelay > 0 || (bouncedChecks ?? 0) > 0;

  if ((averageDelay ?? 0) > 15) reasons.push(`Atraso médio de ${pluralDays(averageDelay!)}`);
  if (openDelay > 0) reasons.push(`Maior atraso em aberto: ${pluralDays(openDelay)}`);
  if ((bouncedChecks ?? 0) > 0) reasons.push(`${bouncedChecks} ${bouncedChecks === 1 ? "cheque devolvido" : "cheques devolvidos"}`);
  if (riskFromDelays) {
    raise("risco");
  } else if (profile && !(averageDelay === 0 && bouncedChecks === 0)) {
    // Amarelo no selo antigo: atraso médio entre 1 e 15 dias ou dados do ERP incompletos.
    raise("atencao");
    reasons.push(
      (averageDelay ?? 0) > 0
        ? `Atraso médio de ${pluralDays(averageDelay!)}`
        : "Dados de atraso do ERP incompletos; confira com o financeiro"
    );
  }

  if (delay.unparseableDueDates > 0) {
    raise("atencao");
    reasons.push(`${delay.unparseableDueDates} título(s) com vencimento ilegível no ERP; confira com o financeiro`);
  }

  return { level, reasons };
};

/** Cliente pronto para resposta HTTP: ERP só pela lista de permitidos, mais delayMetrics e creditAlert. */
export const projectClientForResponse = <T extends { financialProfile?: unknown; partnerTitles?: unknown; overdueTitlesTotal?: number | null }>(
  client: T
) => ({
  ...client,
  financialProfile: projectClientFinancialProfile(client.financialProfile),
  partnerTitles: projectClientPartnerTitles(client.partnerTitles),
  delayMetrics: buildClientDelayMetrics(client.partnerTitles),
  creditAlert: buildClientCreditAlert(client)
});
