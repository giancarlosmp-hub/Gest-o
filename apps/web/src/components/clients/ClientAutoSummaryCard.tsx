import { useEffect, useState } from "react";
import api from "../../lib/apiClient";

type ClientSummary = {
  summary: string;
  profileTags: string[];
  currentMoment: string;
  recommendedApproach: string;
  lastRelevantSignals: string[];
};

type ClientAutoSummaryCardProps = {
  clientId?: string;
};

export default function ClientAutoSummaryCard({ clientId }: ClientAutoSummaryCardProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ClientSummary | null>(null);

  useEffect(() => {
    const load = async () => {
      if (!clientId) {
        setLoading(false);
        setError(null);
        setData(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await api.get(`/ai/client-summary/${clientId}`);
        setData(response.data || null);
      } catch {
        setData(null);
        setError("Não foi possível carregar o resumo automático deste cliente.");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [clientId]);

  if (!clientId) return null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-slate-900">🧠 Resumo automático do cliente</h3>

      {loading ? (
        <p className="text-sm text-slate-500">Gerando resumo automático...</p>
      ) : error ? (
        <p className="text-sm text-rose-600">{error}</p>
      ) : !data ? (
        <p className="text-sm text-slate-500">Resumo indisponível para este cliente no momento.</p>
      ) : (
        <div className="space-y-3 text-sm text-slate-700">
          <p className="whitespace-pre-line leading-relaxed text-slate-800">{data.summary}</p>

          <div className="grid gap-3 md:grid-cols-2">
            <p><strong>Momento atual:</strong> {data.currentMoment || "-"}</p>
            <p><strong>Abordagem recomendada:</strong> {data.recommendedApproach || "-"}</p>
          </div>

          <div>
            <p className="mb-2 font-semibold text-slate-800">Tags de perfil</p>
            <div className="flex flex-wrap gap-2">
              {data.profileTags?.length ? data.profileTags.map((tag) => (
                <span key={tag} className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
                  {tag}
                </span>
              )) : <span className="text-slate-500">Sem tags geradas.</span>}
            </div>
          </div>

          <div>
            <p className="mb-2 font-semibold text-slate-800">Sinais relevantes</p>
            {data.lastRelevantSignals?.length ? (
              <ul className="list-disc space-y-1 pl-5 text-slate-700">
                {data.lastRelevantSignals.map((signal) => <li key={signal}>{signal}</li>)}
              </ul>
            ) : (
              <p className="text-slate-500">Sem sinais relevantes identificados.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
