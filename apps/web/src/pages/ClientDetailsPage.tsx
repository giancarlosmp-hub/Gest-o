import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import api from "../lib/apiClient";

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short"
});

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

type Client = {
  id: string;
  name: string;
  city: string;
  state: string;
  region: string;
  potentialHa?: number | null;
  farmSizeHa?: number | null;
};

const eventLabel: Record<EventType, string> = {
  comentario: "Comentário",
  mudanca_etapa: "Mudança de etapa",
  status: "Status"
};

export default function ClientDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      if (!id) return;
      setLoading(true);
      try {
        const [clientRes, eventsRes] = await Promise.all([
          api.get(`/clients/${id}`),
          api.get(`/events?clientId=${id}`)
        ]);
        setClient(clientRes.data);
        setEvents(eventsRes.data || []);
      } catch {
        toast.error("Não foi possível carregar os detalhes do cliente");
        navigate("/clientes");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [id, navigate]);

  if (loading) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-500">Carregando detalhes do cliente...</div>;
  }

  if (!client) return null;

  return (
    <div className="space-y-4 pb-5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900">Detalhes do Cliente</h2>
        <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => navigate("/clientes")}>Voltar</button>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Resumo</h3>
        <div className="grid gap-2 text-sm md:grid-cols-2 lg:grid-cols-3">
          <p><strong>Nome:</strong> {client.name}</p>
          <p><strong>Cidade:</strong> {client.city}</p>
          <p><strong>UF:</strong> {client.state}</p>
          <p><strong>Região:</strong> {client.region}</p>
          <p><strong>Potencial (ha):</strong> {client.potentialHa ?? "-"}</p>
          <p><strong>Área total (ha):</strong> {client.farmSizeHa ?? "-"}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Linha do Tempo</h3>
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
    </div>
  );
}
