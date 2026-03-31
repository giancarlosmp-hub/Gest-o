import { useEffect, useMemo, useState } from "react";
import api from "../../lib/apiClient";

type ClientCommercialSummary = {
  openOpportunitiesCount?: number | null;
  lastActivityAt?: string | null;
  lastPurchaseDate?: string | null;
  lastPurchaseValue?: number | null;
  totalCompletedActivities?: number | null;
};

type ClientSummaryPayload = {
  potentialHa?: number | null;
  commercialSummary?: ClientCommercialSummary | null;
};

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

const daysSince = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
};

export default function ClientAutoSummaryCard({ clientId }: ClientAutoSummaryCardProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ClientSummaryPayload | null>(null);

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
        const response = await api.get(`/clients/${clientId}`);
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

  const summaryText = useMemo(() => {
    const summary = data?.commercialSummary;
    if (!summary) {
      return "Sem dados comerciais suficientes para gerar o resumo inteligente deste cliente.";
    }

    const openOpportunitiesCount = summary.openOpportunitiesCount ?? 0;
    const lastActivityDays = daysSince(summary.lastActivityAt);
    const lastPurchaseDays = daysSince(summary.lastPurchaseDate);

    const isInNegotiation = openOpportunitiesCount > 0;
    const isActive = !isInNegotiation && lastPurchaseDays !== null && lastPurchaseDays < 60;
    const isStopped = !isInNegotiation && openOpportunitiesCount === 0 && lastActivityDays !== null && lastActivityDays > 30;

    const currentStatus = isInNegotiation
      ? "cliente em fase de negociação"
      : isActive
        ? "cliente ativo"
        : isStopped
          ? "cliente parado"
          : "cliente em acompanhamento";

    const recommendation = isInNegotiation
      ? "Focar no fechamento das negociações abertas"
      : isActive
        ? "Manter acompanhamento"
        : isStopped
          ? "Recomendado retomar contato"
          : "Acompanhar novas interações e atualizar dados comerciais";

    const potential = typeof data?.potentialHa === "number" ? `${data.potentialHa} ha` : "potencial não informado";

    const hasAnySignal =
      typeof summary.openOpportunitiesCount === "number" ||
      Boolean(summary.lastActivityAt) ||
      Boolean(summary.lastPurchaseDate) ||
      typeof summary.lastPurchaseValue === "number" ||
      typeof summary.totalCompletedActivities === "number" ||
      typeof data?.potentialHa === "number";

    if (!hasAnySignal) {
      return "Sem dados comerciais suficientes para gerar o resumo inteligente deste cliente.";
    }

    return [
      `Cliente com potencial de ${potential}, atualmente com ${openOpportunitiesCount} oportunidade(s) aberta(s).`,
      `Última interação realizada em ${formatDatePtBr(summary.lastActivityAt)}.`,
      `Última compra registrada em ${formatDatePtBr(summary.lastPurchaseDate)} no valor de ${formatCurrencyPtBr(summary.lastPurchaseValue)}.`,
      `Atividades concluídas: ${summary.totalCompletedActivities ?? 0}.`,
      `Situação atual: ${currentStatus}.`,
      `Recomendação: ${recommendation}.`
    ].join("\n");
  }, [data]);

  if (!clientId) return null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-slate-900">🧠 Resumo automático do cliente</h3>

      {loading ? (
        <p className="text-sm text-slate-500">Gerando resumo automático...</p>
      ) : error ? (
        <p className="text-sm text-rose-600">{error}</p>
      ) : (
        <div className="space-y-3 text-sm text-slate-700">
          <p className="whitespace-pre-line leading-relaxed text-slate-800">{summaryText}</p>
        </div>
      )}
    </section>
  );
}
