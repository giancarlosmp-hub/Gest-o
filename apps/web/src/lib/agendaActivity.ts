import { brazilDateTime, brazilDayKeyOf, brazilTimeKey, brazilTodayKey } from "./brazilDate";
import { isActivityCatalogType } from "../constants/activityTypes";

// Agenda planeja (compromissos) e Atividades registram o que foi feito. Regras de tela sem React, usadas pelas
// páginas e pelos testes; a API valida de novo.

export const isManagerRole = (role: string | null | undefined) => role === "gerente" || role === "diretor";

type AgendaEventLike = { type: string; status: "planned" | "completed" | "cancelled" | "not_done" };

// Botões de um compromisso. O roteiro é concluído pelas paradas; reabrir e excluir são de gerente e diretor.
export const agendaEventActions = (event: AgendaEventLike, role: string | null | undefined) => {
  const planned = event.status === "planned";
  const manager = isManagerRole(role);
  return {
    complete: planned && event.type !== "roteiro_visita",
    reschedule: planned,
    notDone: planned,
    reopen: !planned && manager,
    remove: manager
  };
};

// Tipo da atividade preenchida pelo "Concluir": proposta é gravada como proposta_enviada, o roteiro vira visita e
// os tipos legados (followup) caem em ligação, porque a Nova atividade só oferece o catálogo único.
export const activityTypeForAgendaType = (agendaType: string) => {
  if (agendaType === "roteiro_visita") return "visita";
  if (agendaType === "proposta") return "proposta_enviada";
  return isActivityCatalogType(agendaType) ? agendaType : "ligacao";
};

type CompletableEvent = {
  id: string;
  type: string;
  title: string;
  startsAt: string;
  ownerId: string;
  notes?: string | null;
  clientId?: string | null;
  opportunityId?: string | null;
  city?: string | null;
};

// "Concluir" abre a Nova atividade preenchida e vinculada ao compromisso, na data e hora em que ele foi marcado.
export const completeAgendaEventHref = (event: CompletableEvent) => {
  const params = new URLSearchParams({
    open: "create",
    date: event.startsAt,
    type: activityTypeForAgendaType(event.type),
    ownerSellerId: event.ownerId,
    notes: event.notes || event.title,
    title: event.title,
    agendaEventId: event.id
  });
  if (event.clientId) params.set("clientId", event.clientId);
  if (event.opportunityId) params.set("opportunityId", event.opportunityId);
  if (event.city) params.set("city", event.city);
  return `/atividades?${params.toString()}`;
};

// Data e hora (Brasília) da Nova atividade a partir do valor recebido: um dia (YYYY-MM-DD) usa o horário atual,
// um instante usa o próprio dia e horário. O que passaria de agora vira agora.
export const activityDateTimeDefaults = (prefill?: string | null, now = new Date()) => {
  const current = { day: brazilTodayKey(now), time: brazilTimeKey(now) };
  if (!prefill) return current;
  let candidate = current;
  if (/^\d{4}-\d{2}-\d{2}$/.test(prefill)) {
    candidate = { day: prefill, time: current.time };
  } else {
    const instant = new Date(prefill);
    if (Number.isNaN(instant.getTime())) return current;
    candidate = { day: brazilDayKeyOf(instant), time: brazilTimeKey(instant) };
  }
  return brazilDateTime(candidate.day, candidate.time).getTime() > now.getTime() ? current : candidate;
};

export type NextStepMode = "" | "schedule" | "none";

export type NextStepForm = {
  mode: NextStepMode;
  type: string;
  day: string;
  time: string;
  durationMinutes: string;
  reason: string;
};

export const NEXT_STEP_DEFAULT_DURATION = "30";

const hasReason = (reason: string) => reason.trim().length >= 2;

// Oportunidade aberta pede o próximo passo ou o motivo de não haver um (a API recusa sem isso).
export const needsNextStepDecision = (nextStep: NextStepForm, opportunityOpen: boolean) =>
  opportunityOpen && nextStep.mode !== "schedule" && !(nextStep.mode === "none" && hasReason(nextStep.reason));

export const NEXT_STEP_REQUIRED_MESSAGE = "Esta oportunidade está aberta: agende o próximo passo ou diga por que não há próximo passo.";

type ActivityFormCheck = {
  day: string;
  time: string;
  summary: string;
  opportunityOpen: boolean;
  nextStep: NextStepForm;
};

// Mensagem do primeiro problema do formulário da Nova atividade, ou null.
export const activityFormError = (form: ActivityFormCheck, now = new Date()) => {
  if (!form.day || !form.time) return "Informe a data e o horário do que foi feito.";
  if (brazilDateTime(form.day, form.time).getTime() > now.getTime()) {
    return "A data da atividade não pode ser futura. Para planejar, use o próximo passo ou a Agenda.";
  }
  if (!form.summary.trim()) return "Preencha o resumo do que foi feito.";
  if (form.nextStep.mode === "schedule") {
    const { type, day, time, durationMinutes } = form.nextStep;
    if (!type || !day || !time) return "Para o próximo passo, informe o tipo, o dia e o horário.";
    if (day < brazilTodayKey(now)) return "O próximo passo não pode ficar em dia passado.";
    if (!(Number(durationMinutes) > 0)) return "Informe a duração do próximo passo em minutos.";
  }
  if (needsNextStepDecision(form.nextStep, form.opportunityOpen)) return NEXT_STEP_REQUIRED_MESSAGE;
  return null;
};

// Próximo passo da API: o compromisso no dia e horário de Brasília escolhidos.
export const nextStepPayload = (nextStep: NextStepForm) => {
  const startsAt = brazilDateTime(nextStep.day, nextStep.time);
  return {
    type: nextStep.type,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + Number(nextStep.durationMinutes) * 60_000).toISOString()
  };
};

// Janela das Pendências (GET /agenda/pending): compromissos dos últimos 30 dias de Brasília.
export const PENDING_WINDOW_DAYS = 30;

export const NOT_DONE_REASON_MESSAGE = "Informe o motivo de o compromisso não ter sido realizado.";
export const notDoneReasonError = (reason: string) => (hasReason(reason) ? null : NOT_DONE_REASON_MESSAGE);

type RescheduleForm = { day: string; time: string; durationMinutes: string };

// "Reagendar": novo início e fim (Brasília). O roteiro move só o dia e mantém a quantidade de dias.
export const reschedulePayload = (
  form: RescheduleForm,
  event: { type: string; startsAt: string; endsAt: string },
  now = new Date()
): { error: string } | { startDateTime: string; endDateTime: string } => {
  if (!form.day) return { error: "Escolha o novo dia." };
  if (form.day < brazilTodayKey(now)) return { error: "Escolha hoje ou um dia futuro." };
  if (event.type === "roteiro_visita") {
    const start = brazilDateTime(form.day, "00:00");
    const length = new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime();
    return { startDateTime: start.toISOString(), endDateTime: new Date(start.getTime() + length).toISOString() };
  }
  if (!form.time) return { error: "Escolha o novo horário." };
  if (!(Number(form.durationMinutes) > 0)) return { error: "Informe a duração em minutos." };
  const start = brazilDateTime(form.day, form.time);
  return { startDateTime: start.toISOString(), endDateTime: new Date(start.getTime() + Number(form.durationMinutes) * 60_000).toISOString() };
};

// Duração atual do compromisso em minutos, para preencher o "Reagendar".
export const eventDurationMinutes = (event: { startsAt: string; endsAt: string }) =>
  Math.max(1, Math.round((new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()) / 60_000));
