import { Prisma } from "@prisma/client";

// Exclusão de cliente: só sai o cadastro sem nenhum vínculo. Com histórico, o caminho é "Mesclar duplicado",
// que leva o histórico para o cadastro que fica. Nada é apagado em cascata.

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

const LINK_LABELS: Array<[keyof ClientDeleteLinkCounts, string]> = [
  ["opportunities", "oportunidades"],
  ["timelineEvents", "linha do tempo"],
  ["activities", "atividades"],
  ["agendaEvents", "agenda"],
  ["agendaStops", "paradas de roteiro"],
  ["contacts", "contatos"],
  ["communicationConversations", "conversas"],
];

export const getClientDeleteBlockingReasons = (client: { code: string | null; _count: ClientDeleteLinkCounts }) => {
  const reasons: string[] = [];
  if ((client.code && client.code.trim()) || client._count.codeAuditEvents > 0) reasons.push("código ERP");
  for (const [key, label] of LINK_LABELS) if (client._count[key] > 0) reasons.push(label);
  return reasons;
};

export const buildClientDeleteBlockedMessage = (reasons: string[]) =>
  `Não é possível excluir este cliente porque há histórico em: ${reasons.join(", ")}. ` +
  'Use "Mesclar duplicado" para levar o histórico ao cadastro que fica.';

export const CLIENT_DELETE_LINKED_FALLBACK_MESSAGE =
  'Não é possível excluir este cliente porque há registros vinculados a ele. Use "Mesclar duplicado" para levar o histórico ao cadastro que fica.';
