import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, CircleDot, QrCode, Smartphone, Unplug } from "lucide-react";
import api from "../../lib/apiClient";
import {
  WHATSAPP_STATUS_LABELS,
  whatsappCanDisconnect,
  whatsappReasonLabel,
  type OwnWhatsAppConnection
} from "../../lib/whatsappConnection";
import { formatBrazilDayMonth, type WhatsAppMessagesSummary } from "../../lib/whatsappMessages";
import { UNLINKED_SECTION_ID } from "./UnlinkedConversationsCard";

// "Meu número": cada usuário conecta o número comercial de WhatsApp ao CRM lendo um QR (Fase A). Com o número
// conectado, mostra se a gravação das conversas (Fase B) está ligada e desde quando, com o aviso de que as
// conversas ficam registradas, e o contador da fila "Conversas não vinculadas". Nada é enviado por aqui.

const POLL_INTERVAL_MS = 5_000;

const apiMessage = (error: unknown, fallback: string) =>
  ((error as { response?: { data?: { message?: unknown } } })?.response?.data?.message as string | undefined) || fallback;

type ViewProps = {
  connection: Extract<OwnWhatsAppConnection, { enabled: true }>;
  summary?: WhatsAppMessagesSummary | null;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
};

const statusTone: Record<string, string> = {
  CONNECTED: "bg-emerald-50 text-emerald-700",
  PENDING_QR: "bg-sky-50 text-sky-700",
  REJECTED_WRONG_NUMBER: "bg-rose-50 text-rose-700",
  ERROR: "bg-rose-50 text-rose-700"
};

/** Parte visual, sem rede: usada pelo cartão e pelos testes. */
function RecordingStatus({ summary, connected }: { summary: WhatsAppMessagesSummary; connected: boolean }) {
  const since = formatBrazilDayMonth(summary.recording.since);
  const count = summary.unlinkedCount;
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" data-whatsapp-recording={summary.recording.enabled ? "on" : "off"}>
      {connected ? (
        <p className={`flex items-center gap-2 font-semibold ${summary.recording.enabled ? "text-emerald-700" : "text-slate-600"}`}>
          <CircleDot size={14} aria-hidden="true" />
          Gravação das conversas {summary.recording.enabled ? "ligada" : "desligada"}
          {since ? ` desde ${since}` : ""}
        </p>
      ) : null}
      {connected && summary.recording.enabled ? (
        <p className="text-slate-700">
          As conversas deste número (enviadas pelo app do celular e recebidas) ficam registradas no CRM, na linha do tempo do cliente.
        </p>
      ) : null}
      <p className="text-slate-700">
        {count ? (
          <a href={`#${UNLINKED_SECTION_ID}`} className="font-semibold text-emerald-700 underline-offset-2 hover:underline">
            {count === 1 ? "1 conversa não vinculada" : `${count} conversas não vinculadas`}
          </a>
        ) : (
          "Nenhuma conversa aguardando vínculo."
        )}
      </p>
    </div>
  );
}

export function MyWhatsAppNumberView({ connection, summary, busy, onConnect, onDisconnect }: ViewProps) {
  const { status } = connection;
  const reason = whatsappReasonLabel(connection.statusReason);
  const canConnect = connection.phoneConfigured && connection.configured && status !== "CONNECTED" && status !== "PENDING_QR";

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-labelledby="my-whatsapp-number-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="my-whatsapp-number-title" className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <Smartphone size={18} aria-hidden="true" /> Meu número
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Conecte o WhatsApp comercial cadastrado no seu usuário
            {connection.expectedPhone ? <> (<span className="font-semibold text-slate-800">{connection.expectedPhone}</span>)</> : null}.
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone[status] ?? "bg-slate-100 text-slate-600"}`} data-whatsapp-status={status}>
          {WHATSAPP_STATUS_LABELS[status]}
        </span>
      </div>

      {!connection.phoneConfigured ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Seu usuário ainda não tem celular cadastrado. Peça à gestão para cadastrar em Configurações → Usuários.
        </p>
      ) : null}
      {!connection.configured ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">A conexão de WhatsApp ainda não foi configurada no servidor.</p>
      ) : null}
      {!connection.serviceAvailable ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          O serviço de WhatsApp está indisponível agora. O restante do CRM continua funcionando.
        </p>
      ) : null}
      {reason ? <p className="mt-3 text-sm text-slate-700">{reason}</p> : null}

      {status === "CONNECTED" ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700">
          <CheckCircle2 size={16} aria-hidden="true" /> Conectado com {connection.connectedPhone}.
        </p>
      ) : null}

      {summary && (status === "CONNECTED" || summary.unlinkedCount > 0) ? <RecordingStatus summary={summary} connected={status === "CONNECTED"} /> : null}

      {status === "PENDING_QR" ? (
        <div className="mt-4 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          {connection.qrDataUrl ? (
            <img src={connection.qrDataUrl} alt="QR code para conectar o WhatsApp" width={224} height={224} className="h-56 w-56 rounded-lg border border-slate-200 bg-white p-2" />
          ) : (
            <div className="flex h-56 w-56 items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-500">
              <QrCode size={20} className="mr-2" aria-hidden="true" /> Gerando QR...
            </div>
          )}
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
            <li>No celular {connection.expectedPhone ?? "cadastrado"}, abra o WhatsApp.</li>
            <li>Toque em Aparelhos conectados → Conectar um aparelho.</li>
            <li>Aponte a câmera para este QR. Ele se atualiza sozinho.</li>
            <li>Só o número cadastrado é aceito; outro número é desconectado na hora.</li>
          </ol>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {canConnect ? (
          <button type="button" onClick={onConnect} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60">
            <QrCode size={16} aria-hidden="true" /> {busy ? "Gerando QR..." : "Conectar meu WhatsApp"}
          </button>
        ) : null}
        {whatsappCanDisconnect(status) ? (
          <button type="button" onClick={onDisconnect} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
            <Unplug size={16} aria-hidden="true" /> {status === "PENDING_QR" ? "Cancelar" : "Desconectar"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** Cartão completo: busca o status, atualiza o QR a cada 5 s enquanto aguarda e some com a flag desligada. */
export default function MyWhatsAppNumberCard({ queueVersion = 0 }: { queueVersion?: number }) {
  const [connection, setConnection] = useState<OwnWhatsAppConnection | null>(null);
  const [summary, setSummary] = useState<WhatsAppMessagesSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await api.get<OwnWhatsAppConnection>("/whatsapp/connection");
      setConnection(response.data);
    } catch {
      // Falha ao consultar não derruba a página: o cartão mantém o último estado.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Gravação e fila: relido ao mudar o status do número e quando a fila muda (vincular/descartar).
  const enabled = connection?.enabled === true;
  const connectionStatus = connection?.enabled === true ? connection.status : null;
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    api
      .get<WhatsAppMessagesSummary>("/whatsapp/messages/summary")
      .then((response) => active && setSummary(response.data))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [enabled, connectionStatus, queueVersion]);

  const waiting = connection?.enabled === true && connection.status === "PENDING_QR";
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, refresh]);

  if (!connection || !connection.enabled) return null;

  const connect = async () => {
    setBusy(true);
    try {
      const response = await api.post<OwnWhatsAppConnection>("/whatsapp/connection");
      setConnection(response.data);
    } catch (error) {
      toast.error(apiMessage(error, "Não foi possível gerar o QR agora."));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      const response = await api.delete<OwnWhatsAppConnection>("/whatsapp/connection");
      setConnection(response.data);
      toast.success("WhatsApp desconectado.");
    } catch (error) {
      toast.error(apiMessage(error, "Não foi possível desconectar agora."));
    } finally {
      setBusy(false);
    }
  };

  return <MyWhatsAppNumberView connection={connection} summary={summary} busy={busy} onConnect={connect} onDisconnect={disconnect} />;
}
