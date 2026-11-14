import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MessageCircle, Phone } from "lucide-react";
import api from "../../lib/apiClient";
import { conversationPath, findPhoneTarget, type ClientTargets, type InboxStatus } from "../../lib/whatsappInbox";

// Telefones e e-mails cadastrais do parceiro no ERP (GET /clients/:id → erpPhones/erpEmails). Contatos manuais
// do CRM ficam na aba Contatos, separados. Fixo também ganha WhatsApp (WhatsApp Business), como botão secundário.
// WhatsApp Fase C (C2): com o número do usuário conectado e o envio pelo CRM ligado, o botão "WhatsApp" abre a
// conversa no CRM (/whatsapp); sem isso, ou com o telefone fora do índice, continua o wa.me.

export type ClientErpPhone = {
  label: string;
  display: string;
  kind: "mobile" | "landline" | null;
  tel: string | null;
  whatsapp: string | null;
};

export type ClientErpEmail = { label: string; email: string };

type Props = {
  phones?: ClientErpPhone[] | null;
  emails?: ClientErpEmail[] | null;
  className?: string;
  /** Cliente dos telefones: com ele, o botão "WhatsApp" pode abrir a conversa no CRM. */
  clientId?: string | null;
};

type ViewProps = Omit<Props, "clientId"> & {
  /** Caminho da conversa no CRM para o telefone, ou null (wa.me). */
  crmPathFor?: (phone: ClientErpPhone) => string | null;
};

const buttonBase = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold";

/** Envio pelo CRM pronto para este usuário: os destinos do cliente; senão, null. Falha: null (wa.me). */
function useCrmPhoneTargets(clientId: string | null | undefined) {
  const [targets, setTargets] = useState<ClientTargets | null>(null);
  useEffect(() => {
    let active = true;
    setTargets(null);
    if (!clientId) return undefined;
    (async () => {
      try {
        const status = await api.get<InboxStatus>("/whatsapp/inbox/status");
        if (!active || !status.data.sendEnabled || !status.data.connected) return;
        const response = await api.get<ClientTargets>("/whatsapp/inbox/client-targets", { params: { clientId } });
        if (active && response.data.connected) setTargets(response.data);
      } catch {
        // Continua o wa.me.
      }
    })();
    return () => {
      active = false;
    };
  }, [clientId]);
  return targets;
}

export default function ClientErpPhones({ clientId, ...props }: Props) {
  const targets = useCrmPhoneTargets(clientId);
  const crmPathFor = (phone: ClientErpPhone) => {
    if (!clientId || !targets || !phone.whatsapp) return null;
    const target = findPhoneTarget(targets.phones, phone.display);
    return target ? conversationPath({ clientId, target }) : null;
  };
  return <ClientErpPhonesView {...props} crmPathFor={crmPathFor} />;
}

/** Parte visual, sem rede: usada pelo componente e pelos testes. */
export function ClientErpPhonesView({ phones, emails, className = "", crmPathFor }: ViewProps) {
  const phoneList = phones ?? [];
  const emailList = emails ?? [];

  return (
    <div className={`min-w-0 ${className}`}>
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-sm font-semibold text-slate-800">Telefones</h4>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">ERP</span>
      </div>
      {!phoneList.length && !emailList.length ? (
        <p className="text-sm text-slate-500">Sem telefone no cadastro do ERP.</p>
      ) : null}
      {phoneList.length ? (
        <ul className="space-y-2">
          {phoneList.map((phone, index) => (
            <li key={`${phone.display}-${index}`} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <div className="min-w-0 flex-1 basis-40">
                <p className="truncate text-xs text-slate-500">{phone.label}</p>
                <p className="break-words font-medium text-slate-900">{phone.display}</p>
              </div>
              {phone.tel ? (
                <a href={phone.tel} className={`${buttonBase} border border-slate-300 text-slate-700 hover:bg-slate-50`}>
                  <Phone size={16} aria-hidden="true" />
                  Ligar
                </a>
              ) : null}
              {phone.whatsapp ? (
                (() => {
                  const style = `${buttonBase} ${phone.kind === "mobile" ? "bg-emerald-600 text-white hover:bg-emerald-700" : "border border-emerald-300 text-emerald-700 hover:bg-emerald-50"}`;
                  const crmPath = crmPathFor?.(phone) ?? null;
                  return crmPath ? (
                    <Link to={crmPath} className={style} data-whatsapp-crm title="Abrir a conversa no CRM">
                      <MessageCircle size={16} aria-hidden="true" />
                      WhatsApp
                    </Link>
                  ) : (
                    <a href={phone.whatsapp} target="_blank" rel="noopener noreferrer" className={style}>
                      <MessageCircle size={16} aria-hidden="true" />
                      WhatsApp
                    </a>
                  );
                })()
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {emailList.length ? (
        <ul className="mt-3 space-y-1 text-sm">
          {emailList.map((email) => (
            <li key={email.email} className="min-w-0">
              <span className="text-xs text-slate-500">{email.label}: </span>
              <span className="break-all text-slate-900">{email.email}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
