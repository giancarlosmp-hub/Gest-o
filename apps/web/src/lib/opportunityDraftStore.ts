import { isDraftExpired, type OpportunityDraftCard } from "./opportunityDraft";

// Rascunhos de oportunidade por frase ("Para confirmar"), guardados só no aparelho e por usuário. Toda leitura e
// gravação passa por try/catch: com o armazenamento bloqueado, a tela funciona sem guardar. Rascunho com mais de
// 7 dias não some em silêncio: continua na lista marcado como vencido, até o vendedor descartar ou refazer. Não é
// apagado no logout (a chave já é por usuário).

export const OPPORTUNITY_DRAFTS_MAX = 20;

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type StoreOptions = { storage?: DraftStorage | null; now?: Date };
export type StoredOpportunityDraft = { card: OpportunityDraftCard; expired: boolean };

const keyFor = (userId: string) => `gest-o:opportunity-drafts:${userId}`;

const defaultStorage = (): DraftStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const resolveStorage = (options: StoreOptions) => (options.storage === undefined ? defaultStorage() : options.storage);

const isCard = (value: unknown): value is OpportunityDraftCard => {
  const card = value as OpportunityDraftCard | null;
  return Boolean(card && card.version === 1 && typeof card.id === "string" && typeof card.interpretedAt === "string" && Array.isArray(card.items) && card.client);
};

const readCards = (userId: string, options: StoreOptions): OpportunityDraftCard[] => {
  try {
    const raw = resolveStorage(options)?.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: number; drafts?: unknown[] };
    return parsed?.version === 1 && Array.isArray(parsed.drafts) ? parsed.drafts.filter(isCard) : [];
  } catch {
    return [];
  }
};

const writeCards = (userId: string, cards: OpportunityDraftCard[], options: StoreOptions) => {
  try {
    const storage = resolveStorage(options);
    if (!storage) return false;
    if (cards.length) storage.setItem(keyFor(userId), JSON.stringify({ version: 1, drafts: cards }));
    else storage.removeItem(keyFor(userId));
    return true;
  } catch {
    return false;
  }
};

// Mais recentes primeiro, com a marca de vencido.
export const listOpportunityDrafts = (userId: string | null | undefined, options: StoreOptions = {}): StoredOpportunityDraft[] => {
  if (!userId) return [];
  const now = options.now ?? new Date();
  return readCards(userId, options)
    .sort((left, right) => right.interpretedAt.localeCompare(left.interpretedAt))
    .map((card) => ({ card, expired: !card.createdOpportunityId && isDraftExpired(card, now) }));
};

// Grava ou substitui pelo id. false = não guardou (sem usuário ou armazenamento bloqueado/cheio).
export const saveOpportunityDraft = (userId: string | null | undefined, card: OpportunityDraftCard, options: StoreOptions = {}) => {
  if (!userId) return false;
  const others = readCards(userId, options).filter((item) => item.id !== card.id);
  const cards = [card, ...others].sort((left, right) => right.interpretedAt.localeCompare(left.interpretedAt)).slice(0, OPPORTUNITY_DRAFTS_MAX);
  return writeCards(userId, cards, options);
};

export const removeOpportunityDraft = (userId: string | null | undefined, draftId: string, options: StoreOptions = {}) => {
  if (!userId) return false;
  return writeCards(userId, readCards(userId, options).filter((item) => item.id !== draftId), options);
};
