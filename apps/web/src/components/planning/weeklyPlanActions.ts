export type PlanningAction = {
  type: "visit" | "call" | "proposal" | "follow_up" | "whatsapp" | "review";
  clientId?: string | null;
  opportunityId?: string | null;
  title: string;
  city?: string | null;
  score: number;
  priorityLevel: "urgente" | "alta" | "normal" | "baixa";
  reason: string;
  objective: string;
  suggestedPeriod: "morning" | "afternoon" | null;
  estimatedDurationMinutes: number;
  source: string;
};

// Tipo da Nova atividade preenchida pelo "Registrar".
const activityTypeFor: Record<PlanningAction["type"], string> = {
  visit: "visita",
  call: "ligacao",
  proposal: "proposta_enviada",
  follow_up: "followup",
  whatsapp: "whatsapp",
  review: "followup"
};

// Horário que a janela do "Agendar" traz preenchido: tarde às 14h; manhã e período flexível às 9h.
export const defaultScheduleTime = (action: PlanningAction) => (action.suggestedPeriod === "afternoon" ? "14:00" : "09:00");

// Tipo do compromisso no catálogo único da Agenda; follow-up e revisão viram ligação (followup é legado).
const agendaTypeFor: Record<PlanningAction["type"], string> = {
  visit: "visita",
  call: "ligacao",
  proposal: "proposta",
  follow_up: "ligacao",
  whatsapp: "whatsapp",
  review: "ligacao"
};

// "Agendar" vira compromisso da Agenda no dia e horário confirmados na janela, sempre em horário de Brasília.
export const toAgendaEvent = (action: PlanningAction, date: string, sellerId: string, time = defaultScheduleTime(action), durationMinutes = action.estimatedDurationMinutes) => {
  const startsAt = new Date(`${date}T${time}:00-03:00`);
  return {
    title: action.title,
    type: agendaTypeFor[action.type],
    startDateTime: startsAt.toISOString(),
    endDateTime: new Date(startsAt.getTime() + durationMinutes * 60_000).toISOString(),
    ...(action.clientId ? { clientId: action.clientId } : {}),
    ...(action.opportunityId ? { opportunityId: action.opportunityId } : {}),
    ...(action.city ? { city: action.city } : {}),
    notes: action.objective,
    ownerSellerId: sellerId
  };
};

// "Registrar" abre a Nova atividade em Atividades já preenchida e marcada como realizada.
export const registerHref = (action: PlanningAction, date: string, sellerId: string) => {
  const params = new URLSearchParams({ open: "create", date, type: activityTypeFor[action.type], ownerSellerId: sellerId, notes: action.title, executed: "true" });
  if (action.clientId) params.set("clientId", action.clientId);
  if (action.opportunityId) params.set("opportunityId", action.opportunityId);
  if (action.city) params.set("city", action.city);
  return `/atividades?${params.toString()}`;
};

// "Abrir": a oportunidade, ou o cliente quando a sugestão não tem oportunidade (reativação).
export const openHref = (action: PlanningAction) => (action.opportunityId ? `/oportunidades/${action.opportunityId}` : action.clientId ? `/clientes/${action.clientId}` : null);

// Vendedor age só nas próprias sugestões; gerente e diretor criam no nome do vendedor do planejamento, como em Atividades e Agenda.
export const canActOnPlan = (viewer: { id: string; role: string } | null | undefined, planSellerId: string) => Boolean(viewer && (viewer.role !== "vendedor" || viewer.id === planSellerId));
