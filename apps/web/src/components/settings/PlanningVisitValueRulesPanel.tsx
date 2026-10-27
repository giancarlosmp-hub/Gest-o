import { useEffect, useState } from "react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";

type Props = {
  canEdit: boolean;
};

type Rules = { tier1MinEstimatedValue: number; tier2MinEstimatedValue: number; opportunityMinValue: number };

const DEFAULT_RULES: Rules = { tier1MinEstimatedValue: 20000, tier2MinEstimatedValue: 5000, opportunityMinValue: 20000 };
const MAX_VALUE = 100_000_000;

const isValidValue = (value: number) => Number.isInteger(value) && value >= 1 && value <= MAX_VALUE;

export default function PlanningVisitValueRulesPanel({ canEdit }: Props) {
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<Rules>("/settings/planning-visit-rules")
      .then((response) => setRules({ ...DEFAULT_RULES, ...response.data }))
      .finally(() => setLoading(false));
  }, []);

  const tiersOrdered = rules.tier2MinEstimatedValue < rules.tier1MinEstimatedValue;
  const valid = isValidValue(rules.tier1MinEstimatedValue) && isValidValue(rules.tier2MinEstimatedValue) && isValidValue(rules.opportunityMinValue) && tiersOrdered;

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await api.put<Rules>("/settings/planning-visit-rules", rules);
      setRules({ ...DEFAULT_RULES, ...response.data });
      toast.success("Valores das visitas salvos.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível salvar os valores das visitas."));
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof Rules, label: string) => (
    <label className="space-y-1 text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <input
        type="number"
        min={1}
        step={1000}
        value={rules[key] || ""}
        disabled={!canEdit || saving}
        onChange={(event) => setRules((current) => ({ ...current, [key]: Number(event.target.value) }))}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
      />
    </label>
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <h3 className="text-sm font-semibold text-slate-900">Visitas sugeridas no planejamento semanal</h3>
      <p className="mt-1 text-xs text-slate-600">
        O planejamento da Agenda sugere visita ao cliente com valor estimado do cliente a partir da faixa 1 e mais de 45 dias sem
        visita, ou a partir da faixa 2 e mais de 90 dias sem visita. Cliente esfriando a partir da faixa 2 e oportunidade em
        negociação a partir do valor abaixo recebem visita em vez de ligação.
      </p>
      <p className="mt-1 text-xs text-slate-500">
        O valor estimado do cliente é uma aproximação: o maior entre a última fatura do ERP (se for dos últimos 12 meses) e os
        ganhos do CRM nos últimos 12 meses.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-slate-500">Carregando configuração...</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 sm:max-w-sm">
          {field("tier1MinEstimatedValue", "Faixa 1 — valor estimado do cliente (R$), 45 dias sem visita")}
          {field("tier2MinEstimatedValue", "Faixa 2 — valor estimado do cliente (R$), 90 dias sem visita")}
          {field("opportunityMinValue", "Oportunidade em negociação (R$)")}
          {!tiersOrdered ? <p className="text-xs font-medium text-amber-700">A faixa 2 precisa ser menor que a faixa 1.</p> : null}
          {canEdit ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !valid}
              className="inline-flex w-fit items-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Salvando..." : "Salvar valores"}
            </button>
          ) : (
            <p className="text-xs text-slate-500">Somente gerentes e diretores podem alterar estes valores.</p>
          )}
        </div>
      )}
    </div>
  );
}
