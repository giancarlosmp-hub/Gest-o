import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG,
  WHATSAPP_DAILY_SUMMARY_TIPS_MODEL_LABELS,
  WHATSAPP_DAILY_SUMMARY_TIPS_MODELS,
  type WhatsAppDailySummaryConfig,
  type WhatsAppDailySummaryTipsModel,
  type WhatsAppDailySummaryRunState,
  type WhatsAppDailySummarySections,
  type WhatsAppDailySummarySellerDay,
  type WhatsAppDailySummaryTipsStatus
} from "@salesforce-pro/shared";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";

// WhatsApp Fase D: resumo diário da carteira no WhatsApp de cada vendedor, enviado pelo número de um diretor
// ou gerente. Diretor edita; gerente vê, faz prévia e envia teste para si. Opcional: dicas do gerente comercial
// escritas pela IA (desligadas por padrão); a prévia mostra as dicas e a situação delas.

type Props = { canEdit: boolean };

type Recipient = { ok: true } | { ok: false; reason: string; message: string };

type Overview = {
  whatsappEnabled: boolean;
  crmLinkConfigured: boolean;
  config: WhatsAppDailySummaryConfig;
  senders: Array<{ userId: string; name: string; role: string; connected: boolean }>;
  senderStatus: { ok: true } | { ok: false; code: string; message: string };
  today: { dayKey: string; isBusinessDay: boolean; run: WhatsAppDailySummaryRunState | null };
  lastRun: WhatsAppDailySummaryRunState | null;
  sellers: Array<{ userId: string; name: string; recipient: Recipient; today: WhatsAppDailySummarySellerDay | null }>;
};

type TipsView = { status: WhatsAppDailySummaryTipsStatus; message: string };
type Preview = { text: string | null; empty: boolean; recipient: Recipient; tips?: TipsView };
type TestResult = { result: "sent" | "not_sent" | "uncertain"; code: string | null };

const SECTION_LABELS: Array<[keyof WhatsAppDailySummarySections, string]> = [
  ["reactivations", "Reativações abertas (as das últimas 24 h destacadas)"],
  ["newOpportunities", "Oportunidades lançadas nas últimas 24 h"],
  ["overdueFollowUps", "Follow-ups vencidos"],
  ["todayFollowUps", "Follow-ups de hoje"]
];

const formatDayKey = (dayKey: string) => dayKey.split("-").reverse().slice(0, 2).join("/");

const dayStatusLabel = (day: WhatsAppDailySummarySellerDay | null, recipient: Recipient) => {
  if (!day) return recipient.ok ? { text: "Aguardando", tone: "text-slate-500" } : { text: recipient.message, tone: "text-red-700" };
  switch (day.status) {
    case "sent":
      return { text: "Enviado", tone: "text-emerald-700" };
    case "sending":
    case "uncertain":
      return { text: `Incerto, pode ter saído${day.code ? ` (${day.code})` : ""}`, tone: "text-amber-700" };
    case "failed":
      return { text: `Não enviado${day.code ? ` (${day.code})` : ""}`, tone: "text-red-700" };
    case "empty":
      return { text: "Sem itens: não recebe mensagem", tone: "text-slate-500" };
    case "refused":
      return { text: recipient.ok ? `Destino recusado (${day.code})` : recipient.message, tone: "text-red-700" };
  }
};

const testResultMessage = (result: TestResult) => {
  if (result.result === "sent") return "Teste enviado para o seu WhatsApp. Confira se chegou.";
  if (result.result === "uncertain") return `O WhatsApp não confirmou o envio (código ${result.code}). Confira se a mensagem chegou.`;
  return `Não enviado (código ${result.code}).`;
};

export function ManagerTipsOption({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm lg:col-span-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-700 focus:ring-brand-600 disabled:cursor-not-allowed"
      />
      <span className="min-w-0">
        <span className="block font-medium text-slate-800">Dicas do gerente comercial (IA)</span>
        <span className="mt-1 block text-xs text-slate-500">
          Até 3 dicas curtas da IA no fim do resumo, assinadas “— Claude, gerente comercial”. A IA recebe só códigos e dados
          das oportunidades (etapa, dias, valor, cultura/produto, última compra e UF), nunca nome, telefone, documento ou
          cidade do cliente. Se a IA falhar, demorar ou a resposta não passar na conferência, o resumo sai sem as dicas.
        </span>
      </span>
    </label>
  );
}

/** Modelo da Groq para as dicas (só vale com a chave da Groq no servidor; sem ela, a IA do CRM). */
export function ManagerTipsModelSelect({ value, disabled, onChange }: { value: WhatsAppDailySummaryTipsModel; disabled: boolean; onChange: (model: WhatsAppDailySummaryTipsModel) => void }) {
  return (
    <label className="space-y-1 text-sm lg:col-span-2">
      <span className="font-medium text-slate-700">Modelo das dicas (Groq)</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as WhatsAppDailySummaryTipsModel)}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
      >
        {WHATSAPP_DAILY_SUMMARY_TIPS_MODELS.map((model) => (
          <option key={model} value={model}>
            {WHATSAPP_DAILY_SUMMARY_TIPS_MODEL_LABELS[model]}
          </option>
        ))}
      </select>
      <span className="block text-xs text-slate-500">
        Usado quando a chave da Groq está configurada no servidor. Sem ela, as dicas usam a IA atual do CRM.
      </span>
    </label>
  );
}

/** Situação das dicas na prévia (nada quando desligadas). */
export function TipsStatusNote({ tips }: { tips: TipsView | undefined }) {
  if (!tips || tips.status === "off") return null;
  return <p className={`text-xs ${tips.status === "ok" ? "text-emerald-700" : "text-amber-700"}`}>{tips.message}</p>;
}

export default function WhatsAppDailySummaryPanel({ canEdit }: Props) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [config, setConfig] = useState<WhatsAppDailySummaryConfig>(DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sellerId, setSellerId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [testMessage, setTestMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .get<Overview>("/whatsapp/daily-summary")
      .then((response) => {
        setOverview(response.data);
        setConfig(response.data.config);
        setSellerId((current) => current || response.data.sellers[0]?.userId || "");
      })
      .catch((error) => setLoadError(getApiErrorMessage(error, "Não foi possível carregar o resumo diário.")));
  }, []);

  useEffect(load, [load]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.put<WhatsAppDailySummaryConfig>("/whatsapp/daily-summary/config", config);
      load();
    } catch (error) {
      setSaveError(getApiErrorMessage(error, "Não foi possível salvar o resumo diário."));
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    if (!sellerId) return;
    setPreviewLoading(true);
    setPreview(null);
    try {
      const response = await api.post<Preview>("/whatsapp/daily-summary/preview", { sellerId });
      setPreview(response.data);
    } catch (error) {
      setPreview({ text: null, empty: true, recipient: { ok: false, reason: "error", message: getApiErrorMessage(error, "Não foi possível montar a prévia.") } });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleTestSend = async () => {
    if (!sellerId) return;
    setTesting(true);
    setTestMessage(null);
    try {
      const response = await api.post<TestResult>("/whatsapp/daily-summary/test-send", { sellerId });
      setTestMessage({ text: testResultMessage(response.data), error: response.data.result !== "sent" });
    } catch (error) {
      setTestMessage({ text: getApiErrorMessage(error, "Não foi possível enviar o teste."), error: true });
    } finally {
      setTesting(false);
    }
  };

  const run = overview?.today.run ?? null;
  const editable = canEdit && !saving;

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Resumo diário no WhatsApp</h3>
        <p className="mt-1 text-xs text-slate-600">
          Nos dias úteis, cada vendedor recebe no WhatsApp comercial dele um resumo da carteira: reativações, oportunidades
          novas e follow-ups. Sai do número do remetente escolhido e só vai para o celular cadastrado de usuários ativos do
          CRM, nunca para clientes. Vendedor sem itens não recebe mensagem.
        </p>
      </div>

      {loadError ? (
        <p className="mt-4 text-sm text-red-700">{loadError}</p>
      ) : !overview ? (
        <p className="mt-4 text-sm text-slate-500">Carregando configuração...</p>
      ) : (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {!overview.whatsappEnabled && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 lg:col-span-2">
              A integração de WhatsApp está desligada: nada é enviado.
            </p>
          )}
          {overview.whatsappEnabled && overview.config.enabled && !overview.senderStatus.ok && (
            <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 lg:col-span-2">{overview.senderStatus.message}</p>
          )}
          {run?.state === "sender_unavailable" && (
            <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 lg:col-span-2">
              Hoje ({formatDayKey(run.dayKey)}) o resumo não foi enviado: o WhatsApp do remetente estava indisponível ({run.code}).
              Reconecte o número; os envios pendentes saem até 3 horas depois do horário.
            </p>
          )}
          {!overview.crmLinkConfigured && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 lg:col-span-2">
              Endereço do CRM não configurado: as mensagens saem sem link.
            </p>
          )}

          <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm lg:col-span-2">
            <input
              type="checkbox"
              checked={config.enabled}
              disabled={!editable}
              onChange={(event) => setConfig((current) => ({ ...current, enabled: event.target.checked }))}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600 disabled:cursor-not-allowed"
            />
            <span>
              <span className="block font-medium text-slate-800">Enviar o resumo diário</span>
              <span className="mt-1 block text-xs text-slate-500">
                {config.enabled ? "Ligado: envia nos dias úteis, no horário abaixo." : "Desligado: nada é enviado. Use a prévia e o teste antes de ligar."}
              </span>
            </span>
          </label>

          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Horário (Brasília)</span>
            <input
              type="time"
              value={config.sendTime}
              disabled={!editable}
              onChange={(event) => setConfig((current) => ({ ...current, sendTime: event.target.value }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            />
            <span className="block text-xs text-slate-500">Segunda a sexta. Envios com intervalo de alguns segundos entre vendedores.</span>
          </label>

          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Remetente</span>
            <select
              value={config.senderUserId ?? ""}
              disabled={!editable}
              onChange={(event) => setConfig((current) => ({ ...current, senderUserId: event.target.value || null }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              <option value="">Escolha um diretor ou gerente</option>
              {overview.senders.map((sender) => (
                <option key={sender.userId} value={sender.userId}>
                  {sender.name} ({sender.connected ? "WhatsApp conectado" : "WhatsApp não conectado"})
                </option>
              ))}
            </select>
            <span className="block text-xs text-slate-500">Envia pelo número comercial conectado dessa pessoa.</span>
          </label>

          <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 lg:col-span-2">
            <p className="text-sm font-medium text-slate-700">Seções do resumo</p>
            {SECTION_LABELS.map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={config.sections[key]}
                  disabled={!editable}
                  onChange={(event) => setConfig((current) => ({ ...current, sections: { ...current.sections, [key]: event.target.checked } }))}
                  className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand-700 focus:ring-brand-600 disabled:cursor-not-allowed"
                />
                {label}
              </label>
            ))}
            <p className="text-xs text-slate-500">Até 10 itens por seção, com “+N no CRM” e o link do CRM.</p>
          </div>

          <ManagerTipsOption
            checked={config.managerTips}
            disabled={!editable}
            onChange={(checked) => setConfig((current) => ({ ...current, managerTips: checked }))}
          />
          {config.managerTips && (
            <ManagerTipsModelSelect
              value={config.managerTipsModel}
              disabled={!editable}
              onChange={(model) => setConfig((current) => ({ ...current, managerTipsModel: model }))}
            />
          )}

          {canEdit ? (
            <div className="space-y-2 lg:col-span-2">
              {saveError && <p className="text-sm text-red-700">{saveError}</p>}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="inline-flex w-fit items-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Salvando..." : "Salvar resumo diário"}
              </button>
            </div>
          ) : (
            <p className="text-xs text-slate-500 lg:col-span-2">Somente diretores podem alterar o resumo diário.</p>
          )}

          <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 text-sm lg:col-span-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium text-slate-700">Hoje ({formatDayKey(overview.today.dayKey)})</p>
              {run && (
                <span className="text-xs text-slate-500">
                  Enviados {run.counts.sent} · Incertos {run.counts.uncertain + run.counts.sending} · Não enviados {run.counts.failed} · Sem itens{" "}
                  {run.counts.empty} · Recusados {run.counts.refused}
                </span>
              )}
            </div>
            {!overview.today.isBusinessDay && <p className="text-xs text-slate-500">Fim de semana: sem envio.</p>}
            {run?.state === "window_closed" && <p className="text-xs text-slate-500">A janela de envio de hoje terminou.</p>}
            {overview.sellers.length === 0 ? (
              <p className="text-xs text-slate-500">Nenhum vendedor ativo.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {overview.sellers.map((seller) => {
                  const status = dayStatusLabel(seller.today, seller.recipient);
                  return (
                    <li key={seller.userId} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5">
                      <span className="min-w-0 break-words text-slate-800">{seller.name}</span>
                      <span className={`min-w-0 break-words text-xs ${status.tone}`}>{status.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 text-sm lg:col-span-2">
            <p className="font-medium text-slate-700">Prévia e teste</p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={sellerId}
                onChange={(event) => {
                  setSellerId(event.target.value);
                  setPreview(null);
                  setTestMessage(null);
                }}
                className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2"
              >
                {overview.sellers.map((seller) => (
                  <option key={seller.userId} value={seller.userId}>
                    {seller.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handlePreview}
                disabled={!sellerId || previewLoading}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {previewLoading ? "Montando..." : "Ver prévia"}
              </button>
              <button
                type="button"
                onClick={handleTestSend}
                disabled={!sellerId || testing || !overview.whatsappEnabled}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {testing ? "Enviando..." : "Enviar teste para mim"}
              </button>
            </div>
            <p className="text-xs text-slate-500">
              A prévia não envia nada. O teste manda o resumo do vendedor escolhido para o seu próprio WhatsApp, pelo remetente
              configurado (salve antes de testar). Com as dicas ligadas, a prévia e o teste também chamam a IA.
            </p>
            {testMessage && <p className={`text-xs ${testMessage.error ? "text-red-700" : "text-emerald-700"}`}>{testMessage.text}</p>}
            {preview && (
              <div className="space-y-2">
                {!preview.recipient.ok && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">{preview.recipient.message}</p>}
                <TipsStatusNote tips={preview.tips} />
                {preview.text ? (
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-50 p-3 font-sans text-xs text-slate-800">{preview.text}</pre>
                ) : preview.recipient.ok || preview.empty ? (
                  <p className="text-xs text-slate-500">Nada a enviar para este vendedor hoje: ele não recebe mensagem.</p>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
