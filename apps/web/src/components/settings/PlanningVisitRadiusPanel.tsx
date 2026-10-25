import { useEffect, useState } from "react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";

type Props = {
  canEdit: boolean;
};

const DEFAULT_RADIUS_KM = 70;

export default function PlanningVisitRadiusPanel({ canEdit }: Props) {
  const [radiusKm, setRadiusKm] = useState<number>(DEFAULT_RADIUS_KM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<{ radiusKm: number }>("/settings/planning-visit-radius")
      .then((response) => setRadiusKm(response.data.radiusKm || DEFAULT_RADIUS_KM))
      .finally(() => setLoading(false));
  }, []);

  const valid = Number.isInteger(radiusKm) && radiusKm >= 10 && radiusKm <= 300;

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await api.put<{ radiusKm: number }>("/settings/planning-visit-radius", { radiusKm });
      setRadiusKm(response.data.radiusKm || DEFAULT_RADIUS_KM);
      toast.success("Raio salvo.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível salvar o raio."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <h3 className="text-sm font-semibold text-slate-900">Raio das visitas no planejamento semanal</h3>
      <p className="mt-1 text-xs text-slate-600">
        O planejamento da Agenda só coloca no mesmo dia visitas em cidades a até esta distância umas das outras, em linha reta.
        Ligações, WhatsApp e follow-ups completam o dia sem restrição de cidade.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-slate-500">Carregando configuração...</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 sm:max-w-sm">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Raio em km (10 a 300)</span>
            <input
              type="number"
              min={10}
              max={300}
              step={5}
              value={radiusKm || ""}
              disabled={!canEdit || saving}
              onChange={(event) => setRadiusKm(Number(event.target.value))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            />
          </label>
          {canEdit ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !valid}
              className="inline-flex w-fit items-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Salvando..." : "Salvar raio"}
            </button>
          ) : (
            <p className="text-xs text-slate-500">Somente gerentes e diretores podem alterar o raio.</p>
          )}
        </div>
      )}
    </div>
  );
}
