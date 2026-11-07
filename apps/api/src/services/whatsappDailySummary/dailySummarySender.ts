import { Role, WhatsAppConnectionStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import type { CrmUserRecipient } from "../whatsappConnection/crmUserRecipient.js";
import { createEvolutionClient, EvolutionUnavailableError, type EvolutionClient, type EvolutionSendResult } from "../whatsappConnection/evolutionClient.js";

// WhatsApp Fase D: quem envia o resumo e o único ponto do sistema que chama o envio do EvolutionClient.
// Remetente: diretor ou gerente ativo, com o número CONNECTED no CRM e a instância "open" no Evolution na
// hora. Sem isso, nada é enviado. Nada aqui grava log.

export const DAILY_SUMMARY_SENDER_ROLES: readonly Role[] = [Role.diretor, Role.gerente];

export type DailySummarySenderCode = "sender_not_configured" | "sender_not_allowed" | "sender_not_connected" | "evolution_unavailable";
export type DailySummarySenderCheck = { ok: true; userId: string; instanceName: string } | { ok: false; code: DailySummarySenderCode };

export const DAILY_SUMMARY_SENDER_MESSAGES: Record<DailySummarySenderCode, string> = {
  sender_not_configured: "Escolha o remetente (diretor ou gerente com o WhatsApp conectado).",
  sender_not_allowed: "O remetente precisa ser diretor ou gerente ativo.",
  sender_not_connected: "O WhatsApp do remetente não está conectado. Nada foi enviado: reconecte o número em Configurações.",
  evolution_unavailable: "Serviço de WhatsApp indisponível no momento. Nada foi enviado."
};

type SenderDb = Pick<typeof defaultPrisma, "user" | "whatsAppConnection">;
type StateClient = Pick<EvolutionClient, "connectionState">;

export async function checkDailySummarySender(
  senderUserId: string | null,
  db: SenderDb = defaultPrisma,
  client: StateClient = createEvolutionClient()
): Promise<DailySummarySenderCheck> {
  if (!senderUserId) return { ok: false, code: "sender_not_configured" };
  const user = await db.user.findUnique({ where: { id: senderUserId }, select: { id: true, role: true, isActive: true } });
  if (!user || !user.isActive || !DAILY_SUMMARY_SENDER_ROLES.includes(user.role)) return { ok: false, code: "sender_not_allowed" };
  const connection = await db.whatsAppConnection.findUnique({ where: { userId: user.id }, select: { instanceName: true, status: true, connectedPhone: true } });
  if (!connection || connection.status !== WhatsAppConnectionStatus.CONNECTED || !connection.connectedPhone) return { ok: false, code: "sender_not_connected" };
  try {
    const state = await client.connectionState(connection.instanceName);
    if (state !== "open") return { ok: false, code: "sender_not_connected" };
  } catch (error) {
    if (error instanceof EvolutionUnavailableError) return { ok: false, code: "evolution_unavailable" };
    throw error;
  }
  return { ok: true, userId: user.id, instanceName: connection.instanceName };
}

type SendClient = Pick<EvolutionClient, "sendTextToCrmUser">;

/**
 * Único chamador de EvolutionClient.sendTextToCrmUser (um teste estático garante). Erro inesperado vira
 * "incerto": nunca se repete um envio que pode ter saído.
 */
export async function sendDailySummaryText(
  instanceName: string,
  recipient: CrmUserRecipient,
  text: string,
  client: SendClient = createEvolutionClient()
): Promise<EvolutionSendResult> {
  try {
    return await client.sendTextToCrmUser(instanceName, recipient, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "whatsapp_recipient_not_crm_user" || message === "whatsapp_text_invalid") return { kind: "not_sent", code: message, retryable: false };
    return { kind: "uncertain", code: "unexpected_error" };
  }
}
