import { normalizeBrazilPhone, splitPhoneField, type BrazilPhoneKind } from "@salesforce-pro/shared";
import type { Client, PrismaClient } from "@prisma/client";
import { findPdfPartner, getStoredErpPartnerRows } from "./erpOrderPdfService.js";

// Telefones e e-mails cadastrais do parceiro no ERP, lidos do cache do /partners (erp.ultrafv3.partners) só
// para exibição. Nada é gravado em Contact. Só os campos abaixo saem da API: DATA_NASCIMENTO e o resto da
// linha do ERP nunca são devolvidos.

export type ClientErpPhone = {
  label: string;
  display: string;
  kind: BrazilPhoneKind | null;
  tel: string | null;
  whatsapp: string | null;
};

export type ClientErpEmail = { label: string; email: string };

export type ClientErpContacts = { erpPhones: ClientErpPhone[]; erpEmails: ClientErpEmail[] };

const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value).replace(/\s+/g, " ").trim() : "";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const contactLabel = (name: unknown, role?: unknown) => {
  const parts = [text(name), text(role)].filter(Boolean);
  if (!parts.length) return "Contato";
  return parts.length === 2 ? `Contato: ${parts[0]} (${parts[1]})` : `Contato: ${parts[0]}`;
};

// TELEFONE_CONTATO1 e EMAIL_CONTATO1 ↔ CONTATO; 2 ↔ CONTATO2; 3 ↔ CONTATO3.
const NUMBERED_CONTACTS = [
  { phone: "TELEFONE_CONTATO1", email: "EMAIL_CONTATO1", name: "CONTATO" },
  { phone: "TELEFONE_CONTATO2", email: "EMAIL_CONTATO2", name: "CONTATO2" },
  { phone: "TELEFONE_CONTATO3", email: "EMAIL_CONTATO3", name: "CONTATO3" }
] as const;

const EMAIL_SEPARATOR = /[\s;,\/|]+/;

const partnerContactSources = (partner: Record<string, unknown>) => {
  const phoneSources: { label: string; value: unknown }[] = [
    { label: "Principal", value: partner.TELEFONE },
    { label: "Celular", value: partner.CELULAR },
    ...NUMBERED_CONTACTS.map((entry) => ({ label: contactLabel(partner[entry.name]), value: partner[entry.phone] }))
  ];
  const emailSources: { label: string; value: unknown }[] = [
    { label: "Principal", value: partner.EMAIL },
    ...NUMBERED_CONTACTS.map((entry) => ({ label: contactLabel(partner[entry.name]), value: partner[entry.email] }))
  ];
  for (const contact of Array.isArray(partner.CONTATOS) ? partner.CONTATOS : []) {
    const record = asRecord(contact);
    if (!record) continue;
    const label = contactLabel(record.CONTATO, record.FUNCAO);
    phoneSources.push({ label, value: record.TELEFONE }, { label, value: record.CELULAR });
    emailSources.push({ label, value: record.EMAIL });
  }
  return { phoneSources, emailSources };
};

/** Telefones válidos do parceiro (mesmas fontes do cartão do cliente) em 55 + DDD + número, sem repetição. */
export const erpPartnerPhoneNumbers = (partner: Record<string, unknown> | null): string[] => {
  if (!partner) return [];
  const numbers = new Set<string>();
  for (const source of partnerContactSources(partner).phoneSources) {
    for (const raw of splitPhoneField(source.value)) {
      const phone = normalizeBrazilPhone(raw);
      if (phone.valid) numbers.add(phone.e164);
    }
  }
  return [...numbers];
};

export const buildClientErpContacts = (partner: Record<string, unknown> | null): ClientErpContacts => {
  if (!partner) return { erpPhones: [], erpEmails: [] };

  const { phoneSources, emailSources } = partnerContactSources(partner);

  // Duplicados entre campos: o primeiro rótulo vence (Principal, Celular, contatos numerados, lista CONTATOS).
  const erpPhones: ClientErpPhone[] = [];
  const seenPhones = new Set<string>();
  for (const source of phoneSources) {
    for (const raw of splitPhoneField(source.value)) {
      const phone = normalizeBrazilPhone(raw);
      const key = phone.valid ? phone.e164 : `texto:${phone.display.replace(/\D/g, "")}`;
      if (seenPhones.has(key)) continue;
      seenPhones.add(key);
      erpPhones.push({
        label: source.label,
        display: phone.display,
        kind: phone.valid ? phone.kind : null,
        tel: phone.tel,
        whatsapp: phone.whatsapp
      });
    }
  }

  const erpEmails: ClientErpEmail[] = [];
  const seenEmails = new Set<string>();
  for (const source of emailSources) {
    for (const email of text(source.value).split(EMAIL_SEPARATOR)) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
      const key = email.toLowerCase();
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);
      erpEmails.push({ label: source.label, email });
    }
  }

  return { erpPhones, erpEmails };
};

/** Mesma busca do PDF do pedido: código ERP do cliente e, sem ele, o documento. */
export const loadClientErpContacts = async (
  prisma: Pick<PrismaClient, "appConfig">,
  client: Pick<Client, "code" | "cnpj">
): Promise<ClientErpContacts> => {
  if (!text(client.code) && !text(client.cnpj)) return { erpPhones: [], erpEmails: [] };
  const partners = await getStoredErpPartnerRows(prisma);
  return buildClientErpContacts(findPdfPartner(partners, client));
};
