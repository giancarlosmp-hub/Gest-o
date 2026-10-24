import {
  addDisciplineItems,
  classifyDisciplineItems,
  emptyDisciplineTotals,
  mapAgendaDbStatusToDiscipline,
  type DisciplineTotals
} from "@salesforce-pro/shared";
import { brazilDayKeyOf, brazilTodayKey } from "./brazilDate";

// Central do Dia: o planejado vem da Agenda (compromissos), o feito vem das Atividades.
// A contagem usa a mesma regra da disciplina: cada parada de roteiro conta 1.

export type CentralAgendaStop = { resultStatus?: string | null; checkOutAt?: string | null };

export type CentralAgendaEvent = {
  id: string;
  title: string;
  type: string;
  status?: string;
  startsAt?: string;
  startDateTime?: string;
  endsAt?: string;
  endDateTime?: string;
  stops?: CentralAgendaStop[];
};

export type AgendaTodaySummary = { planned: number; completed: number; notDone: number; open: number };

const startOf = (event: CentralAgendaEvent) => event.startsAt || event.startDateTime || "";
const endOf = (event: CentralAgendaEvent) => event.endsAt || event.endDateTime || startOf(event);

// Compromissos do dia de Brasília, de qualquer status, menos o cancelamento antigo ("vencido").
export const agendaEventsOfToday = (events: CentralAgendaEvent[], now = new Date()) => {
  const todayKey = brazilTodayKey(now);
  return events
    .filter((event) => mapAgendaDbStatusToDiscipline(event.status ?? "planned") !== "cancelled")
    .filter((event) => startOf(event) && brazilDayKeyOf(startOf(event)) === todayKey)
    .sort((a, b) => new Date(startOf(a)).getTime() - new Date(startOf(b)).getTime());
};

export const summarizeAgendaToday = (events: CentralAgendaEvent[], now = new Date()): AgendaTodaySummary => {
  const totals = events.reduce<DisciplineTotals>(
    (acc, event) =>
      addDisciplineItems(
        acc,
        classifyDisciplineItems(
          {
            type: event.type,
            status: mapAgendaDbStatusToDiscipline(event.status ?? "planned"),
            startDateTime: startOf(event),
            endDateTime: endOf(event),
            stops: event.stops
          },
          now
        )
      ),
    emptyDisciplineTotals()
  );
  return {
    planned: totals.planned,
    completed: totals.completed,
    notDone: totals.notDone,
    open: totals.unresolved + totals.upcoming + totals.neutral
  };
};

// "3/6 paradas" para o roteiro; null para os demais compromissos.
export const routeStopsProgress = (event: CentralAgendaEvent) => {
  if (event.type !== "roteiro_visita" || !event.stops?.length) return null;
  const resolved = event.stops.filter((stop) => Boolean(stop.resultStatus)).length;
  return `${resolved}/${event.stops.length} paradas`;
};

export const AGENDA_STATUS_LABEL: Record<string, string> = {
  planned: "Agendado",
  completed: "Concluído",
  not_done: "Não realizado"
};

// Pendências de dias anteriores: compromissos ainda agendados que começaram antes de hoje (GET /agenda/pending).
export const previousDaysPendingCount = (events: CentralAgendaEvent[], now = new Date()) => {
  const todayKey = brazilTodayKey(now);
  return events.filter((event) => startOf(event) && brazilDayKeyOf(startOf(event)) < todayKey).length;
};
