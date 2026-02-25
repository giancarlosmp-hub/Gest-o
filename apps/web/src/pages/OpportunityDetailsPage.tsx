import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import api from "../lib/apiClient";
import { formatCurrencyBRL, formatDateBR, formatPercentBR } from "../lib/formatters";

type Stage = "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido";
type EventType = "comentario" | "mudanca_etapa" | "status";

type EventItem = {
  id: string;
  type: EventType;
  description: string;
  createdAt: string;
  ownerSeller?: {
    id: string;
    name: string;
  } | null;
};

type Opportunity = {
  id: string;
  clientId: string;
  title: string;
  client?: string;
  owner?: string;
  stage: Stage;
  value: number;
  probability?: number | null;
  weightedValue?: number;
  proposalDate: string;
  expectedCloseDate: string;
  plantingForecastDate?: string | null;
  crop?: string | null;
  season?: string | null;
  areaHa?: number | null;
  productOffered?: string | null;
  expectedTicketPerHa?: number | null;
  lastContactAt?: string | null;
  notes?: string | null;
  daysOverdue?: number | null;
};

const stageFlow: Stage[] = ["prospeccao", "negociacao", "proposta", "ganho"];
const stageLabel: Record<Stage, string> = {
  prospeccao: "Prospecção",
  negociacao: "Negociação",
  proposta: "Proposta",
  ganho: "Ganho",
  perdido: "Perdido"
};

const eventLabel: Record<EventType, string> = {
  comentario: "Comentário",
  mudanca_etapa: "Mudança de etapa",
  status: "Status"
};

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short"
});

export default function OpportunityDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<Opportunity | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [interactionNote, setInteractionNote] = useState("");
  const [showLossModal, setShowLossModal] = useState(false);
  const [lossReason, setLossReason] = useState("");
  const [events, setEvents] = useState<EventItem[]>([]);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [opportunityResponse, eventsResponse] = await Promise.all([
        api.get(`/opportunities/${id}`),
        api.get(`/events?opportunityId=${id}`)
      ]);
      setItem(opportunityResponse.data);
      setEvents(eventsResponse.data || []);
    } catch {
      toast.error("Não foi possível carregar a oportunidade");
      navigate("/oportunidades");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => toast.error("Erro ao carregar detalhes"));
  }, [id]);

  const valuePerHa = useMemo(() => {
    if (!item?.areaHa || item.areaHa <= 0) return null;
    return item.value / item.areaHa;
  }, [item]);

  const estimatedTicketTotal = useMemo(() => {
    if (!item?.areaHa || !item?.expectedTicketPerHa) return null;
    return item.areaHa * item.expectedTicketPerHa;
  }, [item]);

  const registerEvent = async (payload: { type?: EventType; description: string }) => {
    if (!item) return;

    await api.post("/events", {
      type: payload.type || "comentario",
      description: payload.description,
      opportunityId: item.id,
    });
  };

  const updateOpportunity = async (payload: Partial<Opportunity>) => {
    if (!item) return;
    setSaving(true);
    try {
      await api.put(`/opportunities/${item.id}`, payload);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const onRegisterInteraction = async (event: FormEvent) => {
    event.preventDefault();
    if (!item) return;

    const newEntry = interactionNote.trim();
    if (!newEntry) {
      toast.error("Escreva uma nota para registrar a interação");
      return;
    }

    const now = new Date();

    await Promise.all([
      registerEvent({ type: "comentario", description: newEntry }),
      updateOpportunity({ lastContactAt: now.toISOString() })
    ]);

    setInteractionNote("");
    toast.success("Interação registrada");
  };

  const onAdvanceStage = async () => {
    if (!item) return;
    if (item.stage === "ganho" || item.stage === "perdido") {
      toast.error("A oportunidade já está encerrada");
      return;
    }
    const currentIndex = stageFlow.indexOf(item.stage);
    const nextStage = stageFlow[Math.min(currentIndex + 1, stageFlow.length - 1)];
    await updateOpportunity({ stage: nextStage });
    toast.success("Etapa avançada");
  };

  const onMarkWon = async () => {
    await updateOpportunity({ stage: "ganho" });
    await registerEvent({ type: "status", description: "Oportunidade marcada como ganho" });
    toast.success("Oportunidade marcada como ganho");
  };

  const onMarkLost = async (event: FormEvent) => {
    event.preventDefault();
    if (!lossReason.trim()) {
      toast.error("Informe o motivo da perda");
      return;
    }

    await updateOpportunity({ stage: "perdido" });
    await registerEvent({ type: "status", description: `Motivo da perda: ${lossReason.trim()}` });

    toast.success("Oportunidade marcada como perdida");
    setLossReason("");
    setShowLossModal(false);
  };

  if (loading) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-500">Carregando detalhes da oportunidade...</div>;
  }

  if (!item) return null;

  return (
    <div className="space-y-4 pb-5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900">Visão da Oportunidade</h2>
        <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => navigate("/oportunidades")}>Voltar</button>
      </div>

      {item.daysOverdue && item.daysOverdue > 0 ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          Atenção: oportunidade atrasada há {item.daysOverdue} dia(s).
        </div>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Resumo</h3>
        <div className="grid gap-2 text-sm md:grid-cols-2 lg:grid-cols-3">
          <p><strong>Título:</strong> {item.title}</p>
          <p><strong>Cliente:</strong> {item.clientId ? <Link className="text-blue-700" to={`/clientes/${item.clientId}`}>{item.client || "-"}</Link> : (item.client || "-")}</p>
          <p><strong>Vendedor:</strong> {item.owner || "-"}</p>
          <p><strong>Etapa:</strong> {stageLabel[item.stage]}</p>
          <p><strong>Valor:</strong> {formatCurrencyBRL(item.value)}</p>
          <p><strong>Probabilidade:</strong> {formatPercentBR(item.probability || 0, 0)}</p>
          <p><strong>Ponderado:</strong> {formatCurrencyBRL(item.weightedValue || 0)}</p>
          <p><strong>Entrada proposta:</strong> {formatDateBR(item.proposalDate)}</p>
          <p><strong>Retorno previsto:</strong> {formatDateBR(item.expectedCloseDate)}</p>
          <p><strong>Previsão plantio:</strong> {formatDateBR(item.plantingForecastDate || "")}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Bloco Agro</h3>
        <div className="grid gap-2 text-sm md:grid-cols-2 lg:grid-cols-3">
          <p><strong>Cultura:</strong> {item.crop || "-"}</p>
          <p><strong>Safra:</strong> {item.season || "-"}</p>
          <p><strong>Área (ha):</strong> {item.areaHa ?? "-"}</p>
          <p><strong>Produto ofertado:</strong> {item.productOffered || "-"}</p>
          <p><strong>Ticket por ha:</strong> {item.expectedTicketPerHa ? formatCurrencyBRL(item.expectedTicketPerHa) : "-"}</p>
          <p><strong>Valor/ha:</strong> {valuePerHa ? formatCurrencyBRL(valuePerHa) : "-"}</p>
          <p><strong>Ticket estimado total:</strong> {estimatedTicketTotal ? formatCurrencyBRL(estimatedTicketTotal) : "-"}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Registrar Interação</h3>
        <p className="text-sm"><strong>Última interação:</strong> {item.lastContactAt ? formatDateBR(item.lastContactAt) : "Sem interação registrada"}</p>
        <form className="mt-3 space-y-2" onSubmit={onRegisterInteraction}>
          <textarea className="w-full rounded-lg border border-slate-200 p-2 text-sm" rows={3} placeholder="Escreva um resumo da interação" value={interactionNote} onChange={(event) => setInteractionNote(event.target.value)} />
          <button type="submit" disabled={saving} className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:bg-slate-500">Salvar</button>
        </form>

        <h3 className="mt-5 mb-3 text-lg font-semibold">Linha do Tempo</h3>
        <div className="space-y-2">
          {events.length ? events.map((event) => (
            <div key={event.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-800">{eventLabel[event.type]}</span>
                <span className="text-xs text-slate-500">{dateTimeFormatter.format(new Date(event.createdAt))}</span>
              </div>
              <p className="mt-1 text-slate-700">{event.description}</p>
              <p className="mt-1 text-xs text-slate-500">por {event.ownerSeller?.name || "Usuário"}</p>
            </div>
          )) : <p className="text-sm text-slate-500">Sem interações registradas.</p>}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Ações</h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={saving} onClick={onAdvanceStage} className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">Avançar etapa</button>
          <button type="button" disabled={saving} onClick={onMarkWon} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-50">Marcar como ganho</button>
          <button type="button" disabled={saving} onClick={() => setShowLossModal(true)} className="rounded-lg bg-red-600 px-3 py-2 text-sm text-white disabled:opacity-50">Marcar como perdido</button>
        </div>
      </section>

      {showLossModal ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4" onClick={() => setShowLossModal(false)}>
          <form className="w-full max-w-lg space-y-3 rounded-2xl bg-white p-5" onSubmit={onMarkLost} onClick={(event) => event.stopPropagation()}>
            <h4 className="text-lg font-semibold text-slate-900">Motivo da perda</h4>
            <textarea className="w-full rounded-lg border border-slate-200 p-2 text-sm" rows={4} placeholder="Descreva o motivo" value={lossReason} onChange={(event) => setLossReason(event.target.value)} />
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => setShowLossModal(false)}>Cancelar</button>
              <button type="submit" className="rounded-lg bg-red-600 px-3 py-2 text-sm text-white">Confirmar perda</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
