import { useEffect, useState } from "react";
import api from "../../lib/apiClient";

type Props = {
  canEdit: boolean;
};

export default function WeeklyVisitMinimumPanel({ canEdit }: Props) {
  const [minimumWeeklyVisits, setMinimumWeeklyVisits] = useState<number>(15);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<{ minimumWeeklyVisits: number }>("/settings/weekly-visit-minimum")
      .then((response) => setMinimumWeeklyVisits(response.data.minimumWeeklyVisits || 15))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await api.put<{ minimumWeeklyVisits: number }>("/settings/weekly-visit-minimum", {
        minimumWeeklyVisits
      });
      setMinimumWeeklyVisits(response.data.minimumWeeklyVisits || 15);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <h3 className="text-sm font-semibold text-slate-900">Meta mínima de visitas por semana</h3>
      <p className="mt-1 text-xs text-slate-600">Define o mínimo de visitas planejadas (segunda a domingo) para monitorar disciplina operacional.</p>

      {loading ? (
        <p className="mt-4 text-sm text-slate-500">Carregando configuração...</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 sm:max-w-sm">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Meta mínima de visitas por semana</span>
            <input
              type="number"
              min={1}
              max={200}
              value={minimumWeeklyVisits}
              disabled={!canEdit || saving}
              onChange={(event) => setMinimumWeeklyVisits(Number(event.target.value) || 1)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            />
          </label>
          {canEdit ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex w-fit items-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Salvando..." : "Salvar meta"}
            </button>
          ) : (
            <p className="text-xs text-slate-500">Somente diretores podem alterar esta meta.</p>
          )}
        </div>
      )}
    </div>
  );
}
