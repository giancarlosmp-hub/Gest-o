export type AgendaEventType = "reuniao_online" | "reuniao_presencial" | "roteiro_visita" | "followup" | "follow_up";

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
  arrivedAt?: string | null;
  completedAt?: string | null;
};
