import { formatDateBR } from "../lib/formatters";
import { mergeTimeline, type WhatsAppDayCardItem } from "../lib/whatsappMessages";
import WhatsAppDayCard from "./whatsapp/WhatsAppDayCard";

export type TimelineEventType = "comentario" | "mudanca_etapa" | "status";

export type TimelineEventItem = {
  id: string;
  type: TimelineEventType;
  description: string;
  createdAt: string;
  ownerSeller?: {
    id: string;
    name: string;
  } | null;
};

type TimelineEventListProps = {
  events: TimelineEventItem[];
  loading?: boolean;
  emptyMessage?: string;
  loadingMessage?: string;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  hasMore?: boolean;
  compact?: boolean;
  /**
   * WhatsApp Fase B2: cartões "WhatsApp · dd/mm" intercalados por data. `hasMore` aqui é dos cartões; o
   * `hasMore` da lista continua sendo dos eventos. Pela oportunidade, `opportunityId` limita as mensagens.
   */
  whatsapp?: { cards: WhatsAppDayCardItem[]; hasMore: boolean; opportunityId?: string };
};

type EventPresentation = {
  icon: string;
  title: string;
};

function getEventPresentation(event: TimelineEventItem): EventPresentation {
  if (event.type === "comentario") return { icon: "💬", title: "Interação" };
  if (event.type === "mudanca_etapa") return { icon: "🔀", title: "Mudança de etapa" };

  if (event.description.startsWith("Follow-up alterado")) return { icon: "📅", title: "Mudança de follow-up" };
  if (event.description.startsWith("Oportunidade criada")) return { icon: "✨", title: "Criação de oportunidade" };

  return { icon: "ℹ️", title: "Status" };
}

export default function TimelineEventList({
  events,
  loading,
  emptyMessage = "Sem eventos registrados.",
  loadingMessage = "Carregando timeline...",
  onLoadMore,
  loadingMore,
  hasMore,
  compact,
  whatsapp
}: TimelineEventListProps) {
  const entries = mergeTimeline({ events, eventsHasMore: Boolean(hasMore), cards: whatsapp?.cards ?? [], cardsHasMore: Boolean(whatsapp?.hasMore) });
  const anyMore = Boolean(hasMore) || Boolean(whatsapp?.hasMore);
  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {loading ? <p className="text-sm text-slate-500">{loadingMessage}</p> : null}

      {!loading && entries.length ? entries.map((entry) => {
        if (entry.kind === "whatsapp") {
          return <WhatsAppDayCard key={`wa-${entry.card.day}-${entry.card.conversationId}`} card={entry.card} opportunityId={whatsapp?.opportunityId} />;
        }
        const { event } = entry;
        const presentation = getEventPresentation(event);
        return (
          <article key={event.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-base" role="img" aria-label={presentation.title}>{presentation.icon}</span>
                <h5 className="font-semibold text-slate-800">{presentation.title}</h5>
              </div>
              <span className="text-xs text-slate-500">{formatDateBR(event.createdAt)}</span>
            </div>
            <p className="mt-1 text-slate-700">{event.description}</p>
            <p className="mt-1 text-xs text-slate-500">por {event.ownerSeller?.name || "Sistema"}</p>
          </article>
        );
      }) : null}

      {!loading && !entries.length ? <p className="text-sm text-slate-500">{emptyMessage}</p> : null}

      {!loading && anyMore && onLoadMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loadingMore ? "Carregando..." : "Carregar mais"}
        </button>
      ) : null}
    </div>
  );
}
