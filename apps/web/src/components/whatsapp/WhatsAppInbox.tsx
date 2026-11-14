import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MessageCircle } from "lucide-react";
import api from "../../lib/apiClient";
import { formatBrazilDayMonth, formatWhatsAppTime } from "../../lib/whatsappMessages";
import { INBOX_POLL_MS, lastMessagePreview, type InboxListItem, type InboxPage, type InboxScope, type InboxStatus } from "../../lib/whatsappInbox";
import { useVisiblePolling } from "../../hooks/useVisiblePolling";
import WhatsAppConversation, { type NewConversationTarget, type ReplyRenderInput } from "./WhatsAppConversation";

// WhatsApp Fase C (C2): caixa de conversas em /whatsapp. "Meu número": as conversas vinculadas do próprio
// número, da mais recente para a mais antiga, com não lidas e trecho. "Equipe" (gerente e diretor): as dos
// outros números do tenant, somente leitura. Atualiza a cada 20 s com a aba visível.

const PAGE = 20;

type ListViewProps = {
  scope: InboxScope;
  showTeam: boolean;
  items: InboxListItem[];
  selectedId: string | null;
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  unreadTotal: number;
  onScope: (scope: InboxScope) => void;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
};

const when = (iso: string | null) => (iso ? `${formatBrazilDayMonth(iso) ?? ""} ${formatWhatsAppTime(iso)}`.trim() : "");

/** Lista da caixa, sem rede: usada pela caixa e pelos testes. */
export function WhatsAppInboxListView({ scope, showTeam, items, selectedId, loading, error, hasMore, unreadTotal, onScope, onSelect, onLoadMore }: ListViewProps) {
  const tab = (value: InboxScope, label: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={scope === value}
      onClick={() => onScope(value)}
      className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${scope === value ? "bg-brand-700 text-white" : "text-slate-600 hover:bg-slate-100"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex min-w-0 flex-col gap-2" data-inbox-scope={scope}>
      <div role="tablist" aria-label="Conversas" className="flex gap-1 rounded-xl bg-slate-50 p-1">
        {tab(
          "mine",
          <>
            Meu número
            {unreadTotal > 0 ? <span className="ml-1 rounded-full bg-emerald-600 px-1.5 py-0.5 text-xs text-white">{unreadTotal}</span> : null}
          </>
        )}
        {showTeam ? tab("team", "Equipe") : null}
      </div>
      {scope === "team" ? <p className="text-xs text-slate-500">Somente leitura: conversas dos números da equipe.</p> : null}
      <ul className="max-h-[60vh] min-w-0 overflow-y-auto">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={selectedId === item.id ? "true" : undefined}
              className={`flex w-full min-w-0 items-start gap-2 border-b border-slate-100 px-2 py-3 text-left ${selectedId === item.id ? "bg-brand-50" : "hover:bg-slate-50"}`}
              data-inbox-item={item.id}
            >
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className={`truncate text-sm ${item.unreadCount > 0 ? "font-bold text-slate-900" : "font-semibold text-slate-800"}`}>{item.client?.name ?? "Cliente"}</span>
                  <span className="shrink-0 text-[11px] text-slate-500">{when(item.lastMessageAt)}</span>
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {[item.contactDisplay, scope === "team" && item.numberOwner ? `número de ${item.numberOwner.name}` : null].filter(Boolean).join(" · ")}
                </span>
                <span className="block truncate text-xs text-slate-600">{lastMessagePreview(item)}</span>
              </span>
              {item.unreadCount > 0 ? (
                <span className="shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white" aria-label={`${item.unreadCount} não lidas`}>
                  {item.unreadCount}
                </span>
              ) : null}
            </button>
          </li>
        ))}
        {loading && !items.length ? <li className="p-3 text-sm text-slate-500">Carregando conversas...</li> : null}
        {error ? <li className="p-3 text-sm text-amber-700">Não foi possível carregar as conversas.</li> : null}
        {!loading && !error && !items.length ? (
          <li className="p-3 text-sm text-slate-500">{scope === "mine" ? "Nenhuma conversa vinculada no seu número." : "Nenhuma conversa da equipe."}</li>
        ) : null}
      </ul>
      {hasMore ? (
        <button type="button" onClick={onLoadMore} disabled={loading} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-60">
          Carregar mais conversas
        </button>
      ) : null}
    </div>
  );
}

type Props = {
  manager: boolean;
  initialConversationId: string | null;
  initialNewTarget: NewConversationTarget | null;
  renderReply?: (input: ReplyRenderInput & { status: InboxStatus | null }) => ReactNode;
};

export default function WhatsAppInbox({ manager, initialConversationId, initialNewTarget, renderReply }: Props) {
  const [scope, setScope] = useState<InboxScope>("mine");
  const [items, setItems] = useState<InboxListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState<InboxStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialConversationId);
  const [newTarget, setNewTarget] = useState<NewConversationTarget | null>(initialConversationId ? null : initialNewTarget);
  const loadedCount = useRef(0);

  useEffect(() => {
    setSelectedId(initialConversationId);
    setNewTarget(initialConversationId ? null : initialNewTarget);
  }, [initialConversationId, initialNewTarget]);

  const loadStatus = useCallback(async () => {
    try {
      const response = await api.get<InboxStatus>("/whatsapp/inbox/status");
      setStatus(response.data);
    } catch {
      // Sem a situação, o campo de resposta não aparece.
    }
  }, []);

  // Primeira página (ou as já carregadas, até 50) de novo: ordem e não lidas atualizadas.
  const refresh = useCallback(
    async (currentScope: InboxScope, reset = false) => {
      if (reset) {
        setItems([]);
        setNextCursor(null);
        loadedCount.current = 0;
      }
      setLoading(true);
      try {
        const take = Math.min(Math.max(loadedCount.current, PAGE), 50);
        const response = await api.get<InboxPage>("/whatsapp/inbox", { params: { scope: currentScope, take } });
        setItems(response.data.items ?? []);
        setNextCursor(response.data.nextCursor ?? null);
        loadedCount.current = (response.data.items ?? []).length;
        setError(false);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void refresh(scope, true);
  }, [scope, refresh]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useVisiblePolling(() => {
    void refresh(scope);
    void loadStatus();
  }, INBOX_POLL_MS);

  const loadMore = async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const response = await api.get<InboxPage>("/whatsapp/inbox", { params: { scope, cursor: nextCursor, take: PAGE } });
      setItems((current) => {
        const ids = new Set(current.map((item) => item.id));
        const next = [...current, ...(response.data.items ?? []).filter((item) => !ids.has(item.id))];
        loadedCount.current = next.length;
        return next;
      });
      setNextCursor(response.data.nextCursor ?? null);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const onChanged = useCallback(() => {
    void refresh(scope);
    void loadStatus();
  }, [refresh, scope, loadStatus]);

  const onCreated = useCallback((conversationId: string) => {
    setNewTarget(null);
    setSelectedId(conversationId);
  }, []);

  const select = (id: string) => {
    setNewTarget(null);
    setSelectedId(id);
  };

  const close = () => {
    setSelectedId(null);
    setNewTarget(null);
  };

  const open = Boolean(selectedId || newTarget);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-labelledby="whatsapp-inbox-title" data-whatsapp-inbox>
      <h2 id="whatsapp-inbox-title" className="mb-3 flex items-center gap-2 text-lg font-bold text-slate-900">
        <MessageCircle size={18} className="text-emerald-600" aria-hidden="true" /> Conversas
      </h2>
      <div className="grid min-w-0 gap-4 md:grid-cols-[320px_minmax(0,1fr)]">
        <div className={open ? "hidden md:block" : ""}>
          <WhatsAppInboxListView
            scope={scope}
            showTeam={manager}
            items={items}
            selectedId={selectedId}
            loading={loading}
            error={error}
            hasMore={Boolean(nextCursor)}
            unreadTotal={status?.unreadTotal ?? 0}
            onScope={(value) => {
              setScope(value);
              close();
            }}
            onSelect={select}
            onLoadMore={() => void loadMore()}
          />
        </div>
        <div className={open ? "min-w-0" : "hidden min-w-0 md:block"}>
          {open ? (
            <WhatsAppConversation
              key={selectedId ?? `new-${newTarget?.clientId}-${newTarget?.phoneRef}`}
              conversationId={selectedId}
              newTarget={newTarget}
              status={status}
              onBack={close}
              onChanged={onChanged}
              onCreated={onCreated}
              renderReply={renderReply ? (input) => renderReply({ ...input, status }) : undefined}
            />
          ) : (
            <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">Selecione uma conversa.</p>
          )}
        </div>
      </div>
    </section>
  );
}
