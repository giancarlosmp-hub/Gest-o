// "Quantos dias atrás" em dias de calendário de Brasília (UTC-3 fixo, como proposalNoResponse.ts):
// 0 = "hoje", 1 = "ontem", N ≥ 2 = "há N dias". Uma regra só para o Resumo inteligente da Timeline e as
// telas que mostram dias de atraso. Data futura conta como hoje.
const BRAZIL_UTC_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

// Dia de Brasília como número de dias desde 01/01/1970.
const brazilDayIndex = (instant: Date) => Math.floor((instant.getTime() - BRAZIL_UTC_OFFSET_MS) / DAY_MS);

/** Dias de calendário de Brasília entre `earlier` e `later` (negativo quando `earlier` é depois). */
export const brazilCalendarDaysBetween = (earlier: Date, later: Date) => brazilDayIndex(later) - brazilDayIndex(earlier);

/** Texto para uma contagem de dias de calendário: "hoje", "ontem" ou "há N dias". */
export const relativeDaysLabel = (days: number) => {
  const whole = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;
  if (whole === 0) return "hoje";
  if (whole === 1) return "ontem";
  return `há ${whole} dias`;
};

/** Texto de quando `date` aconteceu em relação a `now`, pelo calendário de Brasília. */
export const relativeDaysSinceLabel = (date: Date, now: Date) => relativeDaysLabel(brazilCalendarDaysBetween(date, now));
