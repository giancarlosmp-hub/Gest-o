import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommercialAutomationsConfig, CommercialAutomationsSimulation } from "@salesforce-pro/shared";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";

type Props = {
  canEdit: boolean;
};

const DEFAULT_CONFIG: CommercialAutomationsConfig = {
  inactiveClientWorkflow: {
    enabled: false,
    daysWithoutPurchase: 90,
    allowedOptions: [30, 60, 90],
    customDaysEnabled: true,
    returnDeadlineBusinessDays: 2,
    initialOpportunityStage: "prospeccao",
    dailyLimitPerSeller: 5,
    createOpportunity: true,
    createActivity: true,
    createTimelineEvent: true
  }
};

const OPPORTUNITY_STAGE_OPTIONS = [
  { value: "prospeccao", label: "Prospecção" },
  { value: "negociacao", label: "Negociação" },
  { value: "proposta", label: "Proposta" }
];

const formatDayKey = (dayKey: string) => dayKey.split("-").reverse().join("/");

export default function CommercialAutomationsPanel({ canEdit }: Props) {
  const [config, setConfig] = useState<CommercialAutomationsConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<CommercialAutomationsSimulation | null>(null);
  const [simulationError, setSimulationError] = useState(false);

  const loadSimulation = useCallback(() => {
    setSimulationError(false);
    api
      .get<CommercialAutomationsSimulation>("/commercial-automations/simulation")
      .then((response) => setSimulation(response.data))
      .catch(() => setSimulationError(true));
  }, []);

  useEffect(() => {
    api
      .get<CommercialAutomationsConfig>("/settings/commercial-automations")
      .then((response) => setConfig(response.data))
      .finally(() => setLoading(false));
    loadSimulation();
  }, [loadSimulation]);

  const workflow = config.inactiveClientWorkflow;
  const stageIsValid = OPPORTUNITY_STAGE_OPTIONS.some((option) => option.value === workflow.initialOpportunityStage);

  const canSave = useMemo(() => {
    return workflow.dailyLimitPerSeller >= 1 && workflow.dailyLimitPerSeller <= 50 && workflow.returnDeadlineBusinessDays >= 1 && workflow.returnDeadlineBusinessDays <= 2;
  }, [workflow.dailyLimitPerSeller, workflow.returnDeadlineBusinessDays]);

  const updateWorkflow = (updates: Partial<CommercialAutomationsConfig["inactiveClientWorkflow"]>) => {
    setConfig((current) => ({
      ...current,
      inactiveClientWorkflow: {
        ...current.inactiveClientWorkflow,
        ...updates
      }
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await api.put<CommercialAutomationsConfig>("/settings/commercial-automations", config);
      setConfig(response.data);
      loadSimulation();
    } catch (error) {
      setSaveError(getApiErrorMessage(error, "Não foi possível salvar as automações."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Automações Comerciais</h3>
        <p className="mt-1 text-xs text-slate-600">
          Reativação de inativos recentes (12 a 24 meses sem compra, pela regra oficial da carteira). Quando ligada, cria
          oportunidades de valor zero para o vendedor responsável, respeitando o teto diário por vendedor.
        </p>
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-slate-500">Carregando configuração...</p>
      ) : (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm lg:col-span-2">
            <input
              type="checkbox"
              checked={workflow.enabled}
              disabled={!canEdit || saving}
              onChange={(event) => updateWorkflow({ enabled: event.target.checked })}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600 disabled:cursor-not-allowed"
            />
            <span>
              <span className="block font-medium text-slate-800">Ativar automação de inativos recentes</span>
              <span className="mt-1 block text-xs text-slate-500">
                Desligada, nada é criado. Confira a simulação abaixo antes de ligar.
              </span>
            </span>
          </label>

          <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 text-sm lg:col-span-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium text-slate-700">Simulação de hoje (somente leitura)</p>
              {simulation && <span className="text-xs text-slate-500">{formatDayKey(simulation.dayKey)}, com a configuração salva</span>}
            </div>
            {simulationError ? (
              <p className="text-xs text-red-700">Não foi possível carregar a simulação.</p>
            ) : !simulation ? (
              <p className="text-xs text-slate-500">Calculando...</p>
            ) : (
              <>
                <p className="text-slate-800">
                  <span className="text-2xl font-semibold text-slate-900">{simulation.wouldCreate}</span>{" "}
                  {simulation.wouldCreate === 1 ? "oportunidade seria criada hoje" : "oportunidades seriam criadas hoje"}
                  {!simulation.enabled && <span className="text-slate-500"> se a automação estivesse ligada</span>}
                </p>
                <ul className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                  <li>Inativos recentes na carteira: {simulation.inactiveRecentClients}</li>
                  <li>Elegíveis: {simulation.eligibleClients}</li>
                  <li>Ficam para os próximos dias (teto de {simulation.dailyLimitPerSeller} por vendedor): {simulation.skipped.dailyLimit}</li>
                  <li>Já com oportunidade aberta: {simulation.skipped.openOpportunity}</li>
                  <li>Com reativação automática nos últimos 90 dias: {simulation.skipped.recentAutomation}</li>
                  <li>Vendedor responsável inativo: {simulation.skipped.inactiveSeller}</li>
                </ul>
                {simulation.configIssues.length > 0 && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                    <p className="font-medium">A configuração salva precisa de ajuste; a automação não roda assim:</p>
                    <ul className="mt-1 list-disc pl-4">
                      {simulation.configIssues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>

          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Teto diário por vendedor</span>
            <input
              type="number"
              min={1}
              max={50}
              value={workflow.dailyLimitPerSeller}
              disabled={!canEdit || saving}
              onChange={(event) => updateWorkflow({ dailyLimitPerSeller: Number(event.target.value) || 0 })}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            />
            <span className="block text-xs text-slate-500">Contado no dia de Brasília; os de compra mais recente entram primeiro.</span>
          </label>

          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Prazo do contato em dias úteis</span>
            <select
              value={workflow.returnDeadlineBusinessDays}
              disabled={!canEdit || saving}
              onChange={(event) => updateWorkflow({ returnDeadlineBusinessDays: Number(event.target.value) })}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              {![1, 2].includes(workflow.returnDeadlineBusinessDays) && (
                <option value={workflow.returnDeadlineBusinessDays}>{workflow.returnDeadlineBusinessDays} dias úteis (inválido)</option>
              )}
              <option value={1}>1 dia útil</option>
              <option value={2}>2 dias úteis</option>
            </select>
          </label>

          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Etapa inicial</span>
            <select
              value={workflow.initialOpportunityStage}
              disabled={!canEdit || saving}
              onChange={(event) => updateWorkflow({ initialOpportunityStage: event.target.value as typeof workflow.initialOpportunityStage })}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              {!stageIsValid && <option value={workflow.initialOpportunityStage}>{workflow.initialOpportunityStage} (inválida)</option>}
              {OPPORTUNITY_STAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 lg:col-span-2">
            <p className="text-sm font-medium text-slate-700">Ações para cada inativo recente</p>
            {[
              ["createOpportunity", "Criar oportunidade “Reativação – <cliente>” com valor zero"],
              ["createActivity", "Criar ligação para o vendedor responsável"],
              ["createTimelineEvent", "Criar evento na linha do tempo"]
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={Boolean(workflow[key as keyof typeof workflow])}
                  disabled={!canEdit || saving}
                  onChange={(event) => updateWorkflow({ [key]: event.target.checked })}
                  className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand-700 focus:ring-brand-600 disabled:cursor-not-allowed"
                />
                {label}
              </label>
            ))}
          </div>

          {canEdit ? (
            <div className="space-y-2 lg:col-span-2">
              {saveError && <p className="text-sm text-red-700">{saveError}</p>}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !canSave}
                className="inline-flex w-fit items-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Salvando..." : "Salvar automações"}
              </button>
            </div>
          ) : (
            <p className="text-xs text-slate-500">Somente diretores podem alterar automações comerciais.</p>
          )}
        </div>
      )}
    </div>
  );
}
