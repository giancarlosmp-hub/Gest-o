import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, MessageCircle } from "lucide-react";
import api from "../../lib/apiClient";
import {
  TRANSCRIPT_PREVIEW_CHARS,
  formatWhatsAppDay,
  formatWhatsAppTime,
  whatsappAudioLabel,
  whatsappOriginLabel,
  whatsappTranscriptionNote,
  type WhatsAppDayCardItem,
  type WhatsAppDayCardsPage,
  type WhatsAppMessageItem,
  type WhatsAppTranscription
} from "../../lib/whatsappMessages";

// WhatsApp Fase B2: cartão "WhatsApp · dd/mm" na linha do tempo do cliente e da oportunidade. Abre as
// mensagens daquele dia (pela oportunidade, só as de depois da criação dela). Só leitura.
// Áudio com transcrição: "🎤 0:42" com o selo "transcrição automática" e o texto (longo começa cortado), ou o
// aviso de pendente, pulado ou falhou.

type ViewProps = {
  card: WhatsAppDayCardItem;
  open: boolean;
  messages: WhatsAppMessageItem[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  onToggle: () => void;
  onLoadMore: () => void;
};

const counts = (card: WhatsAppDayCardItem) => {
  const parts = [card.total === 1 ? "1 mensagem" : `${card.total} mensagens`];
  if (card.inbound) parts.push(card.inbound === 1 ? "1 recebida" : `${card.inbound} recebidas`);
  if (card.outbound) parts.push(card.outbound === 1 ? "1 enviada" : `${card.outbound} enviadas`);
  return parts.join(" · ");
};

function AudioTranscription({ transcription }: { transcription: WhatsAppTranscription }) {
  const [expanded, setExpanded] = useState(false);
  const note = whatsappTranscriptionNote(transcription);
  if (note) return <p className="mt-1 text-xs italic text-slate-500">{note}</p>;
  const text = transcription.text ?? "";
  const long = text.length > TRANSCRIPT_PREVIEW_CHARS;
  const shown = long && !expanded ? `${text.slice(0, TRANSCRIPT_PREVIEW_CHARS).trimEnd()}…` : text;
  return (
    <div className="mt-1">
      <span className="inline-block rounded bg-white px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 ring-1 ring-slate-200">
        transcrição automática
      </span>
      {text ? (
        <p className="mt-1 whitespace-pre-wrap break-words" data-whatsapp-transcription>
          {shown}
        </p>
      ) : (
        <p className="mt-1 text-xs italic text-slate-500">sem fala reconhecida</p>
      )}
      {long ? (
        <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-1 text-xs font-medium text-emerald-700">
          {expanded ? "ver menos" : "ver mais"}
        </button>
      ) : null}
    </div>
  );
}

/** Parte visual, sem rede: usada pelo cartão e pelos testes. */
export function WhatsAppDayCardView({ card, open, messages, loading, error, hasMore, onToggle, onLoadMore }: ViewProps) {
  const listId = `whatsapp-${card.conversationId}-${card.day}`;
  return (
    <article className="rounded-lg border border-emerald-200 bg-white p-3 text-sm" data-whatsapp-card={card.day}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={listId} className="flex w-full items-start justify-between gap-3 text-left">
        <span className="flex min-w-0 items-center gap-2">
          <MessageCircle size={16} className="shrink-0 text-emerald-600" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block font-semibold text-slate-800">WhatsApp · {formatWhatsAppDay(card.day)}</span>
            <span className="block text-xs text-slate-500">
              {counts(card)}
              {card.contactDisplay ? <> · {card.contactDisplay}</> : null}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-slate-500">
          {formatWhatsAppTime(card.lastAt)}
          {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        </span>
      </button>
      {card.numberOwner ? <p className="mt-1 text-xs text-slate-500">número de {card.numberOwner.name}</p> : null}

      {open ? (
        <div id={listId} className="mt-3 space-y-2">
          {messages.map((message) => {
            const outbound = message.direction === "outbound";
            return (
              <div key={message.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`} data-whatsapp-direction={message.direction}>
                <div className={`max-w-[85%] rounded-lg px-3 py-2 ${outbound ? "bg-emerald-50 text-slate-800" : "bg-slate-100 text-slate-800"}`}>
                  <p className={`whitespace-pre-wrap break-words ${!outbound && message.deletedInWhatsApp ? "italic text-slate-500" : ""}`}>
                    {message.transcription ? whatsappAudioLabel(message.text) : message.text}
                  </p>
                  {message.transcription ? <AudioTranscription transcription={message.transcription} /> : null}
                  <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-slate-500">
                    <span>{formatWhatsAppTime(message.at)}</span>
                    <span>{whatsappOriginLabel(message)}</span>
                    {message.edited ? <span>editada</span> : null}
                    {message.editedTextUnavailable ? <span>(editada no WhatsApp – texto novo não disponível)</span> : null}
                    {outbound && message.deletedInWhatsApp ? <span className="font-semibold text-amber-700">apagada no WhatsApp</span> : null}
                  </p>
                </div>
              </div>
            );
          })}
          {loading ? <p className="text-xs text-slate-500">Carregando mensagens...</p> : null}
          {error ? <p className="text-xs text-amber-700">Não foi possível carregar as mensagens.</p> : null}
          {!loading && !error && !messages.length ? <p className="text-xs text-slate-500">Nenhuma mensagem neste dia.</p> : null}
          {!loading && hasMore ? (
            <button type="button" onClick={onLoadMore} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700">
              Carregar mais mensagens
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export default function WhatsAppDayCard({ card, opportunityId }: { card: WhatsAppDayCardItem; opportunityId?: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<WhatsAppMessageItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = async (after: string | null) => {
    setLoading(true);
    setError(false);
    try {
      const response = await api.get<{ items: WhatsAppMessageItem[]; nextCursor: string | null }>(`/whatsapp/conversations/${card.conversationId}/messages`, {
        params: { day: card.day, ...(opportunityId ? { opportunityId } : {}), ...(after ? { cursor: after } : {}) }
      });
      setMessages((current) => (after ? [...current, ...response.data.items] : response.data.items));
      setCursor(response.data.nextCursor);
      setLoaded(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) void load(null);
  };

  return (
    <WhatsAppDayCardView
      card={card}
      open={open}
      messages={messages}
      loading={loading}
      error={error}
      hasMore={Boolean(cursor)}
      onToggle={toggle}
      onLoadMore={() => void load(cursor)}
    />
  );
}

/**
 * Cartões de um cliente (`/whatsapp/clients/:id/days`) ou de uma oportunidade
 * (`/whatsapp/opportunities/:id/days`). Falha ou sem acesso: lista vazia, sem aviso (o resto da linha do
 * tempo continua).
 */
export function useWhatsAppDayCards(path: string | null) {
  const [page, setPage] = useState<WhatsAppDayCardsPage>({ items: [], nextBefore: null });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    setPage({ items: [], nextBefore: null });
    if (!path) return undefined;
    api
      .get<WhatsAppDayCardsPage>(path, { params: { take: 20 } })
      .then((response) => {
        if (active) setPage({ ...response.data, items: response.data.items ?? [], nextBefore: response.data.nextBefore ?? null });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [path]);

  const loadMore = useCallback(async () => {
    if (!path || !page.nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await api.get<WhatsAppDayCardsPage>(path, { params: { take: 20, before: page.nextBefore } });
      setPage((current) => ({ ...current, items: [...current.items, ...(response.data.items ?? [])], nextBefore: response.data.nextBefore ?? null }));
    } catch {
      // Mantém o que já carregou.
    } finally {
      setLoadingMore(false);
    }
  }, [path, page.nextBefore, loadingMore]);

  return {
    cards: page.items,
    hasMore: Boolean(page.nextBefore),
    loadingMore,
    loadMore,
    clientId: page.clientId ?? null,
    canOpenClient: page.canOpenClient === true
  };
}
