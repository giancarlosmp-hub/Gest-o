import { prisma } from "../config/prisma.js";

// Última visita do cliente, de qualquer vendedor: o último check-out de parada de roteiro ou a última atividade
// presencial realizada (data da atividade; sem ela, o vencimento). AgendaStop não tem índice em clientId: a consulta lê
// a tabela de paradas, aceito com o cache do planejamento (TD-PLANNING-VISIT-SUGGESTIONS).
export const IN_PERSON_ACTIVITY_TYPES = ["visita", "visita_tecnica", "reuniao_presencial"] as const;

export const loadLastVisitByClient = async (clientIds: string[]) => {
  const lastVisit = new Map<string, Date>();
  if (!clientIds.length) return lastVisit;
  const inPerson = { clientId: { in: clientIds }, done: true, type: { in: [...IN_PERSON_ACTIVITY_TYPES] } };
  const [stops, datedActivities, undatedActivities] = await Promise.all([
    prisma.agendaStop.groupBy({ by: ["clientId"], where: { clientId: { in: clientIds }, checkOutAt: { not: null } }, _max: { checkOutAt: true } }),
    prisma.activity.groupBy({ by: ["clientId"], where: { ...inPerson, date: { not: null } }, _max: { date: true } }),
    prisma.activity.groupBy({ by: ["clientId"], where: { ...inPerson, date: null }, _max: { dueDate: true } })
  ]);
  const keep = (clientId: string | null, date: Date | null | undefined) => {
    if (!clientId || !date) return;
    const current = lastVisit.get(clientId);
    if (!current || date > current) lastVisit.set(clientId, date);
  };
  for (const row of stops) keep(row.clientId, row._max.checkOutAt);
  for (const row of datedActivities) keep(row.clientId, row._max.date);
  for (const row of undatedActivities) keep(row.clientId, row._max.dueDate);
  return lastVisit;
};
