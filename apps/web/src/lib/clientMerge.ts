import { brazilDayKeyOf } from "./brazilDate";

// "Mesclar duplicado" na tela do cliente (diretor/gerente). Resposta de GET /clients/:id/merge-candidates.
export type MergeCandidateCounts = {
  opportunities: number;
  timelineEvents: number;
  activities: number;
  contacts: number;
  agendaEvents: number;
  agendaStops: number;
  communicationConversations: number;
};

export type MergeClientSummary = {
  id: string;
  code: string | null;
  name: string;
  fantasyName?: string | null;
  document: string | null;
  city: string | null;
  state: string | null;
  lastPurchaseDate: string | null;
  createdAt?: string | null;
  ownerSellerName?: string | null;
  counts: MergeCandidateCounts;
  matchReasons?: string[];
};

export const MERGE_KEEP_WARNING = "Fica o cadastro cujo código continua no ERP.";

const dash = "—";
export const formatMergeDate = (value?: string | null) => {
  if (!value) return dash;
  const [year, month, day] = brazilDayKeyOf(value).split("-");
  return `${day}/${month}/${year}`;
};

export const mergeComparisonRows = (client: MergeClientSummary): Array<[string, string]> => [
  ["Código", client.code?.trim() || "sem código"],
  ["Documento", client.document?.trim() || dash],
  ["Cidade/UF", [client.city, client.state].filter(Boolean).join("/") || dash],
  ["Última compra", formatMergeDate(client.lastPurchaseDate)],
  ["Vendedor", client.ownerSellerName || dash],
  ["Cadastrado em", formatMergeDate(client.createdAt)],
  ["Oportunidades", String(client.counts.opportunities)],
  ["Linha do tempo", String(client.counts.timelineEvents)],
  ["Atividades", String(client.counts.activities)],
  ["Contatos", String(client.counts.contacts)],
  ["Agenda", String(client.counts.agendaEvents + client.counts.agendaStops)],
  ["Conversas", String(client.counts.communicationConversations)],
];

const MATCH_LABELS: Record<string, string> = {
  documento: "Mesmo documento",
  "nome e cidade": "Mesmo nome e cidade/UF",
  busca: "Encontrado na busca",
};
export const mergeMatchLabel = (reasons?: string[]) => (reasons || []).map((reason) => MATCH_LABELS[reason] || reason).join(" · ");

/** O cadastro escolhido fica; o outro é o duplicado (arquivado depois de trazer o histórico). */
export const buildMergePayload = (currentId: string, candidateId: string, keepId: string, reason?: string) => {
  if (keepId !== currentId && keepId !== candidateId) throw new Error("Escolha qual cadastro fica.");
  const duplicateId = keepId === currentId ? candidateId : currentId;
  const trimmed = reason?.trim();
  return { primaryClientId: keepId, duplicateClientIds: [duplicateId], ...(trimmed ? { reason: trimmed } : {}) };
};

export const mergeConfirmMessage = (keep: MergeClientSummary, duplicate: MergeClientSummary) =>
  `Mesclar "${duplicate.name}" (código ${duplicate.code?.trim() || "sem código"}) em "${keep.name}" (código ${keep.code?.trim() || "sem código"})?\n\n` +
  "Oportunidades, linha do tempo, atividades, contatos, agenda e conversas vão para o cadastro que fica. " +
  "O duplicado é arquivado e não pode ser reativado.";
