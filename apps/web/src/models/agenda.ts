export type AgendaEventType = "reuniao_online" | "reuniao_presencial" | "roteiro_visita" | "follow_up";

export type AgendaEventStatus = "agendado" | "realizado" | "cancelado";

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
};
