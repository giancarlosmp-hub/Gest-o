// Visita em andamento: rascunho da Nova atividade de visita guardado no aparelho, para o vendedor fazer o check-in
// na chegada e escrever o resumo no fim, mesmo que o app feche no meio. Fica só no navegador de quem preenche.
// Toda leitura e gravação passa por try/catch: com o armazenamento bloqueado, o formulário funciona sem rascunho.

export const VISIT_DRAFT_TTL_MS = 12 * 3_600_000;
export const VISIT_DRAFT_CHANGE_EVENT = "visit-draft-change";

export type VisitDraftCheckIn = {
  checkInAt: string;
  checkInLat: number;
  checkInLng: number;
  checkInAccuracy?: number | null;
};

export type VisitDraft = {
  version: 1;
  startedAt: string;
  type: string;
  dueDate: string;
  // Horário (Brasília) da visita; rascunhos antigos não têm e usam o horário atual.
  time?: string;
  clientId: string;
  opportunityId: string;
  agendaEventId: string;
  ownerSellerId: string;
  city: string;
  notes: string;
  observations: string;
  result: string;
  checkIn: VisitDraftCheckIn | null;
};

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type DraftOptions = { storage?: DraftStorage | null; now?: Date };

const keyFor = (userId: string) => `gest-o:visit-draft:${userId}`;

const defaultStorage = (): DraftStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const resolveStorage = (options: DraftOptions) => (options.storage === undefined ? defaultStorage() : options.storage);

const notifyChange = () => {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(VISIT_DRAFT_CHANGE_EVENT));
  } catch {
    // Sem window ou sem eventos: nada a avisar.
  }
};

export const clearVisitDraft = (userId: string | null | undefined, options: DraftOptions = {}) => {
  if (!userId) return;
  try {
    resolveStorage(options)?.removeItem(keyFor(userId));
  } catch {
    // Armazenamento bloqueado: não há rascunho para apagar.
  }
  notifyChange();
};

// Rascunho ativo do usuário, ou null (ausente, inválido, de outro formato ou com mais de 12 horas, que é apagado).
export const loadVisitDraft = (userId: string | null | undefined, options: DraftOptions = {}): VisitDraft | null => {
  if (!userId) return null;
  let raw: string | null = null;
  try {
    raw = resolveStorage(options)?.getItem(keyFor(userId)) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as VisitDraft;
    const startedAt = Date.parse(draft?.startedAt);
    const now = (options.now ?? new Date()).getTime();
    if (draft?.version !== 1 || !Number.isFinite(startedAt) || now - startedAt >= VISIT_DRAFT_TTL_MS) {
      clearVisitDraft(userId, options);
      return null;
    }
    return draft;
  } catch {
    clearVisitDraft(userId, options);
    return null;
  }
};

// Grava o rascunho. Mantém o início da visita: o horário do check-in ou, sem ele, o do primeiro rascunho.
export const saveVisitDraft = (
  userId: string | null | undefined,
  draft: Omit<VisitDraft, "version" | "startedAt">,
  options: DraftOptions = {}
): VisitDraft | null => {
  if (!userId) return null;
  const previous = loadVisitDraft(userId, options);
  const startedAt = draft.checkIn?.checkInAt || previous?.startedAt || (options.now ?? new Date()).toISOString();
  const value: VisitDraft = { ...draft, version: 1, startedAt };
  try {
    const storage = resolveStorage(options);
    if (!storage) return null;
    storage.setItem(keyFor(userId), JSON.stringify(value));
  } catch {
    return null;
  }
  notifyChange();
  return value;
};

// A visita só vira rascunho depois do check-in ou de algo preenchido além do tipo e da data. O que já veio
// preenchido (o "Concluir" da Agenda traz cliente e notas) não conta: só o que o vendedor capturou ou mudou.
export const hasVisitDraftContent = (
  draft: Pick<VisitDraft, "checkIn" | "clientId" | "notes" | "observations" | "result">,
  prefilled: Partial<Pick<VisitDraft, "clientId" | "notes">> = {}
) =>
  Boolean(
    draft.checkIn ||
      (draft.clientId && draft.clientId !== (prefilled.clientId || "")) ||
      (draft.notes.trim() && draft.notes.trim() !== (prefilled.notes || "").trim()) ||
      draft.observations.trim() ||
      draft.result.trim()
  );

// HH:MM em Brasília, para o aviso "Visita em andamento desde HH:MM".
export const formatVisitDraftStart = (draft: Pick<VisitDraft, "startedAt">) =>
  new Date(draft.startedAt).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

export const VISIT_DRAFT_RESUME_PARAM = "visitaEmAndamento";
