// Filtros "de D1 até D2" são dias de Brasília e incluem D1 e D2 inteiros.
// Brasília está em UTC-3 fixo desde o fim do horário de verão (2019), o mesmo deslocamento que
// normalizeDateToUtc em crudRoutes já usava.
const BRAZIL_UTC_OFFSET_HOURS = 3;
const DAY_MS = 86_400_000;

export type DayRange = { gte?: Date; lt?: Date; lte?: Date };

type ParsedBound = { kind: "day"; start: Date } | { kind: "instant"; value: Date } | null;

// YYYY-MM-DD vira o dia (meia-noite UTC); qualquer outro valor é tratado como instante já completo.
// Um YYYY-MM-DD impossível (30/02) é inválido, em vez de rolar para outro dia.
const parseBound = (value: string): ParsedBound => {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const start = new Date(Date.UTC(year, month - 1, day));
    const valid = start.getUTCFullYear() === year && start.getUTCMonth() === month - 1 && start.getUTCDate() === day;
    return valid ? { kind: "day", start } : null;
  }
  const instant = new Date(trimmed);
  return Number.isNaN(instant.getTime()) ? null : { kind: "instant", value: instant };
};

const buildRange = (from: string | undefined, to: string | undefined, offsetHours: number): DayRange | null => {
  const offsetMs = offsetHours * 3_600_000;
  const range: DayRange = {};
  if (from) {
    const bound = parseBound(from);
    if (!bound) return null;
    range.gte = bound.kind === "day" ? new Date(bound.start.getTime() + offsetMs) : bound.value;
  }
  if (to) {
    const bound = parseBound(to);
    if (!bound) return null;
    if (bound.kind === "day") range.lt = new Date(bound.start.getTime() + DAY_MS + offsetMs);
    else range.lte = bound.value;
  }
  return range;
};

// Para instantes reais (createdAt, closedAt): D1 00:00 de Brasília até o fim de D2 em Brasília.
export const brazilDayRange = (from?: string, to?: string) => buildRange(from, to, BRAZIL_UTC_OFFSET_HOURS);

// Para campos de data pura gravados como meia-noite UTC (proposalDate, expectedCloseDate), que a
// tela exibe pelo componente YYYY-MM-DD: o dia de Brasília é o próprio dia UTC.
export const calendarDayRange = (from?: string, to?: string) => buildRange(from, to, 0);

// Dia de Brasília de um instante, como YYYY-MM-DD (independe do fuso do servidor).
export const brazilDayKeyOf = (instant: Date) =>
  new Date(instant.getTime() - BRAZIL_UTC_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);

export const brazilTodayKey = () => brazilDayKeyOf(new Date());

// Soma dias a um YYYY-MM-DD.
export const shiftDayKey = (dayKey: string, days: number) =>
  new Date(Date.parse(`${dayKey}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

// Primeiro e último dia de um mês YYYY-MM, para usar com brazilDayRange/calendarDayRange.
export const monthDayBounds = (monthKey: string) => {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey.trim());
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return null;
  const lastDay = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return { from: `${match[1]}-${match[2]}-01`, to: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}` };
};
