import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Link2, Trash2, UserX } from "lucide-react";
import api from "../../lib/apiClient";
import ClientSelect from "../ClientSelect";
import {
  formatBrazilDayMonth,
  formatWhatsAppTime,
  whatsappExpiryLabel,
  type WhatsAppUnlinkedItem,
  type WhatsAppUnlinkedPage
} from "../../lib/whatsappMessages";

// WhatsApp Fase B2: "Conversas não vinculadas" do próprio número (cada um vê só a sua). O vendedor vincula a
// um cliente da carteira dele (o telefone vira contato do cliente) ou descarta. Sem vínculo em 7 dias, a
// conversa é apagada.

export const UNLINKED_SECTION_ID = "conversas-nao-vinculadas";

const apiMessage = (error: unknown, fallback: string) =>
  ((error as { response?: { data?: { message?: unknown } } })?.response?.data?.message as string | undefined) || fallback;

type ViewProps = {
  items: WhatsAppUnlinkedItem[];
  total: number;
  hasMore: boolean;
  busyId: string | null;
  linkingId: string | null;
  selectedClientId: string;
  onStartLink: (id: string) => void;
  onCancelLink: () => void;
  onSelectClient: (clientId: string) => void;
  onConfirmLink: () => void;
  onDiscard: (id: string) => void;
  onLoadMore: () => void;
};

const lastMessageLine = (item: WhatsAppUnlinkedItem) => {
  if (!item.lastMessage) return null;
  const at = item.lastMessage.at ? `${formatBrazilDayMonth(item.lastMessage.at)} ${formatWhatsAppTime(item.lastMessage.at)}` : "";
  return { prefix: item.lastMessage.direction === "outbound" ? "Você: " : "", text: item.lastMessage.text, at };
};

/** Parte visual, sem rede: usada pelo cartão e pelos testes. */
export function UnlinkedConversationsView(props: ViewProps) {
  const { items, total } = props;
  return (
    <section id={UNLINKED_SECTION_ID} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-labelledby="unlinked-conversations-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id="unlinked-conversations-title" className="flex items-center gap-2 text-lg font-bold text-slate-900">
          <UserX size={18} aria-hidden="true" /> Conversas não vinculadas
        </h2>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700" data-unlinked-total={total}>
          {total}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        Conversas do seu número com telefones que não estão em nenhum cliente (ou estão em mais de um). Vincule a um cliente ou descarte; sem
        vínculo, são apagadas em 7 dias.
      </p>

      {!items.length ? <p className="mt-3 text-sm text-slate-500">Nenhuma conversa aguardando vínculo.</p> : null}

      <ul className="mt-3 space-y-3">
        {items.map((item) => {
          const last = lastMessageLine(item);
          const busy = props.busyId === item.id;
          const linking = props.linkingId === item.id;
          const expiry = whatsappExpiryLabel(item.daysToExpire);
          return (
            <li key={item.id} className="rounded-lg border border-slate-200 p-3 text-sm" data-unlinked-id={item.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">{item.phone ?? "Número indisponível"}</p>
                  {item.pushName ? <p className="text-xs text-slate-500">No WhatsApp: {item.pushName}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {item.status === "ambiguous" ? <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-800">mais de um cliente</span> : null}
                  {expiry ? <span className={`rounded-full px-2 py-0.5 font-semibold ${(item.daysToExpire ?? 7) <= 1 ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{expiry}</span> : null}
                </div>
              </div>
              {last ? (
                <p className="mt-2 break-words text-slate-700">
                  <span className="text-slate-500">{last.prefix}</span>
                  {last.text}
                  {last.at ? <span className="ml-2 text-xs text-slate-500">{last.at}</span> : null}
                </p>
              ) : null}

              {linking ? (
                <div className="mt-3 space-y-2">
                  <ClientSelect value={props.selectedClientId} onChange={(client) => props.onSelectClient(client?.id ?? "")} />
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={props.onConfirmLink} disabled={busy || !props.selectedClientId} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">
                      {busy ? "Vinculando..." : "Confirmar vínculo"}
                    </button>
                    <button type="button" onClick={props.onCancelLink} disabled={busy} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700">
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => props.onStartLink(item.id)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-semibold text-emerald-700 disabled:opacity-60">
                    <Link2 size={14} aria-hidden="true" /> Vincular a um cliente
                  </button>
                  <button type="button" onClick={() => props.onDiscard(item.id)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-60">
                    <Trash2 size={14} aria-hidden="true" /> Descartar
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {props.hasMore ? (
        <button type="button" onClick={props.onLoadMore} className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700">
          Carregar mais
        </button>
      ) : null}
    </section>
  );
}

const linkedMessage = (contact: string) => {
  if (contact === "created") return "Conversa vinculada. O telefone foi salvo nos contatos do cliente.";
  if (contact === "skipped_ambiguous") return "Conversa vinculada. O telefone está em outro cliente e não foi salvo como contato.";
  return "Conversa vinculada.";
};

/** Cartão completo. Fila vazia ou consulta com falha: não aparece (o cartão "Meu número" mostra o contador). */
export default function UnlinkedConversationsCard({ onChanged }: { onChanged?: () => void }) {
  const [page, setPage] = useState<WhatsAppUnlinkedPage | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await api.get<WhatsAppUnlinkedPage>("/whatsapp/unlinked");
      setPage(response.data);
    } catch {
      // Falha ao consultar não derruba a página.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!page) return null;

  const removeItem = (id: string) => {
    setPage((current) => (current ? { ...current, items: current.items.filter((item) => item.id !== id), total: Math.max(0, current.total - 1) } : current));
    onChanged?.();
  };

  const confirmLink = async () => {
    if (!linkingId || !selectedClientId) return;
    setBusyId(linkingId);
    try {
      const response = await api.post<{ contact: string }>(`/whatsapp/unlinked/${linkingId}/link`, { clientId: selectedClientId });
      toast.success(linkedMessage(response.data.contact));
      removeItem(linkingId);
      setLinkingId(null);
      setSelectedClientId("");
    } catch (error) {
      toast.error(apiMessage(error, "Não foi possível vincular a conversa."));
      void refresh();
    } finally {
      setBusyId(null);
    }
  };

  const discard = async (id: string) => {
    if (!window.confirm("Descartar esta conversa? As mensagens dela serão apagadas do CRM.")) return;
    setBusyId(id);
    try {
      await api.post(`/whatsapp/unlinked/${id}/discard`);
      toast.success("Conversa descartada.");
      removeItem(id);
    } catch (error) {
      toast.error(apiMessage(error, "Não foi possível descartar a conversa."));
      void refresh();
    } finally {
      setBusyId(null);
    }
  };

  const loadMore = async () => {
    if (!page.nextCursor) return;
    try {
      const response = await api.get<WhatsAppUnlinkedPage>("/whatsapp/unlinked", { params: { cursor: page.nextCursor } });
      setPage((current) => (current ? { ...response.data, items: [...current.items, ...response.data.items] } : response.data));
    } catch {
      toast.error("Não foi possível carregar mais conversas.");
    }
  };

  if (!page.total && !page.items.length) return null;

  return (
    <UnlinkedConversationsView
      items={page.items}
      total={page.total}
      hasMore={Boolean(page.nextCursor)}
      busyId={busyId}
      linkingId={linkingId}
      selectedClientId={selectedClientId}
      onStartLink={(id) => {
        setLinkingId(id);
        setSelectedClientId("");
      }}
      onCancelLink={() => {
        setLinkingId(null);
        setSelectedClientId("");
      }}
      onSelectClient={setSelectedClientId}
      onConfirmLink={() => void confirmLink()}
      onDiscard={(id) => void discard(id)}
      onLoadMore={() => void loadMore()}
    />
  );
}
