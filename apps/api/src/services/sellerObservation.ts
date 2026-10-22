import { EventType, Prisma } from "@prisma/client";

// Observação do vendedor na timeline: comentário (type comentario) ligado a uma oportunidade. É o único formato que
// o usuário grava (POST /events e notas da oportunidade). Sincronização UltraFV3, saneamentos, agenda, pedidos ERP e
// mudanças de etapa gravam status ou mudanca_etapa; a mensagem recebida pelo WhatsApp oficial grava comentario sem
// oportunidade. Esses registros de sistema continuam na timeline, mas não viram "observação recente" nem contexto da IA.
export const SELLER_OBSERVATION_TIMELINE_WHERE = {
  type: EventType.comentario,
  opportunityId: { not: null }
} satisfies Prisma.TimelineEventWhereInput;

export const isSellerObservationEvent = (event: { type: string; opportunityId: string | null }) =>
  event.type === EventType.comentario && event.opportunityId !== null;
