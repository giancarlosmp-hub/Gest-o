import { brazilTodayKey, brazilWeekday, shiftBrazilDayKey } from "./brazilDate";
import { formatNumberBR, formatPercentBR } from "./formatters";

// "Minha semana" do vendedor no Dashboard: só os números dele, sem posição, medalha ou colegas.
// Disciplina (regra planejado × concluído da Agenda) e visitas feitas (pela data informada) vêm de
// /reports/discipline-ranking, que já devolve ao vendedor só a própria linha.

// Semana atual de segunda até hoje e o mesmo período da semana passada (segunda até o mesmo dia da
// semana), em dias de Brasília. Na segunda-feira, compara só a segunda.
export const sellerWeekRanges = (todayKey = brazilTodayKey()) => {
  const monday = shiftBrazilDayKey(todayKey, -((brazilWeekday(todayKey) + 6) % 7));
  return {
    current: { from: monday, to: todayKey },
    previous: { from: shiftBrazilDayKey(monday, -7), to: shiftBrazilDayKey(todayKey, -7) },
  };
};

export type SellerWeekDiscipline = {
  planned: number;
  executed: number;
  notDone: number;
  unresolved: number;
  upcoming?: number;
  executionRate: number;
  punctualRate: number;
  visitsDone?: number;
  visitGoal?: number;
};

export type SellerWeekData = {
  discipline: SellerWeekDiscipline | null;
  visitsDone: number;
  visitGoal: number | null;
};

// better/worse já considera o sentido do indicador: menos "não realizado" é melhor.
export type SellerWeekTone = "better" | "worse" | "same";

export type SellerWeekMetric = {
  key: "completed" | "executionRate" | "notDone" | "unresolved" | "punctualRate" | "visits";
  label: string;
  value: string;
  detail: string | null;
  comparison: string;
  tone: SellerWeekTone;
};

const EMPTY_DISCIPLINE: SellerWeekDiscipline = { planned: 0, executed: 0, notDone: 0, unresolved: 0, upcoming: 0, executionRate: 0, punctualRate: 0 };

const COMPARISON_LABEL = "vs. mesmo período da semana passada";

const toneOf = (current: number, previous: number, higherIsBetter: boolean): SellerWeekTone => {
  const diff = Math.round((current - previous) * 10) / 10;
  if (diff === 0) return "same";
  return diff > 0 === higherIsBetter ? "better" : "worse";
};

const signed = (value: string, diff: number) => (diff > 0 ? `+${value}` : diff < 0 ? `−${value}` : value);

const countComparison = (current: number, previous: number) => {
  const diff = current - previous;
  return `${COMPARISON_LABEL}: ${formatNumberBR(previous)} (${diff === 0 ? "igual" : signed(formatNumberBR(Math.abs(diff)), diff)})`;
};

const rateComparison = (current: number, previous: number) => {
  const diff = Math.round((current - previous) * 10) / 10;
  const points = `${formatPercentBR(Math.abs(diff)).replace("%", "")} p.p.`;
  return `${COMPARISON_LABEL}: ${formatPercentBR(previous)} (${diff === 0 ? "igual" : signed(points, diff)})`;
};

export const buildSellerWeekMetrics = (current: SellerWeekData, previous: SellerWeekData): SellerWeekMetric[] => {
  const now = current.discipline ?? EMPTY_DISCIPLINE;
  const before = previous.discipline ?? EMPTY_DISCIPLINE;
  const upcoming = now.upcoming ?? 0;

  return [
    {
      key: "completed",
      label: "Concluído / planejado",
      value: `${formatNumberBR(now.executed)}/${formatNumberBR(now.planned)}`,
      detail: upcoming > 0 ? `${formatNumberBR(upcoming)} ainda a fazer` : null,
      comparison: `${COMPARISON_LABEL}: ${formatNumberBR(before.executed)}/${formatNumberBR(before.planned)}`,
      tone: toneOf(now.executed, before.executed, true),
    },
    {
      key: "executionRate",
      label: "Execução",
      value: formatPercentBR(now.executionRate),
      detail: null,
      comparison: rateComparison(now.executionRate, before.executionRate),
      tone: toneOf(now.executionRate, before.executionRate, true),
    },
    {
      key: "notDone",
      label: "Não realizado",
      value: formatNumberBR(now.notDone),
      detail: null,
      comparison: countComparison(now.notDone, before.notDone),
      tone: toneOf(now.notDone, before.notDone, false),
    },
    {
      key: "unresolved",
      label: "Sem conclusão",
      value: formatNumberBR(now.unresolved),
      detail: null,
      comparison: countComparison(now.unresolved, before.unresolved),
      tone: toneOf(now.unresolved, before.unresolved, false),
    },
    {
      key: "punctualRate",
      label: "Pontualidade",
      value: formatPercentBR(now.punctualRate),
      detail: null,
      comparison: rateComparison(now.punctualRate, before.punctualRate),
      tone: toneOf(now.punctualRate, before.punctualRate, true),
    },
    {
      key: "visits",
      label: "Visitas da semana",
      value: formatNumberBR(current.visitsDone),
      detail: current.visitGoal ? `Meta semanal: ${formatNumberBR(current.visitGoal)}` : null,
      comparison: countComparison(current.visitsDone, previous.visitsDone),
      tone: toneOf(current.visitsDone, previous.visitsDone, true),
    },
  ];
};
