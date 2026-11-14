import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import api from "../../lib/apiClient";
import { formatBrazilDayMonth, formatWhatsAppTime, whatsappAudioLabel, whatsappOriginLabel, type WhatsAppMessageItem } from "../../lib/whatsappMessages";
import {
  CONVERSATION_POLL_MS,
  messageBodyLabel,
  mergeMessages,
  type ClientPhoneTarget,
  type ClientTargets,
  type InboxConversation,
  type InboxMessagesPage,
  type InboxStatus
} from "../../lib/whatsappInbox";
import { useVisiblePolling } from "../../hooks/useVisiblePolling";
import { AudioTranscription } from "./WhatsAppDayCard";

// WhatsApp Fase C (C2): conversa aberta na caixa de /whatsapp. Histórico (texto, transcrição de áudio, marcas
// de editada/apagada, mídia como rótulo, origem), atualizado a cada 5 s com a aba visível (só o que mudou).
// Abrir marca como lida só para o dono do número; gestão olhando outro número fica somente leitura.
// Conversa nova (cliente + telefone, vinda do botão "WhatsApp"): sem histórico, criada no primeiro envio.

export type NewConversationTarget = { clientId: string; phoneRef: string };

/** Uma mensagem do histórico. */
export function InboxMessageBubble({ message }: { message: WhatsAppMessageItem }) {
  const outbound = message.direction === "outbound";
  const body = message.transcription ? whatsappAudioLabel(message.text) : messageBodyLabel(message);
  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`} data-inbox-message={message.id} data-whatsapp-direction={message.direction}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${outbound ? "bg-emerald-50 text-slate-800" : "bg-white text-slate-800 ring-1 ring-slate-200"}`}>
        <p className={`whitespace-pre-wrap break-words ${message.deletedInWhatsApp ? "italic text-slate-500" : ""}`}>{body}</p>
        {message.transcription ? <AudioTranscription transcription={message.transcription} /> : null}
        <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-slate-500">
          <span>
            {formatBrazilDayMonth(message.at)} {formatWhatsAppTime(message.at)}
          </span>
          <span className={message.origin === "crm" ? "font-semibold text-emerald-700" : ""}>{whatsappOriginLabel(message)}</span>
          {message.edited ? <span>editada</span> : null}
          {message.editedTextUnavailable ? <span>(editada no WhatsApp – texto novo não disponível)</span> : null}
          {message.deletedInWhatsApp ? <span className="font-semibold text-amber-700">apagada no WhatsApp</span> : null}
        </p>
      </div>
    </div>
  );
}

type ViewProps = {
  title: string;
  subtitle?: string | null;
  readOnlyNote?: string | null;
  messages: WhatsAppMessageItem[];
  loading: boolean;
  error: string | null;
  hasOlder: boolean;
  loadingOlder?: boolean;
  emptyText?: string;
  onLoadOlder: () => void;
  onBack?: () => void;
  reply?: ReactNode;
};

/** Parte visual, sem rede: usada pela conversa e pelos testes. */
export function WhatsAppConversationView({ title, subtitle, readOnlyNote, messages, loading, error, hasOlder, loadingOlder, emptyText, onLoadOlder, onBack, reply }: ViewProps) {
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={`Conversa com ${title}`} data-inbox-conversation>
      <header className="flex min-w-0 items-start gap-2 border-b border-slate-200 pb-2">
        {onBack ? (
          <button type="button" onClick={onBack} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 md:hidden" aria-label="Voltar para a lista">
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
        ) : null}
        <div className="min-w-0">
          <h3 className="break-words font-semibold text-slate-900">{title}</h3>
          {subtitle ? <p className="break-words text-xs text-slate-500">{subtitle}</p> : null}
        </div>
      </header>
      {readOnlyNote ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600" data-inbox-read-only>{readOnlyNote}</p> : null}
      <div className="max-h-[60vh] min-h-40 space-y-2 overflow-y-auto rounded-lg bg-slate-50 p-2">
        {hasOlder ? (
          <div className="text-center">
            <button type="button" onClick={onLoadOlder} disabled={loadingOlder} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-60">
              {loadingOlder ? "Carregando..." : "Mensagens anteriores"}
            </button>
          </div>
        ) : null}
        {messages.map((message) => (
          <InboxMessageBubble key={message.id} message={message} />
        ))}
        {loading ? <p className="p-2 text-xs text-slate-500">Carregando mensagens...</p> : null}
        {error ? <p className="p-2 text-xs text-amber-700" role="alert">{error}</p> : null}
        {!loading && !error && !messages.length ? <p className="p-2 text-xs text-slate-500">{emptyText ?? "Nenhuma mensagem nesta conversa."}</p> : null}
      </div>
      {reply}
    </section>
  );
}

const describeConversation = (conversation: InboxConversation | null) => ({
  title: conversation?.client?.name ?? "Conversa",
  subtitle: [conversation?.contactDisplay, conversation && !conversation.own && conversation.numberOwner ? `número de ${conversation.numberOwner.name}` : null].filter(Boolean).join(" · ") || null
});

export type ReplyRenderInput = {
  /** Destino do envio: a conversa aberta ou o cliente + telefone da conversa nova. */
  target: { conversationId: string } | { clientId: string; phoneRef: string };
  clientId: string | null;
  own: boolean;
  canReply: boolean;
  onSent: (conversationId: string, message: WhatsAppMessageItem) => void;
};

type Props = {
  conversationId: string | null;
  newTarget: NewConversationTarget | null;
  status: InboxStatus | null;
  onBack?: () => void;
  /** Lida marcada ou mensagem enviada: a lista atualiza as não lidas e a ordem. */
  onChanged: () => void;
  /** Conversa nova recebeu o primeiro envio: passa a ser a conversa aberta. */
  onCreated: (conversationId: string) => void;
  renderReply?: (input: ReplyRenderInput) => ReactNode;
};

export default function WhatsAppConversation({ conversationId, newTarget, status, onBack, onChanged, onCreated, renderReply }: Props) {
  const [conversation, setConversation] = useState<InboxConversation | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessageItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<ClientTargets | null>(null);
  const since = useRef<string | null>(null);
  const polling = useRef(false);

  const markRead = useCallback(
    async (id: string) => {
      try {
        await api.post("/whatsapp/inbox/read", { conversationId: id });
        onChanged();
      } catch {
        // Não lida continua; a próxima abertura tenta de novo.
      }
    },
    [onChanged]
  );

  // Conversa existente: últimas mensagens; dono do número com não lidas marca como lida.
  useEffect(() => {
    if (!conversationId) return undefined;
    let active = true;
    setConversation(null);
    setMessages([]);
    setNextBefore(null);
    setError(null);
    setLoading(true);
    since.current = null;
    api
      .get<InboxMessagesPage>("/whatsapp/inbox/messages", { params: { conversationId } })
      .then((response) => {
        if (!active) return;
        setConversation(response.data.conversation);
        setMessages(response.data.items ?? []);
        setNextBefore(response.data.nextBefore ?? null);
        since.current = response.data.serverTime;
        if (response.data.conversation.own && response.data.conversation.unreadCount > 0) void markRead(conversationId);
      })
      .catch(() => active && setError("Não foi possível carregar a conversa."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [conversationId, markRead]);

  // Conversa nova: o telefone escolhido no cliente (pela referência). Se a conversa já existe, abre ela.
  useEffect(() => {
    if (conversationId || !newTarget) return undefined;
    let active = true;
    setTargets(null);
    setMessages([]);
    setError(null);
    setLoading(true);
    api
      .get<ClientTargets>("/whatsapp/inbox/client-targets", { params: { clientId: newTarget.clientId } })
      .then((response) => {
        if (!active) return;
        setTargets(response.data);
        const phone = response.data.phones.find((item) => item.ref === newTarget.phoneRef);
        if (phone?.conversationId) onCreated(phone.conversationId);
      })
      .catch(() => active && setError("Não foi possível abrir a conversa com este cliente."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [conversationId, newTarget, onCreated]);

  // Polling: só o que mudou desde a última leitura (novas, editadas, apagadas, transcrição pronta).
  const poll = useCallback(async () => {
    if (!conversationId || !since.current || polling.current) return;
    polling.current = true;
    try {
      const response = await api.get<InboxMessagesPage>("/whatsapp/inbox/messages", { params: { conversationId, changedSince: since.current } });
      since.current = response.data.serverTime;
      setConversation(response.data.conversation);
      const incoming = response.data.items ?? [];
      setMessages((current) => mergeMessages(current, incoming));
      if (response.data.conversation.own && response.data.conversation.unreadCount > 0) void markRead(conversationId);
    } catch {
      // Tenta de novo no próximo ciclo.
    } finally {
      polling.current = false;
    }
  }, [conversationId, markRead]);

  useVisiblePolling(() => void poll(), CONVERSATION_POLL_MS, Boolean(conversationId));

  const loadOlder = async () => {
    if (!conversationId || !nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const response = await api.get<InboxMessagesPage>("/whatsapp/inbox/messages", { params: { conversationId, before: nextBefore } });
      setMessages((current) => mergeMessages(current, response.data.items ?? []));
      setNextBefore(response.data.nextBefore ?? null);
    } catch {
      setError("Não foi possível carregar as mensagens anteriores.");
    } finally {
      setLoadingOlder(false);
    }
  };

  const onSent = useCallback(
    (sentConversationId: string, message: WhatsAppMessageItem) => {
      if (!conversationId) {
        onCreated(sentConversationId);
      } else {
        setMessages((current) => mergeMessages(current, [message]));
      }
      onChanged();
    },
    [conversationId, onChanged, onCreated]
  );

  if (!conversationId && newTarget) {
    const phone: ClientPhoneTarget | null = targets?.phones.find((item) => item.ref === newTarget.phoneRef) ?? null;
    const missing = targets && !phone ? "Telefone não encontrado no cadastro deste cliente." : null;
    return (
      <WhatsAppConversationView
        title={targets?.client.name ?? "Nova conversa"}
        subtitle={phone?.display ?? null}
        messages={[]}
        loading={loading}
        error={error ?? missing}
        hasOlder={false}
        emptyText="Nenhuma mensagem ainda. A conversa é criada no primeiro envio."
        onLoadOlder={() => undefined}
        onBack={onBack}
        reply={
          targets && phone && renderReply
            ? renderReply({ target: { clientId: newTarget.clientId, phoneRef: phone.ref }, clientId: newTarget.clientId, own: true, canReply: true, onSent })
            : null
        }
      />
    );
  }

  const { title, subtitle } = describeConversation(conversation);
  return (
    <WhatsAppConversationView
      title={title}
      subtitle={subtitle}
      readOnlyNote={conversation && !conversation.own ? "Somente leitura: conversa do número de outro usuário. Abrir não marca como lida." : null}
      messages={messages}
      loading={loading}
      error={error}
      hasOlder={Boolean(nextBefore)}
      loadingOlder={loadingOlder}
      onLoadOlder={() => void loadOlder()}
      onBack={onBack}
      reply={
        conversation && conversation.own && renderReply && status
          ? renderReply({ target: { conversationId: conversation.id }, clientId: conversation.client?.id ?? null, own: conversation.own, canReply: conversation.canReply, onSent })
          : null
      }
    />
  );
}

