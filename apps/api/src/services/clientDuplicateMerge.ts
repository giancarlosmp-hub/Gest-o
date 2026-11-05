import { EventType, type Prisma } from "@prisma/client";
import { normalizeAuditedCode } from "./clientCodeAuditService.js";
import { normalizeText } from "../utils/normalize.js";

// "Mesclar duplicado" (diretor/gerente): leva o histórico do cadastro duplicado para o cadastro que fica e arquiva o
// duplicado no mesmo formato da fusão da sincronização UltraFV3, o que libera o documento e o código para o ERP.
//
// Move: oportunidades (itens, pedidos ERP e histórico seguem a oportunidade), atividades, linha do tempo, contatos,
// agenda, paradas de roteiro e conversas.
// Não move: a auditoria de código (é o histórico do código daquele cadastro), os dados de ERP do duplicado (código,
// títulos, perfil financeiro, última compra: a sincronização recalcula no que fica), o dono do que fica e os autores,
// donos e datas dos registros movidos.

// Mesmo prefixo da fusão da sincronização: a busca de candidatos do sync ignora nomes com ele.
export const MERGED_DUPLICATE_NAME_PREFIX = "[ARQUIVADO ERP DUP]";
export const buildMergedDuplicateArchiveReason = (primaryClientId: string) => `MERGED_INTO:${primaryClientId}`;
export const buildMergedDuplicateCode = (code: string | null, mergedAt: Date) =>
  normalizeAuditedCode(code) ? `${String(code).trim()}__MERGED__${mergedAt.getTime()}` : null;

export class ClientMergeConflictError extends Error {
  readonly statusCode = 409;
}

type MergeClient = { id: string; code: string | null; name: string; cnpj: string | null; ownerSellerId: string };

export type ClientMergeMoved = {
  opportunities: number;
  activities: number;
  timelineEvents: number;
  contacts: number;
  agendaEvents: number;
  agendaStops: number;
  communicationConversations: number;
};

export async function mergeClientDuplicate(
  tx: Prisma.TransactionClient,
  params: {
    primary: MergeClient;
    duplicate: MergeClient;
    actor: { id: string; email?: string | null; name?: string | null };
    requestIp?: string | null;
    requestId: string;
    reason?: string | null;
    mergedAt: Date;
  },
): Promise<ClientMergeMoved> {
  const { primary, duplicate, actor, mergedAt } = params;
  const fromDuplicate = { clientId: duplicate.id };
  const toPrimary = { clientId: primary.id };

  // Arquiva primeiro, condicionado a ainda estar ativo: se outra mesclagem chegou antes, nada é movido.
  const mergedCode = buildMergedDuplicateCode(duplicate.code, mergedAt);
  const archivedName = `${MERGED_DUPLICATE_NAME_PREFIX} ${duplicate.name}`;
  const archived = await tx.client.updateMany({
    where: { id: duplicate.id, isArchived: false },
    data: {
      code: mergedCode,
      cnpjNormalized: null,
      cnpj: duplicate.cnpj ? `${duplicate.cnpj} [MERGED INTO ${primary.id}]` : null,
      name: archivedName,
      // Sem documento vale o índice único nome+cidade+UF: o id evita colisão entre duplicados de mesmo nome.
      nameNormalized: `${normalizeText(archivedName)} ${duplicate.id}`.slice(0, 255),
      isArchived: true,
      archiveReason: buildMergedDuplicateArchiveReason(primary.id),
    },
  });
  if (archived.count !== 1) throw new ClientMergeConflictError("O cadastro duplicado mudou ou já foi mesclado. Atualize a tela e tente de novo.");

  const primaryHasMainContact = (await tx.contact.count({ where: { ...toPrimary, isPrimary: true } })) > 0;
  const moved: ClientMergeMoved = {
    opportunities: (await tx.opportunity.updateMany({ where: fromDuplicate, data: toPrimary })).count,
    activities: (await tx.activity.updateMany({ where: fromDuplicate, data: toPrimary })).count,
    timelineEvents: (await tx.timelineEvent.updateMany({ where: fromDuplicate, data: toPrimary })).count,
    // O contato principal do cadastro que fica continua sendo o principal.
    contacts: (await tx.contact.updateMany({ where: fromDuplicate, data: primaryHasMainContact ? { ...toPrimary, isPrimary: false } : toPrimary })).count,
    agendaEvents: (await tx.agendaEvent.updateMany({ where: fromDuplicate, data: toPrimary })).count,
    agendaStops: (await tx.agendaStop.updateMany({ where: fromDuplicate, data: toPrimary })).count,
    communicationConversations: (await tx.communicationConversation.updateMany({ where: fromDuplicate, data: toPrimary })).count,
  };

  const reason = params.reason?.trim();
  await tx.timelineEvent.create({
    data: {
      type: EventType.status,
      clientId: primary.id,
      ownerSellerId: primary.ownerSellerId,
      description:
        `Cadastro duplicado ${duplicate.name} (código ${normalizeAuditedCode(duplicate.code) ?? "sem código"}) mesclado neste cliente` +
        ` por ${actor.name || actor.email || "usuário"}.` +
        " Oportunidades, linha do tempo, atividades, contatos, agenda e conversas foram trazidos; o duplicado foi arquivado." +
        (reason ? ` Motivo: ${reason}` : ""),
    },
  });

  // A auditoria de código fica no duplicado e registra a mesclagem (mesmo sem código).
  await tx.clientCodeAudit.create({
    data: {
      clientId: duplicate.id,
      oldValue: normalizeAuditedCode(duplicate.code),
      newValue: mergedCode,
      origin: "Interface Administrativa",
      actorUserId: actor.id,
      actorEmail: actor.email ?? null,
      requestIp: params.requestIp ?? null,
      requestId: params.requestId,
      metadata: { operation: "manual_duplicate_merge", primaryClientId: primary.id, ...(reason ? { reason } : {}) },
    },
  });

  return moved;
}
