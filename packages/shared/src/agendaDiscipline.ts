import {
  parseAgendaNotDoneReason,
  parseStopNotDoneReason,
  type AgendaNotDoneReasonCode,
  type NotDoneReasonCounts
} from "./agendaNotDoneReasons.js";

// Disciplina = planejado na Agenda × concluído (decisão da diretoria, 24/10/2026).
// Item planejado: cada parada de roteiro conta 1; compromisso avulso conta 1; roteiro sem paradas conta 1
// pelo status do compromisso. Compromisso "vencido" (cancelamento antigo) fica fora de tudo.
// Concluído: compromisso realizado ou parada realizada. Não realizado: com motivo. Sem conclusão: ainda
// agendado depois do fim. A fazer: agendado no futuro (entra no planejado, não na taxa).

// Corte do histórico: segunda 26/10/2026 00:00 de Brasília, primeira semana inteira com a tela
// "Executar roteiro". Antes dele, "sem conclusão" fica neutro (no roteiro aberto, cada parada neutra) e o
// roteiro antigo realizado sem paradas resolvidas conta 1 concluído.
export const DISCIPLINE_HISTORY_CUTOFF = new Date("2026-10-26T03:00:00.000Z");

// "Não realizado" fica neutro até 20% dos itens elegíveis do período; o excesso conta contra.
export const DISCIPLINE_NOT_DONE_NEUTRAL_SHARE = 0.2;

const BRAZIL_UTC_OFFSET_MS = 3 * 3_600_000;

export type DisciplineAgendaStatus = "open" | "completed" | "not_done" | "cancelled";

export type DisciplineStopInput = {
  resultStatus?: string | null;
  checkOutAt?: Date | string | null;
  resultReason?: string | null;
  resultSummary?: string | null;
};

export type DisciplineEventInput = {
  type: string;
  status: DisciplineAgendaStatus;
  startDateTime: Date | string;
  endDateTime: Date | string;
  stops?: DisciplineStopInput[];
  // Data informada na atividade vinculada (Activity.date), para a pontualidade.
  completedAt?: Date | string | null;
  // Motivo do compromisso "não realizado" (AgendaEvent.notDoneReason).
  notDoneReason?: string | null;
};

export type DisciplineOutcome = "completed" | "not_done" | "unresolved" | "upcoming" | "neutral";

// punctual: null quando não há data informada para comparar (fica fora da pontualidade).
// reason: só no "não realizado", pelo catálogo de motivos (registro antigo ou sem motivo conta como "outro").
export type DisciplineItem = { outcome: DisciplineOutcome; punctual: boolean | null; reason?: AgendaNotDoneReasonCode };

export type DisciplineTotals = {
  planned: number;
  completed: number;
  notDone: number;
  unresolved: number;
  upcoming: number;
  neutral: number;
  punctual: number;
  punctualMeasured: number;
};

export type DisciplineRates = {
  eligible: number;
  notDoneNeutral: number;
  executionRate: number;
  punctualRate: number;
};

const toTime = (value: Date | string) => new Date(value).getTime();
const brazilDayKey = (value: Date | string) => new Date(toTime(value) - BRAZIL_UTC_OFFSET_MS).toISOString().slice(0, 10);

// Pontual: concluído no mesmo dia (Brasília) em que estava planejado.
const isSameBrazilDay = (done: Date | string | null | undefined, planned: Date | string): boolean | null =>
  done ? brazilDayKey(done) === brazilDayKey(planned) : null;

export const mapAgendaDbStatusToDiscipline = (status: string): DisciplineAgendaStatus => {
  if (status === "realizado" || status === "completed") return "completed";
  if (status === "nao_realizado" || status === "not_done") return "not_done";
  if (status === "vencido" || status === "cancelled") return "cancelled";
  return "open";
};

export const classifyDisciplineItems = (event: DisciplineEventInput, now: Date = new Date()): DisciplineItem[] => {
  if (event.status === "cancelled") return [];
  const isLegacy = toTime(event.startDateTime) < DISCIPLINE_HISTORY_CUTOFF.getTime();
  const hasEnded = toTime(event.endDateTime) < now.getTime();
  const openOutcome: DisciplineOutcome = !hasEnded ? "upcoming" : isLegacy ? "neutral" : "unresolved";

  const eventNotDone = (): DisciplineItem => ({
    outcome: "not_done",
    punctual: null,
    reason: parseAgendaNotDoneReason(event.notDoneReason)?.code ?? "outro"
  });
  const byEventStatus = (): DisciplineItem => {
    if (event.status === "completed") return { outcome: "completed", punctual: isSameBrazilDay(event.completedAt, event.startDateTime) };
    if (event.status === "not_done") return eventNotDone();
    return { outcome: openOutcome, punctual: null };
  };

  const stops = event.type === "roteiro_visita" ? event.stops || [] : [];
  if (stops.length === 0) return [byEventStatus()];
  if (isLegacy && event.status === "completed" && stops.every((stop) => !stop.resultStatus)) return [byEventStatus()];

  return stops.map((stop) => {
    if (stop.resultStatus === "realizada") {
      return { outcome: "completed", punctual: isSameBrazilDay(stop.checkOutAt, event.startDateTime) };
    }
    if (stop.resultStatus === "nao_realizada") {
      return { outcome: "not_done", punctual: null, reason: parseStopNotDoneReason(stop.resultReason, stop.resultSummary)?.code ?? "outro" };
    }
    if (event.status === "not_done") return eventNotDone();
    return { outcome: openOutcome, punctual: null };
  });
};

export const emptyDisciplineTotals = (): DisciplineTotals => ({
  planned: 0,
  completed: 0,
  notDone: 0,
  unresolved: 0,
  upcoming: 0,
  neutral: 0,
  punctual: 0,
  punctualMeasured: 0
});

export const addDisciplineItems = (totals: DisciplineTotals, items: DisciplineItem[]): DisciplineTotals => {
  for (const item of items) {
    totals.planned += 1;
    if (item.outcome === "completed") totals.completed += 1;
    else if (item.outcome === "not_done") totals.notDone += 1;
    else if (item.outcome === "unresolved") totals.unresolved += 1;
    else if (item.outcome === "upcoming") totals.upcoming += 1;
    else totals.neutral += 1;
    if (item.punctual !== null) {
      totals.punctualMeasured += 1;
      if (item.punctual) totals.punctual += 1;
    }
  }
  return totals;
};

// Contagem dos "não realizados" por motivo (não muda a taxa: o teto de 20% neutro vale para todos os motivos).
export const addNotDoneReasons = (counts: NotDoneReasonCounts, items: DisciplineItem[]): NotDoneReasonCounts => {
  for (const item of items) {
    if (item.outcome === "not_done") counts[item.reason ?? "outro"] += 1;
  }
  return counts;
};

// Taxa de execução: concluídos ÷ (elegíveis − não realizados neutros). Elegíveis: concluídos, não
// realizados e sem conclusão. Sem item elegível, a taxa é 0.
export const computeDisciplineRates = (totals: DisciplineTotals): DisciplineRates => {
  const eligible = totals.completed + totals.notDone + totals.unresolved;
  const notDoneNeutral = Math.min(totals.notDone, eligible * DISCIPLINE_NOT_DONE_NEUTRAL_SHARE);
  const denominator = eligible - notDoneNeutral;
  return {
    eligible,
    notDoneNeutral,
    executionRate: denominator > 0 ? (totals.completed / denominator) * 100 : 0,
    punctualRate: totals.punctualMeasured > 0 ? (totals.punctual / totals.punctualMeasured) * 100 : 0
  };
};
