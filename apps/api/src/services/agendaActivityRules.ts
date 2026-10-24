import type { ActivityType, AgendaEventType } from "@prisma/client";
import { brazilDayKeyOf, brazilDayRange, shiftDayKey } from "../utils/dateRange.js";

// Agenda planeja (compromissos), Atividades registram o que foi feito. Regras sem acesso a banco, usadas pelas rotas.

// Dia de Brasília de uma data recebida: YYYY-MM-DD é o próprio dia; um instante completo vira o dia de Brasília.
export const brazilDayKeyOfInput = (value: string | Date): string | null => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isNaN(instant.getTime()) ? null : brazilDayKeyOf(instant);
};

export const isFutureBrazilDay = (value: string | Date, now = new Date()) => {
  const dayKey = brazilDayKeyOfInput(value);
  return dayKey !== null && dayKey > brazilDayKeyOf(now);
};

export const isPastBrazilDay = (value: string | Date, now = new Date()) => {
  const dayKey = brazilDayKeyOfInput(value);
  return dayKey !== null && dayKey < brazilDayKeyOf(now);
};

export const isOpenOpportunityStage = (stage: string) => stage !== "ganho" && stage !== "perdido";

// Tipo da atividade criada ao concluir um compromisso. Proposta vira proposta_enviada (ActivityType não tem "proposta").
export const ACTIVITY_TYPE_FOR_AGENDA_TYPE: Record<AgendaEventType, ActivityType> = {
  ligacao: "ligacao",
  whatsapp: "whatsapp",
  visita: "visita",
  reuniao_online: "reuniao_online",
  reuniao_presencial: "reuniao_presencial",
  proposta: "proposta_enviada",
  fechamento: "fechamento",
  roteiro_visita: "visita",
  followup: "followup"
};

// Pendências: compromissos passados ainda agendados desde o início do dia de Brasília de 30 dias atrás.
export const PENDING_AGENDA_WINDOW_DAYS = 30;

export const pendingAgendaWindowStart = (now = new Date()) =>
  brazilDayRange(shiftDayKey(brazilDayKeyOf(now), -PENDING_AGENDA_WINDOW_DAYS))!.gte!;

export const NEXT_STEP_DEFAULT_DURATION_MINUTES = 30;

type NextStepInput = { startsAt: string; endsAt?: string };

// Mensagem de erro do próximo passo, ou null quando está válido.
export const validateNextStep = (nextStep: NextStepInput, now = new Date()) => {
  const start = new Date(nextStep.startsAt);
  if (Number.isNaN(start.getTime())) return "Data do próximo passo inválida.";
  if (nextStep.endsAt !== undefined) {
    const end = new Date(nextStep.endsAt);
    if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) return "O fim do próximo passo deve ser depois do início.";
  }
  if (isPastBrazilDay(start, now)) return "O próximo passo não pode ficar em dia passado.";
  return null;
};

type ExecutedActivityInput = {
  done?: boolean;
  date?: string;
  dueDate?: string;
  description?: string;
  nextStep?: NextStepInput;
  noNextStepReason?: string;
};

// Valida a atividade realizada (criação direta ou "Concluir" do compromisso). Mensagem de erro ou null.
export const validateExecutedActivity = (
  input: ExecutedActivityInput,
  opportunity: { stage: string } | null,
  now = new Date()
) => {
  if (input.done === false) {
    return "Atividade registra o que já foi feito. Para planejar, crie um compromisso na Agenda.";
  }
  for (const value of [input.date, input.dueDate]) {
    if (value === undefined) continue;
    if (brazilDayKeyOfInput(value) === null) return "Data da atividade inválida.";
    if (isFutureBrazilDay(value, now)) return "A data da atividade não pode ser futura.";
  }
  if (!String(input.description || "").trim()) {
    return "Informe o resultado (resumo) do que foi feito.";
  }
  if (input.nextStep) {
    const nextStepError = validateNextStep(input.nextStep, now);
    if (nextStepError) return nextStepError;
  }
  if (opportunity && isOpenOpportunityStage(opportunity.stage) && !input.nextStep && !input.noNextStepReason?.trim()) {
    return "Oportunidade aberta: informe o próximo passo ou o motivo de não ter próximo passo.";
  }
  return null;
};
