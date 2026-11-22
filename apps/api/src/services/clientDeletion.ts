import { Prisma } from "@prisma/client";

// Exclusão de cliente: só sai o cadastro sem nenhum vínculo. Com vínculo, o caminho é "Arquivar" (tira da lista sem
// apagar nada) ou, se for cadastro repetido, "Mesclar duplicado". Nada é apagado em cascata.

export const CLIENT_DELETE_LINK_COUNT_SELECT = {
  codeAuditEvents: true,
  opportunities: true,
  timelineEvents: true,
  activities: true,
  agendaEvents: true,
  agendaStops: true,
  contacts: true,
  communicationConversations: true,
} satisfies Prisma.ClientCountOutputTypeSelect;

export type ClientDeleteLinkCounts = Record<keyof typeof CLIENT_DELETE_LINK_COUNT_SELECT, number>;

// Auditoria que registrou um código ERP (antigo ou novo). Auditoria sem código (ex.: preenchimento de tenant pelo
// backfillClientTenant) não é "código ERP", mas também bloqueia: a relação é onDelete: Restrict e não se apaga auditoria.
export const CLIENT_DELETE_SELECT = {
  id: true,
  code: true,
  ownerSellerId: true,
  codeAuditEvents: { where: { OR: [{ oldValue: { not: null } }, { newValue: { not: null } }] }, select: { id: true }, take: 1 },
  _count: { select: CLIENT_DELETE_LINK_COUNT_SELECT },
} satisfies Prisma.ClientSelect;

const LINK_LABELS: Array<[keyof ClientDeleteLinkCounts, string]> = [
  ["opportunities", "oportunidades"],
  ["timelineEvents", "linha do tempo"],
  ["activities", "atividades"],
  ["agendaEvents", "agenda"],
  ["agendaStops", "paradas de roteiro"],
  ["contacts", "contatos"],
  ["communicationConversations", "conversas"],
];

export const getClientDeleteBlockingReasons = (client: {
  code: string | null;
  codeAuditEvents: Array<unknown>;
  _count: ClientDeleteLinkCounts;
}) => {
  const reasons: string[] = [];
  if ((client.code && client.code.trim()) || client.codeAuditEvents.length > 0) reasons.push("código ERP");
  else if (client._count.codeAuditEvents > 0) reasons.push("auditoria do cadastro");
  for (const [key, label] of LINK_LABELS) if (client._count[key] > 0) reasons.push(label);
  return reasons;
};

const CLIENT_DELETE_ALTERNATIVES =
  'Para tirar da lista, use "Arquivar" (gerente ou diretor). Se for cadastro repetido, use "Mesclar duplicado".';

export const buildClientDeleteBlockedMessage = (reasons: string[]) =>
  `Não é possível excluir este cliente porque há histórico em: ${reasons.join(", ")}. ${CLIENT_DELETE_ALTERNATIVES}`;

export const CLIENT_DELETE_LINKED_FALLBACK_MESSAGE =
  `Não é possível excluir este cliente porque há registros vinculados a ele. ${CLIENT_DELETE_ALTERNATIVES}`;
