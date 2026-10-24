import {
  addDisciplineItems,
  classifyDisciplineItems,
  emptyDisciplineTotals,
  mapAgendaDbStatusToDiscipline,
  type DisciplineTotals
} from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import type { DayRange } from "../utils/dateRange.js";

// Planejado × concluído da Agenda por vendedor (regra em @salesforce-pro/shared/agendaDiscipline).
// Os compromissos entram pelo início (startDateTime) dentro do período.
export const loadAgendaDisciplineBySeller = async (
  startDateTime: DayRange,
  sellerId?: string,
  now: Date = new Date()
): Promise<Record<string, DisciplineTotals>> => {
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
      stops: { select: { resultStatus: true, checkOutAt: true } },
      activities: { where: { done: true }, select: { date: true }, orderBy: { date: "asc" }, take: 1 }
    }
  });

  return events.reduce<Record<string, DisciplineTotals>>((acc, event) => {
    const items = classifyDisciplineItems(
      {
        type: event.type,
        status: mapAgendaDbStatusToDiscipline(event.status),
        startDateTime: event.startDateTime,
        endDateTime: event.endDateTime,
        stops: event.stops,
        completedAt: event.activities[0]?.date ?? null
      },
      now
    );
    acc[event.sellerId] = addDisciplineItems(acc[event.sellerId] || emptyDisciplineTotals(), items);
    return acc;
  }, {});
};
