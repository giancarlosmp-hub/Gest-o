import { z } from "zod";

// WhatsApp Fase D: resumo diário da carteira enviado ao WhatsApp comercial de cada vendedor, a partir do
// número conectado de um diretor ou gerente. Só vai para o celular (User.phone) de usuário ativo do CRM.

export const whatsappDailySummarySectionsSchema = z
  .object({
    reactivations: z.boolean(),
    newOpportunities: z.boolean(),
    overdueFollowUps: z.boolean(),
    todayFollowUps: z.boolean()
  })
  .strict();

export const whatsappDailySummaryConfigSchema = z
  .object({
    enabled: z.boolean(),
    // Horário de Brasília (HH:MM), dias úteis.
    sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário inválido (use HH:MM)."),
    senderUserId: z.string().trim().min(1).max(64).nullable(),
    sections: whatsappDailySummarySectionsSchema
  })
  .strict();

export type WhatsAppDailySummarySections = z.infer<typeof whatsappDailySummarySectionsSchema>;
export type WhatsAppDailySummaryConfig = z.infer<typeof whatsappDailySummaryConfigSchema>;

export const DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG: WhatsAppDailySummaryConfig = {
  enabled: false,
  sendTime: "07:30",
  senderUserId: null,
  sections: { reactivations: true, newOpportunities: true, overdueFollowUps: true, todayFollowUps: true }
};

/** Corpo da prévia e do "Enviar teste para mim": de qual vendedor é o resumo. */
export const whatsappDailySummarySellerSchema = z.object({ sellerId: z.string().trim().min(1).max(64) }).strict();

export const WHATSAPP_DAILY_SUMMARY_MAX_ITEMS_PER_SECTION = 10;

/** Por que um usuário não pode receber mensagem do CRM (destino recusado na hora do envio). */
export const WHATSAPP_CRM_RECIPIENT_REFUSALS = ["user_not_found", "user_inactive", "no_phone", "invalid_phone", "phone_matches_client"] as const;
export type WhatsAppCrmRecipientRefusal = (typeof WHATSAPP_CRM_RECIPIENT_REFUSALS)[number];

export const WHATSAPP_CRM_RECIPIENT_REFUSAL_MESSAGES: Record<WhatsAppCrmRecipientRefusal, string> = {
  user_not_found: "Usuário não encontrado.",
  user_inactive: "Usuário inativo.",
  no_phone: "Usuário sem celular cadastrado.",
  invalid_phone: "O celular cadastrado não é um celular brasileiro válido.",
  phone_matches_client: "O celular deste usuário também está cadastrado em cliente(s) – corrija o cadastro."
};

/**
 * Situação de um vendedor no dia:
 * - sending: o envio começou e não terminou (a API reiniciou no meio) — tratado como incerto, sem repetir;
 * - sent: o Evolution aceitou a mensagem;
 * - uncertain: resposta desconhecida, timeout ou erro do servidor — pode ter saído, não repete;
 * - failed: certeza de que não saiu (code diz o motivo; só "connection_refused" tenta de novo);
 * - empty: nada a enviar; refused: destino recusado (code = WhatsAppCrmRecipientRefusal).
 */
export const WHATSAPP_DAILY_SUMMARY_SELLER_STATUSES = ["sending", "sent", "uncertain", "failed", "empty", "refused"] as const;
export type WhatsAppDailySummarySellerStatus = (typeof WHATSAPP_DAILY_SUMMARY_SELLER_STATUSES)[number];

export type WhatsAppDailySummarySellerDay = {
  status: WhatsAppDailySummarySellerStatus;
  code: string | null;
  attempts: number;
  at: string;
};

/**
 * Situação do dia: aguardando o horário, enviado (done), remetente indisponível (não enviou), janela encerrada
 * sem envio. Sem nomes nem números.
 */
export type WhatsAppDailySummaryRunState = {
  dayKey: string;
  state: "done" | "sender_unavailable" | "window_closed";
  code: string | null;
  at: string;
  counts: Record<WhatsAppDailySummarySellerStatus, number>;
};
