import type { Prisma } from "@prisma/client";
import { brazilDayRange, calendarDayRange } from "./dateRange.js";

// Filtros de período de oportunidades. closedAt é instante (dia de Brasília); proposalDate e
// expectedCloseDate são data pura gravada como meia-noite UTC (dia de calendário).

// Ganho/perdido no período: pela data de fechamento ou, sem ela, pela previsão de fechamento.
export const closedOpportunityPeriodWhere = (from?: string, to?: string): Prisma.OpportunityWhereInput => ({
  OR: [
    { closedAt: brazilDayRange(from, to)! },
    { closedAt: null, expectedCloseDate: calendarDayRange(from, to)! }
  ]
});

// Filtro "Data de entrada" da lista de oportunidades; encerradas usam a data de fechamento.
export const opportunityPeriodWhere = (status: string, from?: string, to?: string): Prisma.OpportunityWhereInput =>
  status === "closed" ? closedOpportunityPeriodWhere(from, to) : { proposalDate: calendarDayRange(from, to)! };
