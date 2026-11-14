import { OpportunityStage, type PrismaClient } from "@prisma/client";

// WhatsApp como contato com o cliente (decisões de 14/11/2026):
// - Conta só mensagem ENVIADA (pelo CRM ou pelo app do celular), de qualquer número da empresa, mesmo se for
//   apagada depois. Mensagem só recebida não conta. A mensagem não cria Activity.
// - Grava em Opportunity.lastContactAt de TODAS as oportunidades abertas do cliente, nunca para trás.
// - Uma vez por conversa por dia de Brasília: grava só a primeira mensagem enviada do dia (fica a hora dela).
//   As regras que leem o último contato contam em dias de Brasília, e Opportunity não tem índice em clientId.
// - Conversa vinculada depois (fila, vínculo automático tardio, envio pelo CRM corrigindo o vínculo): grava a
//   última mensagem enviada da conversa na hora do vínculo.
// O cliente e os resumos leem a última enviada direto das conversas (clientWhatsAppContact.ts).

const BRAZIL_UTC_OFFSET_MS = 3 * 3_600_000;

/** Dia de Brasília (AAAA-MM-DD); Brasília está em UTC-3 fixo. */
export const brazilDayKeyOf = (instant: Date) => new Date(instant.getTime() - BRAZIL_UTC_OFFSET_MS).toISOString().slice(0, 10);

const later = (a: Date | null, b: Date) => (a && a.getTime() > b.getTime() ? a : b);

/**
 * A data que vai para o último contato das oportunidades do cliente, ou null quando nada deve ser gravado.
 * - previousLastOutboundAt: a última enviada da conversa ANTES desta mensagem;
 * - outboundAt: hora desta mensagem, se for enviada (null para recebida ou para o vínculo pela fila);
 * - linkedNow: a conversa acabou de ser vinculada a este cliente.
 */
export function lastContactToRecord(input: {
  clientId: string | null;
  previousLastOutboundAt: Date | null;
  outboundAt: Date | null;
  linkedNow: boolean;
}): Date | null {
  if (!input.clientId) return null;
  const { previousLastOutboundAt: previous, outboundAt } = input;
  if (input.linkedNow) return outboundAt ? later(previous, outboundAt) : previous;
  if (!outboundAt) return null;
  if (previous && brazilDayKeyOf(outboundAt) <= brazilDayKeyOf(previous)) return null;
  return outboundAt;
}

type OpportunityDb = { opportunity: Pick<PrismaClient["opportunity"], "updateMany"> };

/** Leva o último contato das oportunidades abertas do cliente para `at`, só quando é mais recente. */
export async function advanceClientOpenOpportunitiesLastContact(db: OpportunityDb, clientId: string, at: Date): Promise<number> {
  if (!clientId || Number.isNaN(at.getTime())) return 0;
  const result = await db.opportunity.updateMany({
    where: {
      clientId,
      stage: { notIn: [OpportunityStage.ganho, OpportunityStage.perdido] },
      OR: [{ lastContactAt: null }, { lastContactAt: { lt: at } }]
    },
    data: { lastContactAt: at }
  });
  return result.count;
}
