import {
  addDisciplineItems,
  addNotDoneReasons,
  classifyDisciplineItems,
  emptyDisciplineTotals,
  emptyNotDoneReasonCounts,
  mapAgendaDbStatusToDiscipline,
  type DisciplineTotals,
  type NotDoneReasonCounts
} from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import type { DayRange } from "../utils/dateRange.js";

export type AgendaDisciplineDetail = { totals: DisciplineTotals; notDoneByReason: NotDoneReasonCounts };

// Planejado × concluído da Agenda por vendedor (regra em @salesforce-pro/shared/agendaDiscipline), com os
// "não realizados" contados por motivo (Agenda e Rota no mesmo catálogo).
// Os compromissos entram pelo início (startDateTime) dentro do período.
export const loadAgendaDisciplineDetailBySeller = async (
  startDateTime: DayRange,
  sellerId?: string,
  now: Date = new Date()
): Promise<Record<string, AgendaDisciplineDetail>> => {
  const events = await prisma.agendaEvent.findMany({
    where: {
      startDateTime,
      status: { not: "vencido" },
      ...(sellerId ? { sellerId } : {})
    },
    select: {
      sellerId: true,
      type: true,
      status: true,
      startDateTime: true,
      endDateTime: true,
      notDoneReason: true,
      stops: { select: { resultStatus: true, checkOutAt: true, resultReason: true, resultSummary: true } },
      activities: { where: { done: true }, select: { date: true }, orderBy: { date: "asc" }, take: 1 }
    }
  });

  return events.reduce<Record<string, AgendaDisciplineDetail>>((acc, event) => {
    const items = classifyDisciplineItems(
      {
        type: event.type,
        status: mapAgendaDbStatusToDiscipline(event.status),
        startDateTime: event.startDateTime,
        endDateTime: event.endDateTime,
        stops: event.stops,
        completedAt: event.activities[0]?.date ?? null,
        notDoneReason: event.notDoneReason
      },
      now
    );
    const current = acc[event.sellerId] || { totals: emptyDisciplineTotals(), notDoneByReason: emptyNotDoneReasonCounts() };
    acc[event.sellerId] = {
      totals: addDisciplineItems(current.totals, items),
      notDoneByReason: addNotDoneReasons(current.notDoneByReason, items)
    };
    return acc;
  }, {});
};

export const loadAgendaDisciplineBySeller = async (
  startDateTime: DayRange,
  sellerId?: string,
  now: Date = new Date()
): Promise<Record<string, DisciplineTotals>> => {
  const detail = await loadAgendaDisciplineDetailBySeller(startDateTime, sellerId, now);
  return Object.fromEntries(Object.entries(detail).map(([id, item]) => [id, item.totals]));
};
