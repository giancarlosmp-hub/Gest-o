// Dia e mês correntes em Brasília (America/Sao_Paulo), como YYYY-MM-DD e YYYY-MM, para os filtros
// de período. new Date().toISOString() usaria UTC e viraria o dia (ou o mês) às 21h de Brasília.
const brazilDateParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

export const brazilTodayKey = (now = new Date()) => {
  const parts = Object.fromEntries(brazilDateParts.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const brazilMonthKey = (now = new Date()) => brazilTodayKey(now).slice(0, 7);

// Data e hora de Brasília, qualquer que seja o fuso do aparelho. Brasília não tem horário de verão desde 2019:
// o deslocamento é sempre -03:00, como em toAgendaEvent (weeklyPlanActions).
export const BRAZIL_TIME_ZONE = "America/Sao_Paulo";
const BRAZIL_OFFSET = "-03:00";
const DAY_MS = 86_400_000;

const brazilTimeParts = new Intl.DateTimeFormat("en-US", { timeZone: BRAZIL_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// HH:MM de Brasília de um instante.
export const brazilTimeKey = (value: Date | string = new Date()) => {
  const parts = Object.fromEntries(brazilTimeParts.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}`;
};

// Dia de Brasília (YYYY-MM-DD) de um instante em texto ISO.
export const brazilDayKeyOf = (value: Date | string) => brazilTodayKey(new Date(value));

// Instante de um dia e horário de Brasília.
export const brazilDateTime = (dayKey: string, time = "00:00") => new Date(`${dayKey}T${time}:00${BRAZIL_OFFSET}`);

export const brazilDayStart = (dayKey: string) => new Date(`${dayKey}T00:00:00.000${BRAZIL_OFFSET}`);
export const brazilDayEnd = (dayKey: string) => new Date(`${dayKey}T23:59:59.999${BRAZIL_OFFSET}`);

export const shiftBrazilDayKey = (dayKey: string, days: number) => new Date(Date.parse(`${dayKey}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// Dia da semana (0 = domingo) de um dia de Brasília.
export const brazilWeekday = (dayKey: string) => new Date(`${dayKey}T12:00:00Z`).getUTCDay();

// Minutos desde a meia-noite de Brasília, para posicionar o compromisso no calendário.
export const brazilMinutesOfDay = (value: Date | string) => {
  const [hour, minute] = brazilTimeKey(value).split(":").map(Number);
  return hour * 60 + minute;
};

// Valor do campo datetime-local em horário de Brasília, e o instante de volta.
export const toBrazilDateTimeInput = (value: Date | string) => `${brazilDayKeyOf(value)}T${brazilTimeKey(value)}`;
export const fromBrazilDateTimeInput = (value: string) => {
  const [dayKey, time = "00:00"] = value.split("T");
  return brazilDateTime(dayKey, time.slice(0, 5));
};

// Formatação pt-BR sempre no horário de Brasília. Um dia (YYYY-MM-DD) é formatado ao meio-dia, longe da virada.
export const formatBrazil = (value: Date | string, options: Intl.DateTimeFormatOptions) => new Date(value).toLocaleString("pt-BR", { ...options, timeZone: BRAZIL_TIME_ZONE });
export const formatBrazilDay = (dayKey: string, options: Intl.DateTimeFormatOptions) => formatBrazil(brazilDateTime(dayKey, "12:00"), options);
