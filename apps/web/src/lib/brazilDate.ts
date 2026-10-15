// Dia e mês correntes em Brasília (America/Sao_Paulo), como YYYY-MM-DD e YYYY-MM, para os filtros
// de período. new Date().toISOString() usaria UTC e viraria o dia (ou o mês) às 21h de Brasília.
const brazilDateParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

export const brazilTodayKey = (now = new Date()) => {
  const parts = Object.fromEntries(brazilDateParts.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const brazilMonthKey = (now = new Date()) => brazilTodayKey(now).slice(0, 7);
