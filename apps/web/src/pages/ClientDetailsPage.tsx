import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Calendar, MessageSquare, RefreshCw, Workflow, Wrench } from "lucide-react";
import { toast } from "sonner";
import api from "../lib/apiClient";

type TimelineEvent = {
  id: string;
  type: string;
  title: string;
  message: string;
  createdAt: string;
  badgeLabel: string;
  user?: { id: string; name: string; role: string };
  opportunity?: { id: string; title: string } | null;
};

const iconByType: Record<string, JSX.Element> = {
  comentario: <MessageSquare size={16} />,
  atividade: <Wrench size={16} />,
  mudanca_estagio: <Workflow size={16} />,
  criacao_oportunidade: <Calendar size={16} />,
  mudanca_followup: <RefreshCw size={16} />
};

const formatDateTime = (value: string) => new Date(value).toLocaleString("pt-BR");

const dayLabel = (value: string) => {
  const date = new Date(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (target.getTime() === today.getTime()) return "Hoje";
  if (target.getTime() === yesterday.getTime()) return "Ontem";
  return target.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
};

export default function ClientDetailsPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [client, setClient] = useState<any>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [message, setMessage] = useState("");
  const [opportunityId, setOpportunityId] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!id) return;
    const [clientRes, timelineRes] = await Promise.all([api.get(`/clients/${id}`), api.get(`/clients/${id}/timeline`)]);
    setClient(clientRes.data);
    setTimeline(timelineRes.data);
  };

  useEffect(() => {
    load().catch(() => toast.error("Não foi possível carregar o cliente"));
  }, [id]);

  const grouped = useMemo(() => {
    return timeline.reduce<Record<string, TimelineEvent[]>>((acc, event) => {
      const key = dayLabel(event.createdAt);
      if (!acc[key]) acc[key] = [];
      acc[key].push(event);
      return acc;
    }, {});
  }, [timeline]);

  const submitComment = async (e: FormEvent) => {
    e.preventDefault();
    if (!id || !message.trim()) return;
    setSaving(true);
    try {
      const { data } = await api.post(`/clients/${id}/timeline`, {
        message: message.trim(),
        opportunityId: opportunityId || undefined
      });
      setTimeline((prev) => [data, ...prev]);
      setMessage("");
      setOpportunityId("");
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Erro ao salvar comentário");
    } finally {
      setSaving(false);
    }
  };

  if (!client) return <div className="bg-white p-4 rounded-xl shadow">Carregando...</div>;

  return (
    <div className="space-y-4">
      <button className="text-sm text-slate-600" onClick={() => navigate(-1)}>
        ← Voltar
      </button>

      <div className="bg-white rounded-xl shadow p-4">
        <h2 className="text-2xl font-bold">{client.name}</h2>
        <p className="text-slate-600">{client.city} - {client.state} • Região {client.region}</p>
      </div>

      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h3 className="text-xl font-semibold">Linha do tempo</h3>

        <form onSubmit={submitComment} className="grid md:grid-cols-4 gap-2 items-start">
          <textarea
            className="border rounded p-2 md:col-span-2"
            rows={3}
            placeholder="Adicionar comentário"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <select className="border rounded p-2" value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)}>
            <option value="">Vincular à oportunidade (opcional)</option>
            {(client.opportunities || []).map((op: any) => (
              <option key={op.id} value={op.id}>{op.title}</option>
            ))}
          </select>
          <button disabled={saving} className="bg-blue-700 text-white rounded px-3 py-2 disabled:opacity-60">
            {saving ? "Salvando..." : "Salvar comentário"}
          </button>
        </form>

        <div className="space-y-6">
          {Object.entries(grouped).map(([group, events]) => (
            <div key={group}>
              <p className="text-xs uppercase text-slate-500 mb-2">{group}</p>
              <div className="space-y-3">
                {events.map((event) => (
                  <article key={event.id} className="border rounded-lg p-3 bg-slate-50">
                    <div className="flex justify-between gap-2">
                      <div className="flex items-center gap-2 font-medium">
                        <span className="text-slate-600">{iconByType[event.type] ?? <MessageSquare size={16} />}</span>
                        <span>{event.title}</span>
                        <span className="text-xs rounded-full bg-slate-200 px-2 py-0.5">{event.badgeLabel}</span>
                      </div>
                      <span className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</span>
                    </div>
                    <p className="text-sm text-slate-700 mt-1">{event.message}</p>
                    <p className="text-xs text-slate-500 mt-2">
                      {event.user?.name || "Usuário"} ({event.user?.role || "-"})
                      {event.opportunity ? ` • ${event.opportunity.title}` : ""}
                    </p>
                  </article>
                ))}
              </div>
            </div>
          ))}
          {!timeline.length && <p className="text-sm text-slate-500">Sem eventos para este cliente.</p>}
        </div>
      </section>
    </div>
  );
}
