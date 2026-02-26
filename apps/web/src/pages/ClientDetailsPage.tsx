import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import api from "../lib/apiClient";
import TimelineEventList, { TimelineEventItem } from "../components/TimelineEventList";

type Client = {
  id: string;
  name: string;
  city: string;
  state: string;
  region: string;
  potentialHa?: number | null;
  farmSizeHa?: number | null;
};

export default function ClientDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [events, setEvents] = useState<TimelineEventItem[]>([]);
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      if (!id) return;
      setLoading(true);
      try {
        const [clientRes, eventsRes] = await Promise.all([
          api.get(`/clients/${id}`),
          api.get(`/events?clientId=${id}&take=20`)
        ]);
        setClient(clientRes.data);
        setEvents(eventsRes.data?.items || []);
        setEventsCursor(eventsRes.data?.nextCursor || null);
      } catch {
        toast.error("Não foi possível carregar os detalhes do cliente");
        navigate("/clientes");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [id, navigate]);

  const loadMoreEvents = async () => {
    if (!id || !eventsCursor) return;
    setLoadingMoreEvents(true);
    try {
      const response = await api.get(`/events?clientId=${id}&take=20&cursor=${eventsCursor}`);
      setEvents((current) => [...current, ...(response.data?.items || [])]);
      setEventsCursor(response.data?.nextCursor || null);
    } finally {
      setLoadingMoreEvents(false);
    }
  };

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
        <TimelineEventList
          events={events}
          loading={loading}
          hasMore={Boolean(eventsCursor)}
          loadingMore={loadingMoreEvents}
          onLoadMore={() => void loadMoreEvents()}
          emptyMessage="Sem interações registradas."
          loadingMessage="Carregando timeline..."
        />
      </section>
    </div>
  );
}
