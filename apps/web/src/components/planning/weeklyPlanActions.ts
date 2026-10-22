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

// "Agendar" vira compromisso da Agenda no dia da sugestão, em horário de Brasília: manhã às 9h, tarde às 14h.
// Só a visita é presencial; ligação, WhatsApp, follow-up, proposta e revisão entram como follow-up.
export const toAgendaEvent = (action: PlanningAction, date: string, sellerId: string) => {
  const startsAt = new Date(`${date}T${action.suggestedPeriod === "afternoon" ? "14:00" : "09:00"}:00-03:00`);
  return {
    title: action.title,
    type: action.type === "visit" ? "reuniao_presencial" : "followup",
    startDateTime: startsAt.toISOString(),
    endDateTime: new Date(startsAt.getTime() + action.estimatedDurationMinutes * 60_000).toISOString(),
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
