import { useEffect, useMemo, useState } from "react";
import type { CommercialAutomationsConfig } from "@salesforce-pro/shared";
import api from "../../lib/apiClient";

type Props = {
  canEdit: boolean;
};

const DEFAULT_CONFIG: CommercialAutomationsConfig = {
  inactiveClientWorkflow: {
    enabled: false,
    daysWithoutPurchase: 90,
    allowedOptions: [30, 60, 90],
    customDaysEnabled: true,
    returnDeadlineBusinessDays: 3,
    initialOpportunityStage: "follow_up",
    createOpportunity: true,
    createActivity: true,
    createTimelineEvent: true
  }
};

const OPPORTUNITY_STAGE_OPTIONS = [
  { value: "follow_up", label: "Follow-up" },
  { value: "prospeccao", label: "Prospecção" },
  { value: "negociacao", label: "Negociação" },
  { value: "proposta", label: "Proposta" }
];

export default function CommercialAutomationsPanel({ canEdit }: Props) {
  const [config, setConfig] = useState<CommercialAutomationsConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<CommercialAutomationsConfig>("/settings/commercial-automations")
      .then((response) => setConfig(response.data))
      .finally(() => setLoading(false));
  }, []);

  const workflow = config.inactiveClientWorkflow;
  const selectedPreset = workflow.allowedOptions.includes(workflow.daysWithoutPurchase)
    ? String(workflow.daysWithoutPurchase)
    : "custom";
  const customDaysValue = selectedPreset === "custom" ? workflow.daysWithoutPurchase : "";

  const canSave = useMemo(() => {
    return workflow.daysWithoutPurchase > 0 && workflow.returnDeadlineBusinessDays > 0 && workflow.initialOpportunityStage.trim().length > 0;
  }, [workflow.daysWithoutPurchase, workflow.initialOpportunityStage, workflow.returnDeadlineBusinessDays]);

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
    try {
      const response = await api.put<CommercialAutomationsConfig>("/settings/commercial-automations", config);
      setConfig(response.data);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Automações Comerciais</h3>
        <p className="mt-1 text-xs text-slate-600">
          Configure a base do fluxo de clientes inativos. Esta tela apenas salva parâmetros; nenhum scheduler ou criação automática é executado.
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
              <span className="block font-medium text-slate-800">Ativar automação de cliente inativo</span>
              <span className="mt-1 block text-xs text-slate-500">Mantém a configuração pronta, sem disparar ações automáticas nesta etapa.</span>
            </span>
          </label>

          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Dias sem compra</span>
            <select
              value={selectedPreset}
              disabled={!canEdit || saving}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "custom") return;
                updateWorkflow({ daysWithoutPurchase: Number(value) });
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              {workflow.allowedOptions.map((option) => (
                <option key={option} value={option}>{option} dias</option>
              ))}
              {workflow.customDaysEnabled && <option value="custom">Customizado</option>}
            </select>
          </label>

          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Campo customizado opcional</span>
            <input
              type="number"
              min={1}
              value={customDaysValue}
              disabled={!canEdit || saving || !workflow.customDaysEnabled}
              onChange={(event) => updateWorkflow({ daysWithoutPurchase: Number(event.target.value) || 1 })}
              placeholder="Ex.: 120"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Prazo de retorno em dias úteis</span>
            <input
              type="number"
              min={1}
              max={365}
              value={workflow.returnDeadlineBusinessDays}
              disabled={!canEdit || saving}
              onChange={(event) => updateWorkflow({ returnDeadlineBusinessDays: Number(event.target.value) || 1 })}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Etapa inicial</span>
            <select
              value={workflow.initialOpportunityStage}
              disabled={!canEdit || saving}
              onChange={(event) => updateWorkflow({ initialOpportunityStage: event.target.value })}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              {OPPORTUNITY_STAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 lg:col-span-2">
            <p className="text-sm font-medium text-slate-700">Ações configuradas para criação futura</p>
            {[
              ["createOpportunity", "Criar oportunidade"],
              ["createActivity", "Criar atividade"],
              ["createTimelineEvent", "Criar evento na linha do tempo"]
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={Boolean(workflow[key as keyof typeof workflow])}
                  disabled={!canEdit || saving}
                  onChange={(event) => updateWorkflow({ [key]: event.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600 disabled:cursor-not-allowed"
                />
                {label}
              </label>
            ))}
          </div>

          {canEdit ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !canSave}
              className="inline-flex w-fit items-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Salvando..." : "Salvar automações"}
            </button>
          ) : (
            <p className="text-xs text-slate-500">Somente diretores podem alterar automações comerciais.</p>
          )}
        </div>
      )}
    </div>
  );
}
