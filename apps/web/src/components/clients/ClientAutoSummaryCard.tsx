import { useEffect, useState } from "react";
import api from "../../lib/apiClient";

type ClientCommercialSummary = {
  openOpportunitiesCount?: number | null;
  lastActivityAt?: string | null;
  lastPurchaseDate?: string | null;
  lastPurchaseValue?: number | null;
  totalCompletedActivities?: number | null;
};

type ClientFallbackPayload = {
  name?: string | null;
  city?: string | null;
  state?: string | null;
  potentialHa?: number | null;
  commercialSummary?: ClientCommercialSummary | null;
};

type ClientAiSummaryPayload = {
  source?: "ai" | "deterministic" | "system" | null;
  summary?: string | null;
  profileTags?: string[] | null;
  currentMoment?: string | null;
  recommendedApproach?: string | null;
  lastRelevantSignals?: string[] | null;
};

type SummaryState =
  | { kind: "ai-summary"; payload: ClientAiSummaryPayload }
  | { kind: "commercial-summary-fallback"; payload: ClientFallbackPayload };

type ClientAutoSummaryCardProps = {
  clientId?: string;
};

const formatDatePtBr = (value?: string | null) => {
  if (!value) return "não informada";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "não informada";
  return new Intl.DateTimeFormat("pt-BR").format(date);
};

const formatCurrencyPtBr = (value?: number | null) => {
  if (typeof value !== "number" || Number.isNaN(value)) return "não informado";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
};

const getSourceLabel = (payload?: ClientAiSummaryPayload | null) => (payload?.source === "ai" ? "IA" : "sistema");

export default function ClientAutoSummaryCard({ clientId }: ClientAutoSummaryCardProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summaryState, setSummaryState] = useState<SummaryState | null>(null);

  useEffect(() => {
    const load = async () => {
      if (!clientId) {
        setLoading(false);
        setError(null);
        setSummaryState(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await api.get<ClientAiSummaryPayload>(`/ai/client-summary/${clientId}`);
        setSummaryState({ kind: "ai-summary", payload: response.data || {} });
      } catch {
        try {
          const fallbackResponse = await api.get<ClientFallbackPayload>(`/clients/${clientId}`);
          setSummaryState({ kind: "commercial-summary-fallback", payload: fallbackResponse.data || {} });
        } catch {
          setSummaryState(null);
          setError("Não foi possível carregar o resumo automático deste cliente.");
        }
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [clientId]);

  if (!clientId) return null;

  const aiPayload = summaryState?.kind === "ai-summary" ? summaryState.payload : null;
  const fallbackPayload = summaryState?.kind === "commercial-summary-fallback" ? summaryState.payload : null;
  const fallbackSummary = fallbackPayload?.commercialSummary;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <h3 className="text-lg font-semibold text-slate-900">🧠 Resumo automático do cliente</h3>
        {!loading && !error && summaryState ? (
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Fonte: {summaryState.kind === "ai-summary" ? getSourceLabel(aiPayload) : "sistema"}
          </span>
        ) : null}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Gerando resumo automático...</p>
      ) : error ? (
        <p className="text-sm text-rose-600">{error}</p>
      ) : aiPayload ? (
        <div className="space-y-3 text-sm text-slate-700">
          <p className="whitespace-pre-line leading-relaxed text-slate-800">
            {aiPayload.summary || "Sem dados comerciais suficientes para gerar o resumo automático deste cliente."}
          </p>
          {aiPayload.currentMoment ? (
            <p>
              <span className="font-semibold text-slate-800">Momento atual:</span> {aiPayload.currentMoment}
            </p>
          ) : null}
          {aiPayload.recommendedApproach ? (
            <p>
              <span className="font-semibold text-slate-800">Abordagem recomendada:</span> {aiPayload.recommendedApproach}
            </p>
          ) : null}
          {aiPayload.profileTags?.length ? (
            <div className="flex flex-wrap gap-2">
              {aiPayload.profileTags.map((tag) => (
                <span key={tag} className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          {aiPayload.lastRelevantSignals?.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {aiPayload.lastRelevantSignals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : fallbackSummary ? (
        <div className="space-y-2 text-sm text-slate-700">
          <p className="text-xs text-amber-700">Resumo de IA indisponível. Exibindo dados comerciais do cadastro.</p>
          <p>
            <span className="font-semibold text-slate-800">Cliente:</span> {fallbackPayload?.name || "não informado"}
            {fallbackPayload?.city || fallbackPayload?.state ? ` (${fallbackPayload?.city || "-"}/${fallbackPayload?.state || "-"})` : ""}
          </p>
          <p>
            <span className="font-semibold text-slate-800">Potencial:</span>{" "}
            {typeof fallbackPayload?.potentialHa === "number" ? `${fallbackPayload.potentialHa} ha` : "não informado"}
          </p>
          <p>
            <span className="font-semibold text-slate-800">Oportunidades abertas:</span> {fallbackSummary.openOpportunitiesCount ?? 0}
          </p>
          <p>
            <span className="font-semibold text-slate-800">Última interação:</span> {formatDatePtBr(fallbackSummary.lastActivityAt)}
          </p>
          <p>
            <span className="font-semibold text-slate-800">Última compra:</span> {formatDatePtBr(fallbackSummary.lastPurchaseDate)} ({formatCurrencyPtBr(fallbackSummary.lastPurchaseValue)})
          </p>
          <p>
            <span className="font-semibold text-slate-800">Atividades concluídas:</span> {fallbackSummary.totalCompletedActivities ?? 0}
          </p>
        </div>
      ) : (
        <p className="text-sm text-slate-500">Sem dados comerciais suficientes para gerar o resumo automático deste cliente.</p>
      )}
    </section>
  );
}
