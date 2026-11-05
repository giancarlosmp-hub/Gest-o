import { MessageCircle, Phone } from "lucide-react";

// Telefones e e-mails cadastrais do parceiro no ERP (GET /clients/:id → erpPhones/erpEmails). Contatos manuais
// do CRM ficam na aba Contatos, separados. Fixo também ganha WhatsApp (WhatsApp Business), como botão secundário.

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
};

const buttonBase = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold";

export default function ClientErpPhones({ phones, emails, className = "" }: Props) {
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
                <a
                  href={phone.whatsapp}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${buttonBase} ${phone.kind === "mobile" ? "bg-emerald-600 text-white hover:bg-emerald-700" : "border border-emerald-300 text-emerald-700 hover:bg-emerald-50"}`}
                >
                  <MessageCircle size={16} aria-hidden="true" />
                  WhatsApp
                </a>
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
