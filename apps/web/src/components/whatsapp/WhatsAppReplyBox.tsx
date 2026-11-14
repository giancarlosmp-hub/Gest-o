import { useState } from "react";
import { Send, Sparkles } from "lucide-react";
import api from "../../lib/apiClient";
import { AI_REQUEST_TIMEOUT_MS } from "../../lib/aiRequest";
import type { WhatsAppMessageItem } from "../../lib/whatsappMessages";
import {
  CRM_SEND_TEXT_MAX,
  canSendText,
  inboxApiMessage,
  remainingChars,
  replyBlockedReason,
  sendOutcomeFromError,
  sendOutcomeFromResponse,
  type InboxStatus
} from "../../lib/whatsappInbox";
import type { ReplyRenderInput } from "./WhatsAppConversation";

// WhatsApp Fase C (C2): campo de resposta da conversa. Até 4.000 caracteres; "Gerar mensagem IA" só preenche o
// campo (o vendedor revisa); uma ação por vez; erro da API mostrado como veio. Incerto ("pode ter sido
// enviada"): o texto fica no campo e o aviso pede para conferir no celular antes de reenviar.

type ViewProps = {
  text: string;
  sending: boolean;
  generating: boolean;
  canGenerate: boolean;
  canSend: boolean;
  blockedReason: string | null;
  feedback: { tone: "error" | "warning"; message: string } | null;
  status: Pick<InboxStatus, "limits" | "today"> | null;
  onText: (value: string) => void;
  onGenerate: () => void;
  onSend: () => void;
};

/** Parte visual, sem rede: usada pelo campo e pelos testes. */
export function WhatsAppReplyBoxView({ text, sending, generating, canGenerate, canSend, blockedReason, feedback, status, onText, onGenerate, onSend }: ViewProps) {
  if (blockedReason) {
    return (
      <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600" data-inbox-reply-blocked>
        {blockedReason}
      </p>
    );
  }
  const max = status?.limits.maxTextLength ?? CRM_SEND_TEXT_MAX;
  const remaining = remainingChars(text, max);
  const busy = sending || generating;
  return (
    <div className="space-y-2" data-inbox-reply>
      <label htmlFor="whatsapp-crm-reply" className="sr-only">
        Mensagem
      </label>
      <textarea
        id="whatsapp-crm-reply"
        value={text}
        onChange={(event) => onText(event.target.value)}
        maxLength={max}
        disabled={sending}
        placeholder="Escreva a mensagem ou gere com a IA para revisar."
        className="min-h-28 w-full rounded-xl border border-slate-200 p-3 text-sm text-slate-700 outline-none focus:border-brand-500 disabled:bg-slate-50"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-xs ${remaining < 0 ? "font-semibold text-red-700" : "text-slate-500"}`} aria-live="polite">
          {remaining} caracteres restantes
        </span>
        <div className="flex flex-wrap gap-2">
          {canGenerate ? (
            <button
              type="button"
              onClick={onGenerate}
              disabled={busy}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              <Sparkles size={16} aria-hidden="true" /> {generating ? "Gerando..." : "Gerar mensagem IA"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend || busy}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Send size={16} aria-hidden="true" /> {sending ? "Enviando..." : "Enviar"}
          </button>
        </div>
      </div>
      {feedback ? (
        <p
          role="alert"
          className={`rounded-lg px-3 py-2 text-sm ${feedback.tone === "warning" ? "bg-amber-50 text-amber-800 ring-1 ring-amber-200" : "bg-red-50 text-red-700 ring-1 ring-red-200"}`}
          data-inbox-reply-feedback={feedback.tone}
        >
          {feedback.message}
        </p>
      ) : null}
      {status?.today ? (
        <p className="text-[11px] text-slate-500">
          Hoje: {status.today.total} de {status.limits.perDay} envios · {status.today.firstContacts} de {status.limits.firstContactsPerDay} primeiros contatos
        </p>
      ) : null}
    </div>
  );
}

type Props = ReplyRenderInput & { status: InboxStatus | null };

export default function WhatsAppReplyBox({ target, clientId, own, canReply, status, onSent }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [feedback, setFeedback] = useState<ViewProps["feedback"]>(null);

  const max = status?.limits.maxTextLength ?? CRM_SEND_TEXT_MAX;
  const blockedReason = replyBlockedReason({ status, own, canReply });

  const generate = async () => {
    if (!clientId || generating || sending) return;
    setGenerating(true);
    setFeedback(null);
    try {
      const response = await api.post<{ message?: string }>("/ai/assistant-whatsapp-message", { clientId }, { timeout: AI_REQUEST_TIMEOUT_MS });
      if (response.data?.message) setText(response.data.message.slice(0, max));
      else setFeedback({ tone: "error", message: "A IA não devolveu mensagem. Escreva a sua." });
    } catch (error) {
      setFeedback({ tone: "error", message: inboxApiMessage(error, "Não foi possível gerar a mensagem agora.") });
    } finally {
      setGenerating(false);
    }
  };

  const send = async () => {
    if (!canSendText({ status, canReply, text, sending, max }) || generating) return;
    setSending(true);
    setFeedback(null);
    let outcome;
    try {
      const response = await api.post("/whatsapp/inbox/send", { ...target, text });
      outcome = sendOutcomeFromResponse(response.data);
    } catch (error) {
      outcome = sendOutcomeFromError(error);
    }
    setSending(false);
    if (outcome.ok) {
      setText("");
      onSent(outcome.conversationId, outcome.message as WhatsAppMessageItem);
      return;
    }
    setFeedback({ tone: outcome.uncertain ? "warning" : "error", message: outcome.message });
  };

  return (
    <WhatsAppReplyBoxView
      text={text}
      sending={sending}
      generating={generating}
      canGenerate={Boolean(clientId)}
      canSend={canSendText({ status, canReply, text, sending, max })}
      blockedReason={blockedReason}
      feedback={feedback}
      status={status}
      onText={(value) => {
        setText(value);
        if (feedback?.tone === "error") setFeedback(null);
      }}
      onGenerate={() => void generate()}
      onSend={() => void send()}
    />
  );
}
