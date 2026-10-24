import { NEXT_STEP_DEFAULT_DURATION, nextStepError, nextStepPayload, type NextStepForm } from "./agendaActivity";
import type { RouteStopAction } from "./routeStopQueue";

// Tela "Executar roteiro": regras sem React, usadas pela página e pelos testes; a API valida de novo.

export type StopExecutionStatus = "pendente" | "em_visita" | "realizada" | "nao_realizada";

export const STOP_EXECUTION_STATUS_LABELS: Record<StopExecutionStatus, string> = {
  pendente: "Pendente",
  em_visita: "Em visita",
  realizada: "Realizada",
  nao_realizada: "Não realizada"
};

type StopLike = {
  checkInAt?: string | null;
  checkOutAt?: string | null;
  resultStatus?: "realizada" | "nao_realizada" | null;
  address?: string | null;
  city?: string | null;
};

// Status da parada; o check-in guardado no aparelho (sem internet) já conta como em visita.
export const stopExecutionStatus = (stop: StopLike, queued: RouteStopAction[] = []): StopExecutionStatus => {
  if (stop.resultStatus === "realizada") return "realizada";
  if (stop.resultStatus === "nao_realizada") return "nao_realizada";
  if (stop.checkInAt || queued.includes("check-in")) return "em_visita";
  return "pendente";
};

export const isRouteFinished = (stops: StopLike[]) => stops.length > 0 && stops.every((stop) => Boolean(stop.resultStatus));

export const STOP_NOT_DONE_REASONS = [
  { value: "cliente_ausente", label: "Cliente ausente" },
  { value: "chuva", label: "Chuva" },
  { value: "estrada", label: "Estrada ruim" },
  { value: "reagendar", label: "Precisa reagendar" },
  { value: "outro", label: "Outro" }
] as const;

export const STOP_SUMMARY_MAX_LENGTH = 240;

// Destino da parada para o mapa: endereço e cidade. Sem eles não há link (o nome do cliente não vai para o mapa).
export const stopMapDestination = (stop: StopLike) => {
  const parts = [stop.address, stop.city].map((part) => part?.trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
};

// Rota no OpenStreetMap até o destino; a origem fica para o vendedor (ou a localização do aparelho).
export const openStreetMapRouteHref = (destination: string) =>
  `https://www.openstreetmap.org/directions?to=${encodeURIComponent(destination)}`;

// App de mapas do celular: Apple Maps no iPhone/iPad, o app padrão (geo:) no Android.
export const mapsAppHref = (destination: string, userAgent = "") =>
  /iPad|iPhone|iPod/i.test(userAgent)
    ? `https://maps.apple.com/?daddr=${encodeURIComponent(destination)}`
    : `geo:0,0?q=${encodeURIComponent(destination)}`;

export type StopResultForm = {
  status: "realizada" | "nao_realizada";
  reason: string;
  summary: string;
  opportunityId: string;
  nextStep: NextStepForm;
};

type OpportunityOption = { id: string; stage: string };

const isOpenStage = (stage: string) => stage !== "ganho" && stage !== "perdido";

// Formulário do check-out: com uma oportunidade aberta do cliente, ela já vem escolhida.
export const initialStopResultForm = (status: StopResultForm["status"], openOpportunities: OpportunityOption[] = []): StopResultForm => ({
  status,
  reason: "",
  summary: "",
  opportunityId: openOpportunities.length === 1 ? openOpportunities[0].id : "",
  nextStep: { mode: "", type: "", day: "", time: "", durationMinutes: NEXT_STEP_DEFAULT_DURATION, reason: "" }
});

export const STOP_SUMMARY_REQUIRED_MESSAGE = "Preencha o resumo da visita.";
export const STOP_REASON_REQUIRED_MESSAGE = "Informe o motivo de a visita não ter sido realizada.";
export const STOP_OPPORTUNITY_REQUIRED_MESSAGE = "Escolha a oportunidade desta visita.";

// Primeiro problema do formulário do check-out, ou null. Realizada: resumo obrigatório e, com oportunidade aberta,
// a mesma regra das atividades. Não realizada: só o motivo.
export const stopResultError = (form: StopResultForm, openOpportunities: OpportunityOption[], now = new Date()) => {
  if (form.status === "nao_realizada") return form.reason ? null : STOP_REASON_REQUIRED_MESSAGE;
  if (!form.summary.trim()) return STOP_SUMMARY_REQUIRED_MESSAGE;
  if (openOpportunities.length > 1 && !form.opportunityId) return STOP_OPPORTUNITY_REQUIRED_MESSAGE;
  const chosen = openOpportunities.find((opportunity) => opportunity.id === form.opportunityId);
  return nextStepError(form.nextStep, Boolean(chosen && isOpenStage(chosen.stage)), now);
};

// Corpo de PATCH /agenda-events/:stopId/result.
export const stopResultPayload = (form: StopResultForm) => {
  if (form.status === "nao_realizada") {
    return { status: form.status, reason: form.reason, ...(form.summary.trim() ? { summary: form.summary.trim() } : {}) };
  }
  return {
    status: form.status,
    summary: form.summary.trim(),
    ...(form.opportunityId ? { opportunityId: form.opportunityId } : {}),
    ...(form.nextStep.mode === "schedule" ? { nextStepEvent: nextStepPayload(form.nextStep) } : {}),
    ...(form.nextStep.mode === "none" && form.nextStep.reason.trim().length >= 2 ? { noNextStepReason: form.nextStep.reason.trim() } : {})
  };
};
