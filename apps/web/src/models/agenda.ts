export type AgendaEventType = "reuniao_online" | "reuniao_presencial" | "roteiro_visita" | "followup";

export type AgendaEventStatus = "planned" | "completed" | "cancelled";

export type AgendaEvent = {
  id: string;
  ownerId: string;
  clientId?: string;
  opportunityId?: string;
  type: AgendaEventType;
  title: string;
  notes?: string | null;
  startsAt: string;
  endsAt: string;
  city?: string;
  status: AgendaEventStatus;
  linkedActivityId?: string | null;
  hasLinkedActivity?: boolean;

  // Backward compatibility fields
  userId?: string;
  sellerId?: string;
  description?: string;
  startDateTime?: string;
  endDateTime?: string;
  isOverdue?: boolean;
  mapsIntegration?: {
    placeId?: string;
    waypointOrder?: number;
    routeLegId?: string;
  };
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
