export type AgendaEventType = "reuniao_online" | "reuniao_presencial" | "roteiro_visita" | "followup";

export type AgendaEventStatus = "agendado" | "realizado" | "vencido" | "cancelado";

export type AgendaEvent = {
  id: string;
  userId: string;
  clientId?: string;
  opportunityId?: string;
  title: string;
  description: string;
  observation?: string;
  type: AgendaEventType;
  startDateTime: string;
  endDateTime: string;
  location?: string;
  city?: string;
  mapsIntegration?: {
    placeId?: string;
    waypointOrder?: number;
    routeLegId?: string;
  };
  status: AgendaEventStatus;
  isOverdue?: boolean;
  sellerId?: string;
  notes?: string | null;
  stops?: AgendaStop[];
};


export type AgendaStop = {
  id: string;
  order: number;
  clientId?: string | null;
  clientName?: string | null;
  city?: string | null;
  address?: string | null;
  plannedTime?: string | null;
  notes?: string | null;
  checkInAt?: string | null;
  checkInLat?: number | null;
  checkInLng?: number | null;
  checkInAccuracy?: number | null;
  checkOutAt?: string | null;
  checkOutLat?: number | null;
  checkOutLng?: number | null;
  checkOutAccuracy?: number | null;
  resultStatus?: "realizada" | "nao_realizada" | null;
  resultReason?: "cliente_ausente" | "chuva" | "estrada" | "reagendar" | "outro" | null;
  resultSummary?: string | null;
  nextStep?: "criar_followup" | "criar_oportunidade" | "reagendar" | null;
  nextStepDate?: string | null;
};
