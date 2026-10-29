import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, Loader2, Wand2 } from "lucide-react";
import api from "../../lib/apiClient";
import { AI_REQUEST_TIMEOUT_MS } from "../../lib/aiRequest";
import { getApiErrorMessage } from "../../lib/apiError";
import { triggerDashboardRefresh } from "../../lib/dashboardRefresh";
import {
  buildDraftCard,
  confirmOpportunityDraft,
  isDraftCreated,
  isDraftExpired,
  reinterpretDraftCard,
  type OpportunityDraftCard as DraftCard,
  type OpportunityDraftResponse
} from "../../lib/opportunityDraft";
import { listOpportunityDrafts, removeOpportunityDraft, saveOpportunityDraft } from "../../lib/opportunityDraftStore";
import OpportunityDraftCard from "./OpportunityDraftCard";

type Props = { user: { id: string; name: string; role: string } };
type SellerOption = { id: string; name: string };

const formatInterpretedAt = (iso: string) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
};

// Nova oportunidade por frase: interpreta, mostra o rascunho editável e cria só depois da confirmação do vendedor.
// Os rascunhos ficam no aparelho ("Para confirmar"); se o armazenamento estiver bloqueado, valem só nesta tela.
export default function OpportunityDraftSection({ user }: Props) {
  const [drafts, setDrafts] = useState<DraftCard[]>(() => listOpportunityDrafts(user.id).map((item) => item.card));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [reinterpretId, setReinterpretId] = useState<string | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [storageFailed, setStorageFailed] = useState(false);
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const active = drafts.find((item) => item.id === activeId) ?? null;

  useEffect(() => {
    if (user.role === "vendedor") return;
    let alive = true;
    api.get("/opportunities/seller-options")
      .then((response) => {
        if (!alive) return;
        setSellers((Array.isArray(response.data) ? response.data : [])
          .filter((item: any) => item?.id && item?.name)
          .map((item: any) => ({ id: String(item.id), name: String(item.name) }))
          .sort((a: SellerOption, b: SellerOption) => a.name.localeCompare(b.name, "pt-BR")));
      })
      .catch(() => { if (alive) setSellers([]); });
    return () => { alive = false; };
  }, [user.role]);

  function persist(card: DraftCard) {
    setDrafts((items) => [card, ...items.filter((item) => item.id !== card.id)].sort((a, b) => b.interpretedAt.localeCompare(a.interpretedAt)));
    setStorageFailed(!saveOpportunityDraft(user.id, card));
  }

  function discard(card: DraftCard) {
    const message = isDraftCreated(card)
      ? "A oportunidade já foi criada; descartar só tira este rascunho do aparelho (os itens pendentes não serão enviados). Continuar?"
      : "Descartar este rascunho?";
    if (!window.confirm(message)) return;
    setDrafts((items) => items.filter((item) => item.id !== card.id));
    removeOpportunityDraft(user.id, card.id);
    if (activeId === card.id) setActiveId(null);
    if (reinterpretId === card.id) { setReinterpretId(null); setText(""); }
  }

  function startReinterpret(card: DraftCard) {
    setReinterpretId(card.id);
    setText(card.text);
    setActiveId(card.id);
    setError("");
    setCreated(null);
  }

  async function interpret() {
    const trimmed = text.trim();
    if (trimmed.length < 3 || interpreting) return;
    setInterpreting(true); setError(""); setCreated(null);
    try {
      const { data } = await api.post<OpportunityDraftResponse>("/ai/crm-assistant/opportunity-draft/parse", { text: trimmed }, { timeout: AI_REQUEST_TIMEOUT_MS });
      const previous = reinterpretId ? drafts.find((item) => item.id === reinterpretId) : null;
      const card = previous && !isDraftCreated(previous) ? reinterpretDraftCard(previous, data, trimmed) : buildDraftCard(data, trimmed);
      persist(card);
      setActiveId(card.id);
      setReinterpretId(null);
      setText("");
    } catch (err) {
      setError(getApiErrorMessage(err, "Não consegui interpretar a frase agora."));
    } finally { setInterpreting(false); }
  }

  async function confirm(card: DraftCard) {
    if (confirming) return;
    setConfirming(true);
    try {
      const result = await confirmOpportunityDraft(card, api, { onProgress: persist });
      if (result.status === "done") {
        setDrafts((items) => items.filter((item) => item.id !== card.id));
        removeOpportunityDraft(user.id, card.id);
        setActiveId(null);
        setCreated({ id: result.opportunityId, title: result.card.title });
        triggerDashboardRefresh();
      } else {
        persist(result.card);
      }
    } finally { setConfirming(false); }
  }

  return <section className="space-y-4 rounded-2xl border border-slate-200 p-4">
    <div>
      <p className="flex items-center gap-2 font-semibold text-slate-900"><Wand2 size={18} /> Nova oportunidade por frase</p>
      <p className="text-sm text-slate-600">Escreva como falaria: cliente, produto, sacas, preço e observação. Nada é criado antes da sua confirmação.</p>
    </div>
    <form onSubmit={(event) => { event.preventDefault(); interpret(); }} className="space-y-2">
      {reinterpretId && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Ao interpretar de novo, as escolhas feitas no cartão (cliente, produtos, datas e demais campos) serão refeitas a partir da nova frase.</p>}
      <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={1000} rows={3} placeholder="Ex.: Fazenda Exemplo, 10 sacas do produto Semente Teste a 90 reais, retorno na sexta" className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-brand-500" />
      <div className="flex gap-2">
        <button disabled={interpreting || text.trim().length < 3} className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-700 px-4 font-semibold text-white disabled:opacity-60 sm:flex-none">{interpreting && <Loader2 size={18} className="animate-spin" />} Interpretar</button>
        {reinterpretId && <button type="button" onClick={() => { setReinterpretId(null); setText(""); }} className="min-h-12 rounded-2xl border border-slate-200 px-4 font-semibold text-slate-700">Cancelar</button>}
      </div>
    </form>
    {error && <p className="rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {storageFailed && <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">Não foi possível guardar o rascunho neste aparelho; ele vale só enquanto esta tela estiver aberta.</p>}
    {created && <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">Oportunidade criada: <Link to={`/oportunidades/${created.id}`} className="font-semibold underline">{created.title}</Link></p>}

    {active && <OpportunityDraftCard
      key={active.id + active.interpretedAt}
      card={active}
      sellers={sellers}
      confirming={confirming}
      onChange={persist}
      onConfirm={() => confirm(active)}
      onReinterpret={() => startReinterpret(active)}
      onDiscard={() => discard(active)}
    />}

    {drafts.length > 0 && <div className="space-y-2">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-700"><ClipboardList size={16} /> Para confirmar</p>
      {drafts.map((card) => {
        const expired = !isDraftCreated(card) && isDraftExpired(card);
        return <div key={card.id} className={`flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between ${card.id === activeId ? "border-brand-300 bg-brand-50/40" : "border-slate-200"}`}>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{card.title}</p>
            <p className="text-xs text-slate-500">{card.client.selected?.name ?? card.client.spokenName ?? "Cliente a definir"} · {formatInterpretedAt(card.interpretedAt)}</p>
            {expired && <p className="text-xs font-semibold text-amber-700">Vencido (mais de 7 dias): descarte ou refaça.</p>}
            {isDraftCreated(card) && <p className="text-xs font-semibold text-amber-700">Oportunidade criada; há itens pendentes.</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            {expired
              ? <button type="button" onClick={() => startReinterpret(card)} className="min-h-10 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-700">Refazer</button>
              : card.id !== activeId && <button type="button" onClick={() => { setActiveId(card.id); setCreated(null); }} className="min-h-10 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-700">Abrir</button>}
            <button type="button" onClick={() => discard(card)} className="min-h-10 rounded-xl border border-red-100 px-3 text-sm font-semibold text-red-700">Descartar</button>
          </div>
        </div>;
      })}
    </div>}
  </section>;
}
