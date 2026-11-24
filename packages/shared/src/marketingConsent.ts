import { z } from "zod";

// Campanhas WhatsApp Fase 1: aceite e descadastro dos boletins de marketing, por telefone. Só recebe
// campanha o telefone cujo registro mais recente é ACEITE (canReceiveMarketing na API).

export const MARKETING_CONSENT_STATUSES = ["ACEITE", "DESCADASTRO"] as const;
export type MarketingConsentStatusValue = (typeof MARKETING_CONSENT_STATUSES)[number];

export const MARKETING_CONSENT_SOURCES = ["VENDEDOR_MANUAL", "WHATSAPP_LINK", "WHATSAPP_BOTAO", "WHATSAPP_PALAVRA", "OUTRO"] as const;
export type MarketingConsentSourceValue = (typeof MARKETING_CONSENT_SOURCES)[number];

export const MARKETING_CONSENT_STATUS_LABELS: Record<MarketingConsentStatusValue, string> = {
  ACEITE: "Aceite",
  DESCADASTRO: "Descadastro",
};

export const MARKETING_CONSENT_SOURCE_LABELS: Record<MarketingConsentSourceValue, string> = {
  VENDEDOR_MANUAL: "Vendedor (manual)",
  WHATSAPP_LINK: "Link de aceite no WhatsApp",
  WHATSAPP_BOTAO: "Botão no WhatsApp",
  WHATSAPP_PALAVRA: "Palavra no WhatsApp",
  OUTRO: "Outro",
};

export const MARKETING_CONSENT_NOTE_MAX = 280;

/** Registro manual: o telefone vai só como referência à linha do ClientPhoneIndex do cliente. */
export const marketingConsentRecordSchema = z
  .object({
    phoneRef: z.string().trim().min(1, "Telefone obrigatório.").max(64),
    status: z.enum(MARKETING_CONSENT_STATUSES, { errorMap: () => ({ message: "Situação inválida." }) }),
    source: z.enum(MARKETING_CONSENT_SOURCES, { errorMap: () => ({ message: "Origem inválida." }) }),
    note: z
      .string()
      .trim()
      .max(MARKETING_CONSENT_NOTE_MAX, `Observação com no máximo ${MARKETING_CONSENT_NOTE_MAX} caracteres.`)
      .optional()
      .transform((value) => (value ? value : undefined)),
  })
  .strict();
export type MarketingConsentRecordInput = z.infer<typeof marketingConsentRecordSchema>;

export const CLIENT_CULTURES_MAX = 50;

export const clientCulturesUpdateSchema = z
  .object({
    cultureIds: z.array(z.string().trim().min(1).max(64)).max(CLIENT_CULTURES_MAX, `No máximo ${CLIENT_CULTURES_MAX} culturas.`),
  })
  .strict();
export type ClientCulturesUpdateInput = z.infer<typeof clientCulturesUpdateSchema>;
