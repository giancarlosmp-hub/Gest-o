import { useEffect, useState } from "react";
import { toast } from "sonner";
import { COMMERCIAL_POLICY_ROLES, DEFAULT_COMMERCIAL_POLICY, commercialPolicySchema, type CommercialPolicy, type CommercialPolicyRole } from "@salesforce-pro/shared";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";
import AccessibleCheckbox from "../AccessibleCheckbox";

type Props = {
  canEdit: boolean;
};

const ROLE_LABELS: Record<CommercialPolicyRole, string> = { vendedor: "Vendedor", gerente: "Gerente", diretor: "Diretor" };

type Draft = { enabled: boolean; limits: Record<CommercialPolicyRole, string>; discountWarning: string };

const toDraft = (policy: CommercialPolicy): Draft => ({
  enabled: policy.enabled,
  limits: {
    vendedor: String(policy.maxDiscountPercent.vendedor).replace(".", ","),
    gerente: String(policy.maxDiscountPercent.gerente).replace(".", ","),
    diretor: String(policy.maxDiscountPercent.diretor).replace(".", ",")
  },
  discountWarning: policy.discountWarning
});

const parsePercent = (value: string) => {
  const normalized = value.trim().replace(",", ".");
  return normalized === "" ? Number.NaN : Number(normalized);
};

// Monta a política a partir do formulário e valida com o mesmo schema da API.
export const commercialPolicyFromDraft = (draft: Draft) => commercialPolicySchema.safeParse({
  enabled: draft.enabled,
  maxDiscountPercent: {
    vendedor: parsePercent(draft.limits.vendedor),
    gerente: parsePercent(draft.limits.gerente),
    diretor: parsePercent(draft.limits.diretor)
  },
  discountWarning: draft.discountWarning
});

export default function CommercialPolicyPanel({ canEdit }: Props) {
  const [draft, setDraft] = useState<Draft>(toDraft(DEFAULT_COMMERCIAL_POLICY));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<CommercialPolicy>("/settings/commercial-policy")
      .then((response) => setDraft(toDraft(response.data)))
      .catch(() => toast.error("Não foi possível carregar a política comercial."))
      .finally(() => setLoading(false));
  }, []);

  const parsed = commercialPolicyFromDraft(draft);
  const disabled = !canEdit || saving;

  const handleSave = async () => {
    if (!parsed.success) return;
    setSaving(true);
    try {
      const response = await api.put<CommercialPolicy>("/settings/commercial-policy", parsed.data);
      setDraft(toDraft(response.data));
      toast.success("Política comercial salva.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível salvar a política comercial."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <h3 className="text-sm font-semibold text-slate-900">Política Comercial</h3>
      <p className="mt-1 text-xs text-slate-600">
        O preço dos itens é sempre o do ERP (tabela de preço da oportunidade) e não pode ser alterado no CRM, para nenhum perfil.
        O desconto é só em % por item, até o limite do perfil de quem lança. Acima do limite, o item não é salvo.
      </p>
      <p className="mt-1 text-xs text-slate-500">
        O ERP também valida o próprio limite de desconto ("Limitar % desconto"). Se o limite do ERP for menor que o daqui, o pedido
        será recusado pelo ERP.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-slate-500">Carregando configuração...</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 sm:max-w-xl">
          <AccessibleCheckbox checked={draft.enabled} disabled={disabled} onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}>
            Limitar o desconto por perfil (desligado, o CRM não limita; o ERP continua validando)
          </AccessibleCheckbox>
          <div className="grid gap-3 sm:grid-cols-3">
            {COMMERCIAL_POLICY_ROLES.map((role) => (
              <label key={role} className="space-y-1 text-sm">
                <span className="font-medium text-slate-700">{ROLE_LABELS[role]} — desconto máximo (%)</span>
                <input
                  inputMode="decimal"
                  value={draft.limits[role]}
                  disabled={disabled || !draft.enabled}
                  onChange={(event) => setDraft((current) => ({ ...current, limits: { ...current.limits, [role]: event.target.value } }))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
                />
              </label>
            ))}
          </div>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Aviso mostrado ao dar desconto</span>
            <textarea
              rows={3}
              maxLength={500}
              value={draft.discountWarning}
              disabled={disabled}
              onChange={(event) => setDraft((current) => ({ ...current, discountWarning: event.target.value }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            />
          </label>
          {!parsed.success ? (
            <p className="text-xs font-medium text-amber-700">
              {parsed.error.issues[0]?.code === "invalid_type" ? "Informe os limites em %, entre 0 e 100." : parsed.error.issues[0]?.message}
            </p>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !parsed.success}
              className="inline-flex w-fit items-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Salvando..." : "Salvar política"}
            </button>
          ) : (
            <p className="text-xs text-slate-500">Somente o diretor pode alterar a política comercial.</p>
          )}
        </div>
      )}
    </div>
  );
}
