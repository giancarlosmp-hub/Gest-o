import { isProposalWithoutResponse, proposalDaysWithoutContact } from "@salesforce-pro/shared";
import { brazilDayKeyOf, brazilTodayKey } from "./brazilDate";

// "Minha lista de hoje" do vendedor: uma lista só, sem repetir a mesma oportunidade, juntando as prioridades
// do dia, as oportunidades críticas e os follow-ups vencidos e de hoje. Cada item leva um motivo.

export type SellerDayTag = "followup_overdue" | "followup_today" | "proposal_no_response" | "opportunity_overdue" | "cooling" | "priority";

// Ordem da lista e precedência do motivo quando a oportunidade cai em mais de um.
const TAG_ORDER: SellerDayTag[] = ["followup_overdue", "followup_today", "proposal_no_response", "opportunity_overdue", "cooling", "priority"];

export const SELLER_DAY_TAG_LABEL: Record<SellerDayTag, string> = {
  followup_overdue: "Follow-up vencido",
  followup_today: "Follow-up hoje",
  proposal_no_response: "Proposta sem retorno",
  opportunity_overdue: "Oportunidade atrasada",
  cooling: "Esfriando",
  priority: "Prioridade"
};

export type SellerDayPriority = {
  opportunityId: string;
  clientId?: string | null;
  clientName: string;
  title?: string;
  priorityReasons?: string[];
};

export type SellerDayOpportunity = {
  id: string;
  title: string;
  stage: string;
  followUpDate?: string | null;
  expectedCloseDate?: string | null;
  lastContactAt?: string | null;
  client?: { id: string; name: string } | string;
  clientInCollection?: boolean;
};

export type SellerDayItem = {
  key: string;
  opportunityId?: string;
  clientId?: string;
  clientName: string;
  title?: string;
  tag: SellerDayTag;
  daysLate: number;
};

// Quantas prioridades do dia entram na lista (as mesmas 5 do antigo bloco "Prioridades do dia").
export const SELLER_DAY_PRIORITIES_LIMIT = 5;
const DAY_MS = 86_400_000;

// Chave de duplicata: a oportunidade; sem ela, o cliente.
export const sellerDayItemKey = (item: { opportunityId?: string | null; clientId?: string | null }) =>
  item.opportunityId ? `opportunity:${item.opportunityId}` : item.clientId ? `client:${item.clientId}` : null;

const daysSince = (value: string | null | undefined, todayKey: string) => {
  if (!value || Number.isNaN(new Date(value).getTime())) return null;
  return Math.round((Date.parse(`${todayKey}T12:00:00Z`) - Date.parse(`${brazilDayKeyOf(value)}T12:00:00Z`)) / DAY_MS);
};

// Mesma regra do antigo bloco "Oportunidades críticas", em dias de Brasília. "Proposta sem retorno" é a regra
// de packages/shared, a mesma da contagem do alerta e do filtro; o follow-up e o atraso têm precedência na etiqueta.
const criticalTagOf = (opportunity: SellerDayOpportunity, todayKey: string, now: Date): { tag: SellerDayTag; daysLate: number } | null => {
  const followUpDays = daysSince(opportunity.followUpDate, todayKey);
  if (followUpDays !== null && followUpDays >= 0) {
    return { tag: followUpDays > 0 ? "followup_overdue" : "followup_today", daysLate: followUpDays };
  }
  const closeDays = daysSince(opportunity.expectedCloseDate, todayKey);
  if (closeDays !== null && closeDays > 0) return { tag: "opportunity_overdue", daysLate: closeDays };
  if (isProposalWithoutResponse(opportunity, now)) {
    return { tag: "proposal_no_response", daysLate: proposalDaysWithoutContact(opportunity, now)! };
  }
  return null;
};

const clientOf = (opportunity: SellerDayOpportunity) =>
  typeof opportunity.client === "string"
    ? { clientId: undefined, clientName: opportunity.client }
    : { clientId: opportunity.client?.id, clientName: opportunity.client?.name || "Cliente não informado" };

export const buildSellerDayList = (input: {
  priorities: SellerDayPriority[];
  opportunities: SellerDayOpportunity[];
  // Chave do item de "Comece por aqui", que não se repete na lista.
  excludeKey?: string | null;
  now?: Date;
}): SellerDayItem[] => {
  const now = input.now ?? new Date();
  const todayKey = brazilTodayKey(now);
  const rankByKey = new Map<string, number>();
  input.priorities.forEach((priority, index) => {
    const key = sellerDayItemKey(priority);
    if (key && !rankByKey.has(key)) rankByKey.set(key, index);
  });

  const items = new Map<string, SellerDayItem>();
  const add = (item: SellerDayItem) => {
    if (item.key === input.excludeKey) return;
    const current = items.get(item.key);
    if (!current || TAG_ORDER.indexOf(item.tag) < TAG_ORDER.indexOf(current.tag)) items.set(item.key, current ? { ...current, tag: item.tag, daysLate: item.daysLate } : item);
  };

  for (const priority of input.priorities.slice(0, SELLER_DAY_PRIORITIES_LIMIT)) {
    const key = sellerDayItemKey(priority);
    if (!key) continue;
    const cooling = priority.priorityReasons?.some((reason) => reason.startsWith("Esfriando")) ?? false;
    add({
      key,
      opportunityId: priority.opportunityId,
      clientId: priority.clientId ?? undefined,
      clientName: priority.clientName,
      title: priority.title,
      tag: cooling ? "cooling" : "priority",
      daysLate: 0
    });
  }

  // Cliente em cobrança fica fora: aparece só na contagem de "Alertas da carteira".
  for (const opportunity of input.opportunities) {
    if (opportunity.clientInCollection) continue;
    const critical = criticalTagOf(opportunity, todayKey, now);
    if (!critical) continue;
    const client = clientOf(opportunity);
    add({ key: `opportunity:${opportunity.id}`, opportunityId: opportunity.id, ...client, title: opportunity.title, ...critical });
  }

  // Motivo mais urgente primeiro; no mesmo motivo, a ordem das prioridades do dia, depois o maior atraso.
  return [...items.values()].sort((a, b) => {
    const byTag = TAG_ORDER.indexOf(a.tag) - TAG_ORDER.indexOf(b.tag);
    if (byTag !== 0) return byTag;
    const byRank = (rankByKey.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rankByKey.get(b.key) ?? Number.MAX_SAFE_INTEGER);
    if (byRank !== 0) return byRank;
    return b.daysLate - a.daysLate;
  });
};
