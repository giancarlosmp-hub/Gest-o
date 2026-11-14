import { useEffect, useState } from "react";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";
import type { InboxStatus } from "../../lib/whatsappInbox";

// WhatsApp Fase C (C2): liga/desliga o envio pelo CRM (AppConfig, PUT /whatsapp/inbox/send-config). Só o
// diretor edita; gerente vê. Os limites mostrados vêm da API.

type Props = { canEdit: boolean };

type ViewProps = {
  status: Pick<InboxStatus, "enabled" | "available" | "limits"> | null;
  canEdit: boolean;
  saving: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
};

/** Parte visual, sem rede: usada pelo painel e pelos testes. */
export function WhatsAppCrmSendPanelView({ status, canEdit, saving, error, onToggle }: ViewProps) {
  const limits = status?.limits;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4" data-crm-send-panel>
      <h3 className="text-sm font-semibold text-slate-900">Conversa pelo CRM no WhatsApp</h3>
      <p className="mt-1 text-xs text-slate-600">
        O vendedor responde e escreve aos clientes dentro do CRM, pelo próprio número comercial conectado, e tudo fica
        registrado na conversa. Só texto, um destino e uma mensagem por vez, sempre por ação do vendedor: nunca em lote ou
        automático.
      </p>
      {limits ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
          <li>Até {limits.perMinute} mensagens por minuto, com alguns segundos entre uma e outra.</li>
          <li>Até {limits.perDay} mensagens por dia por vendedor.</li>
          <li>Até {limits.firstContactsPerDay} primeiros contatos por dia (cliente que nunca escreveu para aquele número).</li>
          <li>Texto de até {limits.maxTextLength.toLocaleString("pt-BR")} caracteres.</li>
        </ul>
      ) : null}
      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
        Risco de bloqueio: o WhatsApp pode restringir ou banir um número que envia muitas mensagens a quem não o conhece ou
        recebe denúncias. Os limites reduzem o risco, mas não o eliminam. Prefira responder a quem escreveu e evite mensagens
        repetidas.
      </p>
      {status ? (
        <label className="mt-3 flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={!canEdit || saving}
            onChange={(event) => onToggle(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-700 focus:ring-brand-600 disabled:cursor-not-allowed"
          />
          <span>
            <span className="block font-medium text-slate-900">Envio pelo CRM {status.enabled ? "ligado" : "desligado"}</span>
            <span className="block text-xs text-slate-500">
              {canEdit ? "Vale para todos os usuários com o número conectado." : "Somente o diretor altera esta opção."}
            </span>
          </span>
        </label>
      ) : (
        <p className="mt-3 text-xs text-slate-500">Carregando...</p>
      )}
      {status && status.enabled && !status.available ? (
        <p className="mt-2 text-xs text-amber-700">Ligado, mas indisponível agora: a gravação das conversas ou o serviço de WhatsApp não está ativo.</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default function WhatsAppCrmSendPanel({ canEdit }: Props) {
  const [status, setStatus] = useState<InboxStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .get<InboxStatus>("/whatsapp/inbox/status")
      .then((response) => active && setStatus(response.data))
      .catch((loadError) => active && setError(getApiErrorMessage(loadError, "Não foi possível carregar a situação do envio pelo CRM.")));
    return () => {
      active = false;
    };
  }, []);

  const toggle = async (enabled: boolean) => {
    if (!canEdit || saving || !status) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.put<{ enabled: boolean }>("/whatsapp/inbox/send-config", { enabled });
      setStatus({ ...status, enabled: response.data.enabled, sendEnabled: status.available && response.data.enabled });
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, "Não foi possível salvar."));
    } finally {
      setSaving(false);
    }
  };

  return <WhatsAppCrmSendPanelView status={status} canEdit={canEdit} saving={saving} error={error} onToggle={(value) => void toggle(value)} />;
}
